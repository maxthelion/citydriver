/**
 * B4. Arterial network — fill gaps in the inherited arterial network.
 * Where populated areas lack arterial access, pathfind new connections.
 * Add cross-links between parallel inherited roads through high-density areas.
 */

import { distance2D } from '../core/math.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';

/**
 * Extend the road graph with arterial connections where needed.
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
    if (!isFinite(c)) return c;
    const d = density.get(toGx, toGz);
    c *= (1.5 - d); // High density = lower cost multiplier
    return c;
  };

  // Find arterial nodes for coverage check
  const arterialNodes = [];
  for (const [id, node] of graph.nodes) {
    const edges = graph.incidentEdges(id);
    const hasArterial = edges.some(eid => {
      const e = graph.getEdge(eid);
      return e && e.hierarchy === 'arterial';
    });
    if (hasArterial) {
      arterialNodes.push({ id, x: node.x, z: node.z });
    }
  }

  if (arterialNodes.length === 0) return;

  // Find underserved high-density areas
  const gapThreshold = cs * 30; // 300 world units = far from any arterial
  const densityThreshold = 0.3;
  const step = 10; // Sample every 10 cells
  const gapCenters = [];

  for (let gz = step; gz < h - step; gz += step) {
    for (let gx = step; gx < w - step; gx += step) {
      const d = density.get(gx, gz);
      if (d < densityThreshold) continue;

      // Check distance to nearest arterial node
      const wx = gx * cs;
      const wz = gz * cs;
      let nearestDist = Infinity;
      for (const an of arterialNodes) {
        const dist = distance2D(wx, wz, an.x, an.z);
        if (dist < nearestDist) nearestDist = dist;
      }

      if (nearestDist > gapThreshold) {
        gapCenters.push({ gx, gz, wx, wz, density: d, dist: nearestDist });
      }
    }
  }

  // Sort by density (highest first) and limit
  gapCenters.sort((a, b) => b.density - a.density);
  const maxGaps = 4;
  const selectedGaps = gapCenters.slice(0, maxGaps);

  // Connect each gap center to nearest arterial node
  for (const gap of selectedGaps) {
    // Find two nearest arterial nodes
    const sorted = arterialNodes
      .map(an => ({ ...an, dist: distance2D(gap.wx, gap.wz, an.x, an.z) }))
      .sort((a, b) => a.dist - b.dist);

    const target = sorted[0];
    if (!target) continue;

    const result = findPath(gap.gx, gap.gz, Math.round(target.x / cs), Math.round(target.z / cs), w, h, costFn);
    if (!result) continue;

    const simplified = simplifyPath(result.path, 2.0);
    const smooth = smoothPath(simplified, cs);
    if (smooth.length < 2) continue;

    // Add gap-fill road
    const gapNode = graph.addNode(smooth[0].x, smooth[0].z, { type: 'arterialGap' });
    addPathAsEdges(graph, smooth, gapNode, target.id, cs * 20, { width: 16, hierarchy: 'arterial' });

    // Update arterial nodes list
    arterialNodes.push({ id: gapNode, x: smooth[0].x, z: smooth[0].z });
  }

  // Cross-link: connect entry nodes that aren't already connected via short paths
  const entryNodes = [];
  for (const [id, node] of graph.nodes) {
    if (node.attrs.type === 'entry') entryNodes.push(id);
  }

  for (let i = 0; i < entryNodes.length; i++) {
    for (let j = i + 1; j < entryNodes.length; j++) {
      const a = graph.getNode(entryNodes[i]);
      const b = graph.getNode(entryNodes[j]);
      const directDist = distance2D(a.x, a.z, b.x, b.z);

      // Only cross-link if they're far enough apart and not already well-connected
      if (directDist < cs * 15 || directDist > cs * 80) continue;

      // Check if already connected via graph traversal (BFS with depth limit)
      if (isConnectedWithinHops(graph, entryNodes[i], entryNodes[j], 4)) continue;

      // Check if the midpoint is in a high-density area
      const midGx = Math.round((a.x + b.x) / 2 / cs);
      const midGz = Math.round((a.z + b.z) / 2 / cs);
      if (midGx < 0 || midGx >= w || midGz < 0 || midGz >= h) continue;
      if (density.get(midGx, midGz) < 0.2) continue;

      const aGx = Math.round(a.x / cs);
      const aGz = Math.round(a.z / cs);
      const bGx = Math.round(b.x / cs);
      const bGz = Math.round(b.z / cs);

      const result = findPath(aGx, aGz, bGx, bGz, w, h, costFn);
      if (!result) continue;

      const simplified = simplifyPath(result.path, 2.0);
      const smooth = smoothPath(simplified, cs);
      addPathAsEdges(graph, smooth, entryNodes[i], entryNodes[j], cs * 20, { width: 16, hierarchy: 'arterial' });
    }
  }
}

/**
 * Check if two nodes are connected within a limited number of hops.
 */
function isConnectedWithinHops(graph, startId, targetId, maxHops) {
  const visited = new Set();
  const queue = [{ id: startId, depth: 0 }];
  visited.add(startId);

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (id === targetId) return true;
    if (depth >= maxHops) continue;

    for (const neighbor of graph.neighbors(id)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }
  }

  return false;
}

/**
 * Walk along a smoothed path and add edges with intermediate nodes.
 */
function addPathAsEdges(graph, smooth, startNodeId, endNodeId, segLen, edgeOpts) {
  if (smooth.length < 2) {
    graph.addEdge(startNodeId, endNodeId, edgeOpts);
    return;
  }

  let prevNodeId = startNodeId;
  let accumulated = 0;
  let segmentPoints = [];

  for (let i = 1; i < smooth.length; i++) {
    const dx = smooth[i].x - smooth[i - 1].x;
    const dz = smooth[i].z - smooth[i - 1].z;
    accumulated += Math.sqrt(dx * dx + dz * dz);

    const isLast = i === smooth.length - 1;

    if (accumulated >= segLen && !isLast) {
      const midNode = graph.addNode(smooth[i].x, smooth[i].z, { type: 'arterialJunction' });
      graph.addEdge(prevNodeId, midNode, { ...edgeOpts, points: segmentPoints });
      prevNodeId = midNode;
      accumulated = 0;
      segmentPoints = [];
    } else if (isLast) {
      graph.addEdge(prevNodeId, endNodeId, { ...edgeOpts, points: segmentPoints });
    } else {
      segmentPoints.push({ x: smooth[i].x, z: smooth[i].z });
    }
  }
}
