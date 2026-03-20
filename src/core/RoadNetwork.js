/**
 * RoadNetwork — single mutation point for roads, graph, and grid.
 *
 * Wraps:
 *  - A Map<id, Road> as the canonical road collection
 *  - A PlanarGraph for topology
 *  - Two Grid2D instances: roadGrid (stamped presence) and bridgeGrid
 *
 * All mutations go through add() / remove() / updatePolyline() / addBridge().
 */

import { Road } from './Road.js';
import { PlanarGraph } from './PlanarGraph.js';
import { Grid2D } from './Grid2D.js';

export class RoadNetwork {
  /**
   * @param {number} width    - Grid width in cells
   * @param {number} height   - Grid height in cells
   * @param {number} cellSize - World units per cell
   * @param {number} [originX=0]
   * @param {number} [originZ=0]
   */
  constructor(width, height, cellSize, originX = 0, originZ = 0) {
    this._width = width;
    this._height = height;
    this._cellSize = cellSize;
    this._originX = originX;
    this._originZ = originZ;

    /** @type {Map<number, Road>} */
    this._roads = new Map();

    /** @type {PlanarGraph} */
    this._graph = new PlanarGraph();

    const gridOpts = { type: 'uint8', cellSize, originX, originZ };
    /** @type {Grid2D} */
    this._roadGrid = new Grid2D(width, height, gridOpts);
    /** @type {Grid2D} */
    this._bridgeGrid = new Grid2D(width, height, { ...gridOpts });

    /**
     * Ref counts per grid cell index: how many roads stamp each cell.
     * Used so overlapping roads don't clear each other on remove.
     * @type {Int32Array}
     */
    this._cellRefCounts = new Int32Array(width * height);
  }

  // ── Public read-only accessors ──────────────────────────────────────────────

  /** @returns {Road[]} */
  get roads() {
    return [...this._roads.values()];
  }

