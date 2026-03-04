/**
 * B4. Arterial network — connect entry roads to center and each other.
 * Wide main streets, bridge placement at river crossings.
 * Uses A* pathfinding with density-corridor bonus for terrain-following roads.
 */

import { distance2D } from '../core/math.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';

/**
 * Extend the road graph with arterial connections.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {import('../core/rng.js').SeededRandom} rng
 */
export function generateArterials(cityLayers, graph, rng) {
  const params = cityLayers.getData('params');
  const density = cityLayers.getGrid('density');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!params || !density || !elevation) return;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;

  // Cost function: terrain + density corridor bonus
  const baseCost = terrainCostFunction(elevation, { waterGrid: waterMask });
  const costFn = (fromGx, fromGz, toGx, toGz) => {
    let c = baseCost(fromGx, fromGz, toGx, toGz);
    // Bonus for routing through higher-density areas
    const d = density.get(toGx, toGz);
    c *= (1.5 - d); // High density = lower cost multiplier
    return c;
  };

  // Find entry nodes and seed node
  const entryNodes = [];
  let seedNode = null;

  for (const [id, node] of graph.nodes) {
    if (node.attrs.type === 'seed') seedNode = id;
    if (node.attrs.type === 'entry') entryNodes.push(id);
  }

  if (seedNode === null || entryNodes.length < 2) return;

  // Connect entry pairs via pathfinding
  for (let i = 0; i < entryNodes.length; i++) {
    for (let j = i + 1; j < entryNodes.length; j++) {
      const a = graph.getNode(entryNodes[i]);
      const b = graph.getNode(entryNodes[j]);

      // Don't connect if already connected via short path
      const directDist = distance2D(a.x, a.z, b.x, b.z);
      if (directDist < cs * 10) continue; // too close

      const aGx = Math.round(a.x / cs);
      const aGz = Math.round(a.z / cs);
      const bGx = Math.round(b.x / cs);
      const bGz = Math.round(b.z / cs);

      const result = findPath(aGx, aGz, bGx, bGz, w, h, costFn);
      if (!result) continue;

      const simplified = simplifyPath(result.path, 2.0);
      const smooth = smoothPath(simplified, cs);

      // Create intermediate nodes every ~20 cells worth of distance
      const segLen = cs * 20;
      addPathAsEdges(graph, smooth, entryNodes[i], entryNodes[j], segLen, { width: 10, hierarchy: 'arterial' });
    }
  }
}

/**
 * Walk along a smoothed path and add edges with intermediate nodes.
 *
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {Array<{x, z}>} smooth - Smoothed world-coord path
 * @param {number} startNodeId - Existing start node ID
 * @param {number} endNodeId - Existing end node ID
 * @param {number} segLen - Target distance between intermediate nodes
 * @param {object} edgeOpts - Edge options (width, hierarchy, etc.)
 */
function addPathAsEdges(graph, smooth, startNodeId, endNodeId, segLen, edgeOpts) {
  if (smooth.length < 2) {
    graph.addEdge(startNodeId, endNodeId, edgeOpts);
    return;
  }

  let prevNodeId = startNodeId;
  let accumulated = 0;
  let segmentPoints = []; // Intermediate polyline points for current edge segment

  for (let i = 1; i < smooth.length; i++) {
    const dx = smooth[i].x - smooth[i - 1].x;
    const dz = smooth[i].z - smooth[i - 1].z;
    accumulated += Math.sqrt(dx * dx + dz * dz);

    const isLast = i === smooth.length - 1;

    if (accumulated >= segLen && !isLast) {
      // Create an intermediate node at this position
      const midNode = graph.addNode(smooth[i].x, smooth[i].z, { type: 'arterialJunction' });
      graph.addEdge(prevNodeId, midNode, { ...edgeOpts, points: segmentPoints });
      prevNodeId = midNode;
      accumulated = 0;
      segmentPoints = [];
    } else if (isLast) {
      // Final segment: connect to end node
      graph.addEdge(prevNodeId, endNodeId, { ...edgeOpts, points: segmentPoints });
    } else {
      // Accumulate intermediate polyline point
      segmentPoints.push({ x: smooth[i].x, z: smooth[i].z });
    }
  }
}
