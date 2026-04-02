/**
 * RoadNetwork — single mutation point for ways, graph, and grid.
 *
 * Canonical source of truth:
 *  - shared RoadNode instances
 *  - ordered RoadWay instances
 *
 * Derived on every mutation:
 *  - PlanarGraph topology
 *  - roadGrid occupancy
 *  - bridgeGrid occupancy
 */

import { RoadNode } from './RoadNode.js';
import { RoadWay, _ensureRoadWayIdAtLeast } from './RoadWay.js';
import { PlanarGraph } from './PlanarGraph.js';
import { Grid2D } from './Grid2D.js';

export class RoadNetwork {
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} cellSize
   * @param {number} [originX=0]
   * @param {number} [originZ=0]
   */
  constructor(width, height, cellSize, originX = 0, originZ = 0) {
    this._width = width;
    this._height = height;
    this._cellSize = cellSize;
    this._originX = originX;
    this._originZ = originZ;

    /** @type {Map<number, RoadNode>} */
    this._nodes = new Map();

    /** @type {Map<number, RoadWay>} */
    this._ways = new Map();

    /** @type {PlanarGraph} */
    this._graph = new PlanarGraph();

    const gridOpts = { type: 'uint8', cellSize, originX, originZ };
    this._roadGrid = new Grid2D(width, height, gridOpts);
    this._bridgeGrid = new Grid2D(width, height, { ...gridOpts });

    this._mutationDepth = 0;
    this._derivedDirty = false;
  }

  /** @returns {RoadWay[]} */
  get ways() {
    return [...this._ways.values()];
  }

  /** @returns {RoadNode[]} */
  get nodes() {
    return [...this._nodes.values()];
  }

  /** @returns {number} */
  get wayCount() {
    return this._ways.size;
  }

  /** @returns {PlanarGraph} */
  get graph() {
    return this._graph;
  }

  /** @returns {Grid2D} */
  get roadGrid() {
    return this._roadGrid;
  }

  /** @returns {Grid2D} */
  get bridgeGrid() {
    return this._bridgeGrid;
  }

  /**
   * @param {number} id
   * @returns {RoadWay | undefined}
   */
  getWay(id) {
    return this._ways.get(id);
  }

  toJSON() {
    return {
      nodes: this.nodes.map(node => node.toJSON()),
      ways: this.ways.map(way => ({
        id: way.id,
        nodeIds: way.nodes.map(node => node.id),
        width: way.width,
        hierarchy: way.hierarchy,
        importance: way.importance,
        source: way.source,
        bridges: way.bridges,
      })),
    };
  }

  /**
   * @param {object} snapshot
   * @param {number} width
   * @param {number} height
   * @param {number} cellSize
   * @param {number} [originX=0]
   * @param {number} [originZ=0]
   * @returns {RoadNetwork}
   */
  static fromJSON(snapshot, width, height, cellSize, originX = 0, originZ = 0) {
    const net = new RoadNetwork(width, height, cellSize, originX, originZ);
    const nodesById = new Map();

    for (const nodeData of snapshot?.nodes || []) {
      const node = RoadNode.fromJSON(nodeData);
      net._nodes.set(node.id, node);
      nodesById.set(node.id, node);
    }

    for (const wayData of snapshot?.ways || []) {
      const nodes = (wayData.nodeIds || []).map(id => nodesById.get(id)).filter(Boolean);
      const way = new RoadWay(nodes, {
        width: wayData.width,
        hierarchy: wayData.hierarchy,
        importance: wayData.importance,
        source: wayData.source,
      });
      way.id = wayData.id;
      _ensureRoadWayIdAtLeast(way.id);
      for (const bridge of wayData.bridges || []) {
        way.addBridge(bridge.bankA, bridge.bankB, bridge.entryT, bridge.exitT);
      }
      net._ways.set(way.id, way);
    }

    net.#pruneDegenerateWays();
    net.#pruneOrphanNodes();
    net.rebuildDerived();
    return net;
  }

  /**
   * @param {Array<{x: number, z: number}>} polyline
   * @param {object} [attrs]
   * @param {number} [attrs.width=6]
   * @param {string} [attrs.hierarchy='local']
   * @param {number} [attrs.importance=0.45]
   * @param {*}      [attrs.source]
   * @returns {RoadWay}
   */
  add(polyline, attrs = {}) {
    const nodes = this.#buildWayNodesFromPolyline(polyline);
    const way = new RoadWay(nodes, attrs);
    this._ways.set(way.id, way);
    this.#pruneDegenerateWays();
    this.#scheduleDerivedRefresh();
    return way;
  }

  /**
   * @param {Array<{gx: number, gz: number}>} cells
   * @param {object} [attrs]
   * @returns {RoadWay | null}
   */
  addFromCells(cells, attrs = {}) {
    if (!cells || cells.length < 2) return null;
    const polyline = cells.map(({ gx, gz }) => ({
      x: this._originX + gx * this._cellSize,
      z: this._originZ + gz * this._cellSize,
    }));
    return this.add(polyline, attrs);
  }

  /**
   * @param {number} id
   */
  remove(id) {
    if (!this._ways.has(id)) return;
    this._ways.delete(id);
    this.#pruneOrphanNodes();
    this.#scheduleDerivedRefresh();
  }

  /**
   * @param {number} wayId
   * @param {{x: number, z: number}} bankA
   * @param {{x: number, z: number}} bankB
   * @param {number} entryT
   * @param {number} exitT
   */
  addBridge(wayId, bankA, bankB, entryT, exitT) {
    const way = this._ways.get(wayId);
    if (!way) return;
    way.addBridge(bankA, bankB, entryT, exitT);
    this.#scheduleDerivedRefresh();
  }

  /**
   * @param {number} wayId
   * @param {Array<{x: number, z: number}>} newPolyline
   */
  replaceWayPolyline(wayId, newPolyline) {
    const way = this._ways.get(wayId);
    if (!way) return;
    const newNodes = this.#buildWayNodesFromPolyline(newPolyline, wayId);
    way.replaceNodes(newNodes);
    this.#pruneDegenerateWays();
    this.#pruneOrphanNodes();
    this.#scheduleDerivedRefresh();
  }

  /**
   * Ensure there is a real shared-node-model node on a way at (x, z).
   *
   * @param {number} wayId
   * @param {number} x
   * @param {number} z
   * @param {object} [opts]
   * @param {number} [opts.snapDist=this._cellSize*3]
   * @param {object} [opts.nodeAttrs={}]
   * @returns {number|null}
   */
  ensureNodeOnWay(wayId, x, z, opts = {}) {
    const way = this._ways.get(wayId);
    if (!way || way.nodes.length < 2) return null;

    const {
      snapDist = this._cellSize * 3,
      nodeAttrs = {},
    } = opts;

    let bestExisting = null;
    for (const node of way.nodes) {
      const dist = Math.hypot(node.x - x, node.z - z);
      if (dist <= snapDist && (!bestExisting || dist < bestExisting.dist)) {
        bestExisting = { node, dist };
      }
    }
    if (bestExisting) {
      return bestExisting.node.id;
    }

    let best = null;
    for (let i = 0; i < way.nodes.length - 1; i++) {
      const a = way.nodes[i];
      const b = way.nodes[i + 1];
      const proj = projectPointOntoSegment(x, z, a, b);
      if (!best || proj.distSq < best.distSq) {
        best = {
          index: i,
          x: proj.x,
          z: proj.z,
          distSq: proj.distSq,
          t: proj.t,
        };
      }
    }
    if (!best) return null;

    if (best.t <= 1e-4) return way.nodes[best.index].id;
    if (best.t >= 1 - 1e-4) return way.nodes[best.index + 1].id;

    const newNode = this.#createNode(best.x, best.z, nodeAttrs);
    const nextNodes = [...way.nodes];
    nextNodes.splice(best.index + 1, 0, newNode);
    way.replaceNodes(this.#dedupeAdjacentNodes(nextNodes));
    this.#scheduleDerivedRefresh();
    return newNode.id;
  }

  /**
   * Split both ways if needed and merge them onto a single shared node.
   *
   * @param {number} wayIdA
   * @param {number} wayIdB
   * @param {number} x
   * @param {number} z
   * @param {object} [opts]
   * @param {number} [opts.snapDist=this._cellSize*3]
   * @param {object} [opts.nodeAttrs={}]
   * @returns {number|null}
   */
  connectWaysAtPoint(wayIdA, wayIdB, x, z, opts = {}) {
    return this.mutate(() => {
      const {
        snapDist = this._cellSize * 3,
        nodeAttrs = {},
      } = opts;

      const nodeA = this.ensureNodeOnWay(wayIdA, x, z, { snapDist, nodeAttrs });
      const nodeB = this.ensureNodeOnWay(wayIdB, x, z, { snapDist, nodeAttrs });

      if (nodeA === null) return nodeB;
      if (nodeB === null) return nodeA;
      if (nodeA === nodeB) return nodeA;

      this.#mergeNodeRefs(nodeA, nodeB);
      this.#scheduleDerivedRefresh();
      return nodeA;
    });
  }

  /**
   * Merge one existing node into another shared node.
   * The kept node retains its position; all way references to dropId
   * are rewritten to keepId.
   *
   * @param {number} keepId
   * @param {number} dropId
   * @returns {number|null}
   */
  mergeNodes(keepId, dropId) {
    if (keepId === dropId) return keepId;
    if (!this._nodes.has(keepId) || !this._nodes.has(dropId)) return null;
    this.#mergeNodeRefs(keepId, dropId);
    this.#scheduleDerivedRefresh();
    return keepId;
  }

  /**
   * Defer derived graph/grid rebuilds until a group of mutations completes.
   *
   * @template T
   * @param {() => T} mutator
   * @returns {T}
   */
  mutate(mutator) {
    this._mutationDepth++;
    try {
      return mutator();
    } finally {
      this._mutationDepth--;
      if (this._mutationDepth === 0 && this._derivedDirty) {
        this.rebuildDerived();
      }
    }
  }

  /**
   * Run a tentative mutation that may fully roll back before exit.
   *
   * This is for validation flows like tryAddRoad(): we want shared-node
   * snapping and canonical way geometry, but if the tentative change is
   * rejected and removed before leaving the scope, we should not pay to
   * rebuild the derived graph/grid for a net-no-op mutation.
   *
   * @template T
   * @param {(ctx: { discardDerivedRefresh: () => void }) => T} mutator
   * @returns {T}
   */
  tentative(mutator) {
    const dirtyBefore = this._derivedDirty;
    let discardDerivedRefresh = false;
    this._mutationDepth++;
    try {
      return mutator({
        discardDerivedRefresh: () => {
          discardDerivedRefresh = true;
        },
      });
    } finally {
      this._mutationDepth--;
      if (discardDerivedRefresh && !dirtyBefore) {
        this._derivedDirty = false;
      }
      if (this._mutationDepth === 0 && this._derivedDirty) {
        this.rebuildDerived();
      }
    }
  }

  rebuildDerived() {
    this._derivedDirty = false;
    this._graph = new PlanarGraph();
    this._roadGrid.fill(0);
    this._bridgeGrid.fill(0);

    for (const node of this._nodes.values()) {
      this._graph.nodes.set(node.id, { id: node.id, x: node.x, z: node.z, attrs: { ...node.attrs } });
      this._graph._adjacency.set(node.id, []);
      if (node.id >= this._graph._nextNodeId) {
        this._graph._nextNodeId = node.id + 1;
      }
    }

    for (const way of this._ways.values()) {
      this.#stampWay(way);
      for (const bridge of way.bridges) {
        this.#stampBridge(bridge.bankA, bridge.bankB);
      }
      for (let i = 0; i < way.nodes.length - 1; i++) {
        const from = way.nodes[i];
        const to = way.nodes[i + 1];
        if (!from || !to || from.id === to.id) continue;
        this._graph.addEdge(from.id, to.id, {
          points: [],
          width: way.width,
          hierarchy: way.hierarchy,
          wayId: way.id,
          source: way.source,
        });
      }
    }
  }

  #buildWayNodesFromPolyline(polyline, replacingWayId = null) {
    const pts = (polyline || []).map(p => ({ x: p.x, z: p.z }));
    if (pts.length < 2) return [];

    const nextNodes = [];
    const snapDist = this._cellSize * 3;
    const replacementNodeIds = replacingWayId !== null
      ? new Set((this._ways.get(replacingWayId)?.nodes || []).map(node => node.id))
      : null;

    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      let node;
      const isEndpoint = i === 0 || i === pts.length - 1;
      if (isEndpoint) {
        node = this.#findNearbyNode(pt.x, pt.z, snapDist, replacementNodeIds);
      }
      if (!node) {
        node = this.#createNode(pt.x, pt.z);
      }
      nextNodes.push(node);
    }

    const deduped = this.#dedupeAdjacentNodes(nextNodes);
    if (deduped.length < 2) {
      const start = pts[0];
      const end = pts[pts.length - 1];
      const inputLen = Math.hypot(end.x - start.x, end.z - start.z);
      if (inputLen > 1e-6) {
        deduped.push(this.#createNode(end.x, end.z));
      }
    }
    if (deduped.length >= 2 && deduped[0].id === deduped[deduped.length - 1].id) {
      deduped[deduped.length - 1] = this.#createNode(pts[pts.length - 1].x, pts[pts.length - 1].z);
    }
    return this.#dedupeAdjacentNodes(deduped);
  }

  #createNode(x, z, attrs = {}) {
    const node = new RoadNode(x, z, attrs);
    this._nodes.set(node.id, node);
    return node;
  }

  #findNearbyNode(x, z, snapDist, excludedIds = null) {
    let best = null;
    for (const node of this._nodes.values()) {
      if (excludedIds && excludedIds.has(node.id)) continue;
      const dist = Math.hypot(node.x - x, node.z - z);
      if (dist <= snapDist && (!best || dist < best.dist)) {
        best = { node, dist };
      }
    }
    return best?.node ?? null;
  }

  #mergeNodeRefs(keepId, dropId) {
    const keep = this._nodes.get(keepId);
    const drop = this._nodes.get(dropId);
    if (!keep || !drop) return;

    for (const way of this._ways.values()) {
      const merged = way.nodes.map(node => (node.id === dropId ? keep : node));
      way.replaceNodes(this.#dedupeAdjacentNodes(merged));
    }

    this._nodes.delete(dropId);
    this.#pruneDegenerateWays();
    this.#pruneOrphanNodes();
  }

  #dedupeAdjacentNodes(nodes) {
    const deduped = [];
    for (const node of nodes) {
      if (!node) continue;
      const prev = deduped[deduped.length - 1];
      if (!prev || prev.id !== node.id) {
        deduped.push(node);
      }
    }
    return deduped;
  }

  #pruneDegenerateWays() {
    for (const [wayId, way] of this._ways) {
      if (!way.nodes || way.nodes.length < 2) {
        this._ways.delete(wayId);
      }
    }
  }

  #pruneOrphanNodes() {
    const referenced = new Set();
    for (const way of this._ways.values()) {
      for (const node of way.nodes) {
        referenced.add(node.id);
      }
    }
    for (const [nodeId] of this._nodes) {
      if (!referenced.has(nodeId)) {
        this._nodes.delete(nodeId);
      }
    }
  }

  #scheduleDerivedRefresh() {
    if (this._mutationDepth > 0) {
      this._derivedDirty = true;
      return;
    }
    this.rebuildDerived();
  }

  #stampWay(way) {
    const polyline = way.polyline;
    if (!polyline || polyline.length < 2) return;

    const cs = this._cellSize;
    const halfWidth = way.width / 2;
    const effectiveRadius = Math.max(halfWidth, cs * 0.75);
    const cellRadius = Math.ceil(effectiveRadius / cs);
    const stepSize = cs * 0.5;
    const ox = this._originX;
    const oz = this._originZ;
    const W = this._width;
    const H = this._height;

    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x;
      const az = polyline[i].z;
      const bx = polyline[i + 1].x;
      const bz = polyline[i + 1].z;
      const dx = bx - ax;
      const dz = bz - az;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      const steps = Math.ceil(segLen / stepSize);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t;
        const pz = az + dz * t;

        const cgx = Math.round((px - ox) / cs);
        const cgz = Math.round((pz - oz) / cs);

        for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
          for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
            const gx = cgx + ddx;
            const gz = cgz + ddz;
            if (gx < 0 || gx >= W || gz < 0 || gz >= H) continue;

            const cellX = ox + gx * cs;
            const cellZ = oz + gz * cs;
            const distSq = (cellX - px) ** 2 + (cellZ - pz) ** 2;
            if (distSq > effectiveRadius * effectiveRadius) continue;

            this._roadGrid.set(gx, gz, 1);
          }
        }
      }
    }
  }

  #stampBridge(bankA, bankB) {
    const cs = this._cellSize;
    const ox = this._originX;
    const oz = this._originZ;
    const W = this._width;
    const H = this._height;

    const dx = bankB.x - bankA.x;
    const dz = bankB.z - bankA.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) {
      const gx = Math.round((bankA.x - ox) / cs);
      const gz = Math.round((bankA.z - oz) / cs);
      if (gx >= 0 && gx < W && gz >= 0 && gz < H) {
        this._bridgeGrid.set(gx, gz, 1);
      }
      return;
    }

    const steps = Math.ceil(len / cs);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = bankA.x + dx * t;
      const pz = bankA.z + dz * t;
      const gx = Math.round((px - ox) / cs);
      const gz = Math.round((pz - oz) / cs);
      if (gx < 0 || gx >= W || gz < 0 || gz >= H) continue;
      this._bridgeGrid.set(gx, gz, 1);
    }
  }
}

function projectPointOntoSegment(px, pz, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-9) {
    return {
      x: a.x,
      z: a.z,
      t: 0,
      distSq: (px - a.x) * (px - a.x) + (pz - a.z) * (pz - a.z),
    };
  }

  let t = ((px - a.x) * dx + (pz - a.z) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + dx * t;
  const z = a.z + dz * t;
  return {
    x,
    z,
    t,
    distSq: (px - x) * (px - x) + (pz - z) * (pz - z),
  };
}
