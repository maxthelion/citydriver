/**
 * Match a zone boundary polygon to nearby graph edges.
 *
 * For each segment of the boundary polygon, find the closest graph edge
 * within a tolerance. Returns arrays of matched edge IDs and node IDs.
 *
 * This is used after flood-fill zone extraction: the flood-fill produces
 * a boundary polygon (from cell-edge tracing), and we need to know which
 * graph edges form that boundary so zones have proper topology references.
 */

/**
 * Minimum distance from a point to a polyline (array of {x, z}).
 * @param {{x: number, z: number}} pt
 * @param {Array<{x: number, z: number}>} polyline
 * @returns {number}
 */
function pointToPolylineDist(pt, polyline) {
  let minDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentDist(pt, polyline[i], polyline[i + 1]);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Distance from point p to line segment a-b.
 * @param {{x: number, z: number}} p
 * @param {{x: number, z: number}} a
 * @param {{x: number, z: number}} b
 * @returns {number}
 */
function pointToSegmentDist(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ez = p.z - a.z;
    return Math.sqrt(ex * ex + ez * ez);
  }
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projZ = a.z + t * dz;
  const ex = p.x - projX;
  const ez = p.z - projZ;
  return Math.sqrt(ex * ex + ez * ez);
}

/**
 * Match a zone boundary polygon to nearby graph edges.
 *
 * For each segment of the boundary polygon, computes the midpoint and
 * finds the closest graph edge polyline within the given tolerance.
 *
 * @param {Array<{x: number, z: number}>} polygon - Zone boundary polygon (world coords)
 * @param {import('../../core/PlanarGraph.js').PlanarGraph} graph
 * @param {number} tolerance - Maximum distance for a match (typically cellSize * 3)
 * @returns {{ edgeIds: number[], nodeIds: number[] }}
 */
export function matchBoundaryToGraphEdges(polygon, graph, tolerance) {
  if (!polygon || polygon.length < 3) return { edgeIds: [], nodeIds: [] };

  const matchedEdgeIds = new Set();
  const matchedNodeIds = new Set();

  // Pre-build edge polylines for efficiency
  const edgePolylines = [];
  for (const [edgeId, edge] of graph.edges) {
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (!fromNode || !toNode) continue;
    const polyline = [
      { x: fromNode.x, z: fromNode.z },
      ...edge.points,
      { x: toNode.x, z: toNode.z },
    ];
    edgePolylines.push({ edgeId, edge, polyline });
  }

  // For each boundary segment, find the closest graph edge
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    const midX = (polygon[i].x + polygon[j].x) / 2;
    const midZ = (polygon[i].z + polygon[j].z) / 2;
    const mid = { x: midX, z: midZ };

    let bestDist = Infinity;
    let bestEntry = null;

    for (const entry of edgePolylines) {
      const dist = pointToPolylineDist(mid, entry.polyline);
      if (dist < bestDist) {
        bestDist = dist;
        bestEntry = entry;
      }
    }

    if (bestEntry && bestDist <= tolerance) {
      matchedEdgeIds.add(bestEntry.edgeId);
      matchedNodeIds.add(bestEntry.edge.from);
      matchedNodeIds.add(bestEntry.edge.to);
    }
  }

  return {
    edgeIds: [...matchedEdgeIds],
    nodeIds: [...matchedNodeIds],
  };
}
