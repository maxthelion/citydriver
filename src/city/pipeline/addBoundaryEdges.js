/**
 * Pipeline step: add non-road boundary edges to the planar graph.
 *
 * Adds map perimeter and river polylines as graph edges so that
 * facesWithEdges() can produce full face coverage even from a
 * tree-like skeleton. Without these, an MST skeleton has no cycles
 * and graph-face extraction finds no enclosed faces.
 *
 * Part of the land-model migration (specs/v5/land-model.md § step 5):
 * boundaries are anything that separates land — roads, water, map edges.
 *
 * Reads: map dimensions, rivers
 * Writes: graph edges (boundary type)
 */

/**
 * Add map perimeter edges to the graph.
 * Creates 4 nodes at corners and 4 edges forming the boundary rectangle.
 */
function addMapBoundary(graph, map) {
  const ox = map.originX;
  const oz = map.originZ;
  const w = map.width * map.cellSize;
  const h = map.height * map.cellSize;

  // Corners: NW, NE, SE, SW
  const nw = graph.addNode(ox, oz);
  const ne = graph.addNode(ox + w, oz);
  const se = graph.addNode(ox + w, oz + h);
  const sw = graph.addNode(ox, oz + h);

  const boundaryAttrs = { type: 'boundary', hierarchy: 'boundary', width: 0 };

  graph.addEdge(nw, ne, { ...boundaryAttrs });
  graph.addEdge(ne, se, { ...boundaryAttrs });
  graph.addEdge(se, sw, { ...boundaryAttrs });
  graph.addEdge(sw, nw, { ...boundaryAttrs });

  return { nodes: [nw, ne, se, sw], edges: 4 };
}

/**
 * Add river polylines as graph edges.
 * Each river segment between consecutive polyline points becomes a graph edge.
 * Points are snapped to existing graph nodes within snapDist.
 */
function addRiverEdges(graph, map) {
  const rivers = map.rivers;
  if (!rivers || rivers.length === 0) return { edges: 0 };

  const snapDist = map.cellSize * 3;
  let edgeCount = 0;

  for (const river of rivers) {
    const poly = river.polyline;
    if (!poly || poly.length < 2) continue;

    // Find or create nodes for each polyline point, then add edges between consecutive points
    let prevNode = null;

    for (let i = 0; i < poly.length; i++) {
      const pt = poly[i];

      // Skip points outside map bounds
      const lx = pt.x - map.originX;
      const lz = pt.z - map.originZ;
      if (lx < 0 || lz < 0 || lx > map.width * map.cellSize || lz > map.height * map.cellSize) {
        prevNode = null; // break the chain
        continue;
      }

      // Find nearest existing node or create new one
      let nodeId = null;
      let bestDist = snapDist;
      for (const [id, node] of graph.nodes) {
        const d = Math.hypot(node.x - pt.x, node.z - pt.z);
        if (d < bestDist) {
          bestDist = d;
          nodeId = id;
        }
      }
      if (nodeId === null) {
        nodeId = graph.addNode(pt.x, pt.z);
      }

      if (prevNode !== null && prevNode !== nodeId) {
        // Check for existing edge between these nodes
        const neighbors = graph.neighbors(prevNode);
        if (!neighbors.includes(nodeId)) {
          graph.addEdge(prevNode, nodeId, {
            hierarchy: 'boundary',
            width: pt.width || 0,
            attrs: { type: 'water' },
          });
          edgeCount++;
        }
      }

      prevNode = nodeId;
    }
  }

  return { edges: edgeCount };
}

/**
 * Add all boundary edges to the graph.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @returns {{ mapBoundaryEdges: number, riverEdges: number }}
 */
export function addBoundaryEdges(map) {
  const graph = map.graph;
  if (!graph) return { mapBoundaryEdges: 0, riverEdges: 0 };

  const mapResult = addMapBoundary(graph, map);
  const riverResult = addRiverEdges(graph, map);

  return {
    mapBoundaryEdges: mapResult.edges,
    riverEdges: riverResult.edges,
  };
}
