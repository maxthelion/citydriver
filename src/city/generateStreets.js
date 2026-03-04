/**
 * B7. Local streets — fill blocks with narrow access streets.
 * Uses block subdivision: iteratively splits large blocks by inserting
 * roads roughly perpendicular to the longest edge, creating closed blocks
 * instead of dead-end trees.
 */

import { distance2D, polygonArea, polygonCentroid } from '../core/math.js';

/**
 * Add local streets to the road graph via block subdivision.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {import('../core/rng.js').SeededRandom} rng
 */
export function generateStreets(cityLayers, graph, rng) {
  const params = cityLayers.getData('params');
  const density = cityLayers.getGrid('density');

  if (!params || !density) return;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;

  const maxIterations = 200;

  for (let iter = 0; iter < maxIterations; iter++) {
    const faces = graph.faces();
    const targets = [];

    for (const face of faces) {
      const vertices = face.map(nodeId => {
        const n = graph.getNode(nodeId);
        return n ? { x: n.x, z: n.z, id: nodeId } : null;
      }).filter(v => v !== null);

      if (vertices.length < 3) continue;

      const area = Math.abs(polygonArea(vertices));
      const centroid = polygonCentroid(vertices);

      if (!isFinite(centroid.x) || !isFinite(centroid.z)) continue;

      const gx = Math.round(centroid.x / cs);
      const gz = Math.round(centroid.z / cs);
      const d = density.get(gx, gz);

      if (d < 0.15) continue;

      const targetArea = cs * cs * (80 - d * 60);
      if (area < targetArea) continue;
      if (area > cs * cs * 500) continue;

      targets.push({ vertices, area });
    }

    if (targets.length === 0) break;

    let anySubdivided = false;
    for (const { vertices } of targets) {
      // Find longest edge of block
      let longestLen = 0;
      let longestIdx = 0;
      for (let i = 0; i < vertices.length; i++) {
        const j = (i + 1) % vertices.length;
        const len = distance2D(vertices[i].x, vertices[i].z, vertices[j].x, vertices[j].z);
        if (len > longestLen) { longestLen = len; longestIdx = i; }
      }

      // Find the opposite side
      const oppIdx = (longestIdx + Math.floor(vertices.length / 2)) % vertices.length;
      const nextOpp = (oppIdx + 1) % vertices.length;

      const li = longestIdx;
      const lj = (longestIdx + 1) % vertices.length;
      const midA = {
        x: (vertices[li].x + vertices[lj].x) / 2 + rng.range(-cs * 0.5, cs * 0.5),
        z: (vertices[li].z + vertices[lj].z) / 2 + rng.range(-cs * 0.5, cs * 0.5),
      };
      const midB = {
        x: (vertices[oppIdx].x + vertices[nextOpp].x) / 2 + rng.range(-cs * 0.5, cs * 0.5),
        z: (vertices[oppIdx].z + vertices[nextOpp].z) / 2 + rng.range(-cs * 0.5, cs * 0.5),
      };

      // Re-verify edges still exist before splitting
      const edgeA = findEdgeBetween(graph, vertices[li].id, vertices[lj].id);
      const edgeB = findEdgeBetween(graph, vertices[oppIdx].id, vertices[nextOpp].id);

      if (edgeA === null || edgeB === null) continue;
      if (edgeA === edgeB) continue;
      if (!graph.getEdge(edgeA) || !graph.getEdge(edgeB)) continue;

      const nodeA = graph.splitEdge(edgeA, midA.x, midA.z);

      // Re-find edgeB since graph topology changed
      const edgeB2 = findEdgeBetween(graph, vertices[oppIdx].id, vertices[nextOpp].id);
      if (edgeB2 === null) continue;

      const nodeB = graph.splitEdge(edgeB2, midB.x, midB.z);

      graph.addEdge(nodeA, nodeB, { width: 6, hierarchy: 'local' });
      anySubdivided = true;
    }

    if (!anySubdivided) break;
  }
}

/**
 * Find the edge connecting two nodes, if one exists.
 * @returns {number|null} edge ID or null
 */
function findEdgeBetween(graph, nodeA, nodeB) {
  const edges = graph.incidentEdges(nodeA);
  for (const eId of edges) {
    const edge = graph.getEdge(eId);
    if ((edge.from === nodeA && edge.to === nodeB) || (edge.from === nodeB && edge.to === nodeA)) {
      return eId;
    }
  }
  return null;
}