  /** @returns {number} */
  get roadCount() {
    return this._roads.size;
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
   * @returns {Road | undefined}
   */
  getRoad(id) {
    return this._roads.get(id);
  }

  // ── Public mutation API ─────────────────────────────────────────────────────

  /**
   * Add a road from a world-coordinate polyline.
   * @param {Array<{x: number, z: number}>} polyline
   * @param {object} [attrs]
   * @param {number} [attrs.width=6]
   * @param {string} [attrs.hierarchy='local']
   * @param {number} [attrs.importance=0.45]
   * @param {*}      [attrs.source]
   * @returns {Road}
   */
  add(polyline, attrs = {}) {
    const road = new Road(polyline, attrs);
    this._roads.set(road.id, road);
    this.#stampRoad(road, /* add= */ true);
    this.#addToGraph(road);
    return road;
  }

  /**
   * Convert grid cells to world polyline and add.
   * @param {Array<{gx: number, gz: number}>} cells
   * @param {object} [attrs]
   * @returns {Road | null} null if fewer than 2 cells
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
   * Remove a road by id (ref-counted unstamping).
   * No-op for unknown ids.
   * @param {number} id
   */
  remove(id) {
    const road = this._roads.get(id);
    if (!road) return;

    this._roads.delete(id);
    this.#stampRoad(road, /* add= */ false);
    this.#removeFromGraph(road);
  }

  /**
   * Add a parametric bridge to a road and stamp bridgeGrid.
   * No-op for unknown roadId.
   * @param {number} roadId
   * @param {{x: number, z: number}} bankA
   * @param {{x: number, z: number}} bankB
   * @param {number} entryT
   * @param {number} exitT
   */
  addBridge(roadId, bankA, bankB, entryT, exitT) {
    const road = this._roads.get(roadId);
    if (!road) return;

    road.addBridge(bankA, bankB, entryT, exitT);
    this.#stampBridge(bankA, bankB);
  }

  /**
   * Replace a road's polyline, re-stamping grids and the graph.
   * @param {number} id
   * @param {Array<{x: number, z: number}>} newPolyline
   */
  updatePolyline(id, newPolyline) {
    const road = this._roads.get(id);
    if (!road) return;

    // Unstamp old geometry
    this.#stampRoad(road, /* add= */ false);
    this.#removeFromGraph(road);

    // Update polyline
    road._replacePolyline(newPolyline);

    // Re-stamp new geometry
    this.#stampRoad(road, /* add= */ true);
    this.#addToGraph(road);
  }

  // ── Private: stamping ───────────────────────────────────────────────────────

  /**
   * Walk the road's polyline and stamp (or unstamp) roadGrid cells.
   * @param {Road} road
   * @param {boolean} add - true to stamp, false to unstamp
   */
  #stampRoad(road, add) {
    const polyline = road.polyline;
    if (!polyline || polyline.length < 2) return;

    const cs = this._cellSize;
    const halfWidth = road.width / 2;
    const effectiveRadius = Math.max(halfWidth, cs * 0.75);
    const cellRadius = Math.ceil(effectiveRadius / cs);
    const stepSize = cs * 0.5;
    const ox = this._originX;
    const oz = this._originZ;
    const W = this._width;
    const H = this._height;

    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x, az = polyline[i].z;
      const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
      const dx = bx - ax, dz = bz - az;
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

            const idx = gz * W + gx;
            if (add) {
              this._cellRefCounts[idx]++;
              this._roadGrid.set(gx, gz, 1);
            } else {
              const count = Math.max(0, this._cellRefCounts[idx] - 1);
              this._cellRefCounts[idx] = count;
              if (count === 0) {
                this._roadGrid.set(gx, gz, 0);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Stamp bridgeGrid between bankA and bankB at cellSize steps.
   * @param {{x: number, z: number}} bankA
   * @param {{x: number, z: number}} bankB
   */
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
      // Stamp single cell
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

  // ── Private: graph management ───────────────────────────────────────────────

  /**
   * Find or create graph nodes for the road's start/end, then add the edge.
   * Skips if start === end (degenerate road).
   * Logs a warning if an edge between these nodes already exists.
   * @param {Road} road
   */
  #addToGraph(road) {
    const snapDist = this._cellSize * 3;
    const startPt = road.start;
    const endPt = road.end;

    const startNode = this.#findOrCreateNode(startPt.x, startPt.z, snapDist);
    const endNode = this.#findOrCreateNode(endPt.x, endPt.z, snapDist);

    if (startNode === endNode) {
      // Degenerate road: both endpoints snapped to the same node.
      // If startNode was newly created (degree 0), remove it to avoid orphan.
      if (this._graph.degree(startNode) === 0) {
        this._graph.removeNode(startNode);
      }
      return;
    }

    // Check if already connected
    const neighbors = this._graph.neighbors(startNode);
    if (neighbors.includes(endNode)) {
      console.warn(
        `[RoadNetwork] Duplicate edge between nodes ${startNode} and ${endNode} — adding anyway`
      );
    }

    // Intermediate points (all polyline points except first and last)
    const poly = road.polyline;
    const points = poly.slice(1, poly.length - 1);

    this._graph.addEdge(startNode, endNode, {
      points,
      width: road.width,
      hierarchy: road.hierarchy,
    });
  }

  /**
   * Find the edge between a road's start/end and remove it.
   * Removes orphaned nodes (degree 0) after edge removal.
   * @param {Road} road
   */
  #removeFromGraph(road) {
    const snapDist = this._cellSize * 3;
    const startPt = road.start;
    const endPt = road.end;

    const nearStart = this._graph.nearestNode(startPt.x, startPt.z);
    const nearEnd = this._graph.nearestNode(endPt.x, endPt.z);

    if (!nearStart || !nearEnd) return;
    if (nearStart.dist > snapDist || nearEnd.dist > snapDist) return;
    if (nearStart.id === nearEnd.id) return;

    const startId = nearStart.id;
    const endId = nearEnd.id;

    // Find the edge connecting these two nodes
    const adj = this._graph._adjacency.get(startId);
    if (!adj) return;

    let edgeId = null;
    for (const entry of adj) {
      if (entry.neighborId === endId) {
        edgeId = entry.edgeId;
        break;
      }
    }
    if (edgeId === null) return;

    this._graph._removeEdge(edgeId);

    // Clean up orphaned nodes
    if (this._graph.degree(startId) === 0) {
      this._graph.removeNode(startId);
    }
    if (this._graph.nodes.has(endId) && this._graph.degree(endId) === 0) {
      this._graph.removeNode(endId);
    }
  }

  /**
   * Find an existing node within snapDist, or create a new one.
   * @param {number} x
   * @param {number} z
   * @param {number} snapDist
   * @returns {number} node id
   */
  #findOrCreateNode(x, z, snapDist) {
    const nearest = this._graph.nearestNode(x, z);
    if (nearest && nearest.dist <= snapDist) {
      return nearest.id;
    }
    return this._graph.addNode(x, z);
  }
}
