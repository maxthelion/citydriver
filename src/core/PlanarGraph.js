/**
 * Planar graph for road networks.
 * Nodes (position + attributes), edges (polyline + width + hierarchy),
 * face extraction (closed block polygons via edge-loop walking).
 */

export class PlanarGraph {
  constructor() {
    this._nextNodeId = 0;
    this._nextEdgeId = 0;
    this.nodes = new Map(); // id -> { id, x, z, attrs }
    this.edges = new Map(); // id -> { id, from, to, points, width, hierarchy, attrs }
    this._adjacency = new Map(); // nodeId -> [{edgeId, neighborId}]
  }

  /**
   * Add a node at (x, z) with optional attributes.
   * @returns {number} node ID
   */
  addNode(x, z, attrs = {}) {
    const id = this._nextNodeId++;
    this.nodes.set(id, { id, x, z, attrs });
    this._adjacency.set(id, []);
    return id;
  }

  /**
   * Get a node by ID.
   */
  getNode(id) {
    return this.nodes.get(id);
  }

  /**
   * Add an edge between two nodes.
   * @param {number} from - Source node ID
   * @param {number} to - Target node ID
   * @param {object} [options]
   * @param {Array<{x, z}>} [options.points] - Intermediate polyline points (excluding endpoints)
   * @param {number} [options.width=6] - Road width in world units
   * @param {string} [options.hierarchy='local'] - Road hierarchy level
   * @returns {number} edge ID
   */
  addEdge(from, to, options = {}) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error(`Node ${from} or ${to} not found`);
    }

    const {
      points = [],
      width = 6,
      hierarchy = 'local',
      ...attrs
    } = options;

    const id = this._nextEdgeId++;
    this.edges.set(id, { id, from, to, points, width, hierarchy, attrs });

    this._adjacency.get(from).push({ edgeId: id, neighborId: to });
    this._adjacency.get(to).push({ edgeId: id, neighborId: from });

    return id;
  }

  /**
   * Get an edge by ID.
   */
  getEdge(id) {
    return this.edges.get(id);
  }

  /**
   * Get the full polyline for an edge (from-node, intermediates, to-node).
   */
  edgePolyline(edgeId) {
    const edge = this.edges.get(edgeId);
    if (!edge) return [];
    const from = this.nodes.get(edge.from);
    const to = this.nodes.get(edge.to);
    return [
      { x: from.x, z: from.z },
      ...edge.points,
      { x: to.x, z: to.z },
    ];
  }

  /**
   * Degree of a node (number of incident edges).
   */
  degree(nodeId) {
    const adj = this._adjacency.get(nodeId);
    return adj ? adj.length : 0;
  }

  /**
   * Get neighbor node IDs.
   */
  neighbors(nodeId) {
    const adj = this._adjacency.get(nodeId);
    if (!adj) return [];
    return adj.map(e => e.neighborId);
  }

  /**
   * Get edges incident to a node.
   */
  incidentEdges(nodeId) {
    const adj = this._adjacency.get(nodeId);
    if (!adj) return [];
    return adj.map(e => e.edgeId);
  }

  /**
   * Find the nearest node to (x, z).
   * @returns {{ id: number, dist: number } | null}
   */
  nearestNode(x, z) {
    let bestId = null;
    let bestDist = Infinity;

    for (const [id, node] of this.nodes) {
      const dx = node.x - x;
      const dz = node.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = id;
      }
    }

    return bestId !== null ? { id: bestId, dist: bestDist } : null;
  }

  /**
   * Split an edge at a point, creating a new node and two new edges.
   * @returns {number} new node ID
   */
  splitEdge(edgeId, x, z, nodeAttrs = {}) {
    const edge = this.edges.get(edgeId);
    if (!edge) throw new Error(`Edge ${edgeId} not found`);

    const newNodeId = this.addNode(x, z, nodeAttrs);
    const { from, to, points, width, hierarchy, attrs } = edge;

    // Find split point in polyline
    const fullLine = this.edgePolyline(edgeId);
    let splitIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < fullLine.length - 1; i++) {
      const dist = pointToSegmentDistSq(x, z, fullLine[i].x, fullLine[i].z, fullLine[i + 1].x, fullLine[i + 1].z);
      if (dist < bestDist) {
        bestDist = dist;
        splitIdx = i;
      }
    }

    // Split intermediate points
    // Points before splitIdx go to first edge, after go to second
    const pointsBefore = points.slice(0, Math.max(0, splitIdx));
    const pointsAfter = points.slice(splitIdx);

    // Remove old edge
    this._removeEdge(edgeId);

    // Add two new edges
    this.addEdge(from, newNodeId, { points: pointsBefore, width, hierarchy, ...attrs });
    this.addEdge(newNodeId, to, { points: pointsAfter, width, hierarchy, ...attrs });

    return newNodeId;
  }

  /**
   * Extract faces (closed block polygons) via edge-loop walking.
   * Returns arrays of node IDs forming closed polygons.
   */
  faces() {
    if (this.edges.size === 0) return [];

    // Build the nextHE map using _buildHalfEdgeNext
    const { nextHE } = this._buildHalfEdgeNext();

    // Walk face loops
    const visited = new Set();
    const faces = [];
    const maxSteps = this.edges.size * 2 + 1; // each half-edge visited at most once

    for (const startKey of nextHE.keys()) {
      if (visited.has(startKey)) continue;

      const face = [];
      let current = startKey;
      let steps = 0;

      while (!visited.has(current) && steps < maxSteps) {
        visited.add(current);
        const [fromStr] = current.split('-');
        face.push(parseInt(fromStr));

        current = nextHE.get(current);
        if (!current) break;
        if (current === startKey) {
          // Closed loop
          if (face.length >= 3) {
            faces.push(face);
          }
          break;
        }
        steps++;
      }
    }

    return faces;
  }

  /**
   * Build the half-edge next map for face traversal.
   * Standard DCEL algorithm: for half-edge (u→v), next = prev(twin) in
   * the sorted outgoing list at v. This traces faces CW (left side of edge).
   * @returns {{ nextHE: Map<string, string>, outgoing: Map<number, Array> }}
   */
  _buildHalfEdgeNext() {
    const halfEdges = []; // [{from, to, edgeId, angle}]

    for (const [edgeId, edge] of this.edges) {
      const fromNode = this.nodes.get(edge.from);
      const toNode = this.nodes.get(edge.to);
      const pts = edge.points || [];

      // Use first/last polyline segment for angle (not endpoint-to-endpoint)
      const fwdTarget = pts.length > 0 ? pts[0] : toNode;
      const revTarget = pts.length > 0 ? pts[pts.length - 1] : fromNode;

      halfEdges.push({
        from: edge.from, to: edge.to, edgeId,
        angle: Math.atan2(fwdTarget.x - fromNode.x, fwdTarget.z - fromNode.z),
      });
      halfEdges.push({
        from: edge.to, to: edge.from, edgeId,
        angle: Math.atan2(revTarget.x - toNode.x, revTarget.z - toNode.z),
      });
    }

    // Group by source node and sort by angle
    const outgoing = new Map();
    for (const he of halfEdges) {
      if (!outgoing.has(he.from)) outgoing.set(he.from, []);
      outgoing.get(he.from).push(he);
    }
    for (const [, hes] of outgoing) {
      hes.sort((a, b) => a.angle - b.angle);
    }

    // For each half-edge (u→v), find twin (v→u) in sorted list at v,
    // then take the predecessor (wrapping). This gives the "next" half-edge
    // in the face to the left of the directed edge.
    const nextHE = new Map();

    for (const he of halfEdges) {
      const outHEs = outgoing.get(he.to);
      if (!outHEs || outHEs.length === 0) continue;

      // Find twin: the half-edge at he.to going back to he.from with same edgeId
      let twinIdx = -1;
      for (let i = 0; i < outHEs.length; i++) {
        if (outHEs[i].to === he.from && outHEs[i].edgeId === he.edgeId) {
          twinIdx = i;
          break;
        }
      }
      if (twinIdx < 0) continue;

      // Predecessor in sorted order (wrapping)
      const prevIdx = (twinIdx - 1 + outHEs.length) % outHEs.length;
      const prev = outHEs[prevIdx];

      const key = `${he.from}-${he.to}`;
      nextHE.set(key, `${prev.from}-${prev.to}`);
    }

    return { nextHE, outgoing };
  }

  /**
   * Extract faces with their edge IDs via edge-loop walking.
   * Returns arrays of { nodeIds, edgeIds } forming closed polygons.
   * @returns {Array<{ nodeIds: number[], edgeIds: number[] }>}
   */
  facesWithEdges() {
    if (this.edges.size === 0) return [];

    // Build node pair → edgeId lookup (both directions)
    const edgeLookup = new Map();
    for (const [edgeId, edge] of this.edges) {
      edgeLookup.set(`${edge.from}-${edge.to}`, edgeId);
      edgeLookup.set(`${edge.to}-${edge.from}`, edgeId);
    }

    const { nextHE } = this._buildHalfEdgeNext();

    // Walk face loops
    const visited = new Set();
    const faces = [];
    const maxSteps = this.edges.size * 2 + 1;

    for (const startKey of nextHE.keys()) {
      if (visited.has(startKey)) continue;

      const faceNodes = [];
      let current = startKey;
      let steps = 0;

      while (!visited.has(current) && steps < maxSteps) {
        visited.add(current);
        const [fromStr] = current.split('-');
        faceNodes.push(parseInt(fromStr));

        current = nextHE.get(current);
        if (!current) break;
        if (current === startKey) {
          if (faceNodes.length >= 3) {
            const edgeIds = [];
            for (let i = 0; i < faceNodes.length; i++) {
              const a = faceNodes[i];
              const b = faceNodes[(i + 1) % faceNodes.length];
              const eid = edgeLookup.get(`${a}-${b}`);
              if (eid !== undefined) edgeIds.push(eid);
            }
            faces.push({ nodeIds: faceNodes, edgeIds });
          }
          break;
        }
        steps++;
      }
    }

    return faces;
  }

  /**
   * Remove an edge (internal use).
   */
  _removeEdge(edgeId) {
    const edge = this.edges.get(edgeId);
    if (!edge) return;

    // Remove from adjacency lists
    const fromAdj = this._adjacency.get(edge.from);
    if (fromAdj) {
      const idx = fromAdj.findIndex(e => e.edgeId === edgeId);
      if (idx >= 0) fromAdj.splice(idx, 1);
    }

    const toAdj = this._adjacency.get(edge.to);
    if (toAdj) {
      const idx = toAdj.findIndex(e => e.edgeId === edgeId);
      if (idx >= 0) toAdj.splice(idx, 1);
    }

    this.edges.delete(edgeId);
  }

  /**
   * Remove a node and all incident edges.
   */
  removeNode(nodeId) {
    const adj = this._adjacency.get(nodeId);
    if (adj) {
      const edgeIds = adj.map(e => e.edgeId);
      for (const eid of edgeIds) this._removeEdge(eid);
    }
    this.nodes.delete(nodeId);
    this._adjacency.delete(nodeId);
  }

  /**
   * Merge node `from` into node `into`.
   * Rewires all edges touching `from` to point to `into`,
   * removes any self-loops created, then deletes `from`.
   */
  mergeNodes(from, into) {
    const fromAdj = this._adjacency.get(from);
    if (!fromAdj) return;

    const intoAdj = this._adjacency.get(into);

    // Process each edge incident to `from`
    for (const { edgeId, neighborId } of [...fromAdj]) {
      const edge = this.edges.get(edgeId);
      if (!edge) continue;

      // Rewire edge endpoints
      if (edge.from === from) edge.from = into;
      if (edge.to === from) edge.to = into;

      // Check for self-loop
      if (edge.from === edge.to) {
        this._removeEdge(edgeId);
        continue;
      }

      // Move adjacency entry to `into`
      intoAdj.push({ edgeId, neighborId });

      // Fix neighborId at the OTHER end of this edge
      const otherAdj = this._adjacency.get(neighborId);
      if (otherAdj) {
        for (const entry of otherAdj) {
          if (entry.edgeId === edgeId && entry.neighborId === from) {
            entry.neighborId = into;
          }
        }
      }
    }

    // Delete the merged node
    this.nodes.delete(from);
    this._adjacency.delete(from);
  }

  /**
   * Get all dead-end nodes (degree 1).
   */
  deadEnds() {
    const result = [];
    for (const [id] of this.nodes) {
      if (this.degree(id) === 1) result.push(id);
    }
    return result;
  }

  /**
   * Compute shortest path length between two nodes using Dijkstra.
   * Edge weights are the polyline geometric length.
   * @returns {number} total distance, or Infinity if unreachable
   */
  shortestPathLength(fromId, toId) {
    if (fromId === toId) return 0;
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return Infinity;

    const dist = new Map();
    dist.set(fromId, 0);

    // Simple priority queue via sorted insertion (fine for small graphs)
    const queue = [{ id: fromId, d: 0 }];
    const visited = new Set();

    while (queue.length > 0) {
      // Extract min
      let minIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].d < queue[minIdx].d) minIdx = i;
      }
      const { id: current, d: currentDist } = queue[minIdx];
      queue.splice(minIdx, 1);

      if (current === toId) return currentDist;
      if (visited.has(current)) continue;
      visited.add(current);

      const adj = this._adjacency.get(current);
      if (!adj) continue;

      for (const { edgeId, neighborId } of adj) {
        if (visited.has(neighborId)) continue;

        // Compute edge length from polyline
        const polyline = this.edgePolyline(edgeId);
        let edgeLen = 0;
        for (let i = 0; i < polyline.length - 1; i++) {
          const dx = polyline[i + 1].x - polyline[i].x;
          const dz = polyline[i + 1].z - polyline[i].z;
          edgeLen += Math.sqrt(dx * dx + dz * dz);
        }

        const newDist = currentDist + edgeLen;
        if (newDist < (dist.get(neighborId) ?? Infinity)) {
          dist.set(neighborId, newDist);
          queue.push({ id: neighborId, d: newDist });
        }
      }
    }

    return Infinity;
  }

  /**
   * Check if the graph is connected (all nodes reachable from any node).
   */
  isConnected() {
    if (this.nodes.size === 0) return true;

    const start = this.nodes.keys().next().value;
    const visited = new Set();
    const queue = [start];
    visited.add(start);

    while (queue.length > 0) {
      const current = queue.shift();
      for (const neighbor of this.neighbors(current)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    return visited.size === this.nodes.size;
  }
}

function normalizeAngle(a) {
  while (a < 0) a += Math.PI * 2;
  while (a >= Math.PI * 2) a -= Math.PI * 2;
  return a;
}

function pointToSegmentDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) {
    const ex = px - ax;
    const ez = pz - az;
    return ex * ex + ez * ez;
  }
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projZ = az + t * dz;
  const ex = px - projX;
  const ez = pz - projZ;
  return ex * ex + ez * ez;
}
