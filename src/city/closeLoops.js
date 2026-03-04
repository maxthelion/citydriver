/**
 * B8. Loop closure — eliminate dead ends and connect disconnected components.
 * Uses A* pathfinding for terrain-following connections when cityLayers is available.
 */

import { distance2D } from '../core/math.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';

/**
 * Close dead ends and connect disconnected components.
 *
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {number} [maxConnectDist=500] - Max distance to connect dead ends
 * @param {import('../core/LayerStack.js').LayerStack|null} [cityLayers=null] - Optional city layers for pathfinding
 */
export function closeLoops(graph, maxConnectDist = 500, cityLayers = null) {
  // Phase 1: Connect disconnected components
  connectComponents(graph, cityLayers);

  // Phase 2: Close dead ends
  const deadEnds = graph.deadEnds();

  // Get pathfinding data if available
  const elevation = cityLayers?.getGrid('elevation');
  const params = cityLayers?.getData('params');
  const w = params?.width ?? 0;
  const h = params?.height ?? 0;
  const cs = params?.cellSize ?? 10;
  const waterMask = cityLayers?.getGrid('waterMask');
  const costFn = elevation ? terrainCostFunction(elevation, { waterGrid: waterMask }) : null;

  for (const deadId of deadEnds) {
    const node = graph.getNode(deadId);
    if (!node) continue;
    if (node.attrs.type === 'entry') continue;

    const neighbors = new Set(graph.neighbors(deadId));
    let bestId = null;
    let bestDist = Infinity;

    for (const [id, other] of graph.nodes) {
      if (id === deadId || neighbors.has(id)) continue;
      const dist = distance2D(node.x, node.z, other.x, other.z);
      if (dist < bestDist && dist < maxConnectDist) {
        bestDist = dist;
        bestId = id;
      }
    }

    if (bestId !== null) {
      // Try pathfinding for the connection
      if (costFn && w > 0 && h > 0) {
        const startGx = Math.round(node.x / cs);
        const startGz = Math.round(node.z / cs);
        const other = graph.getNode(bestId);
        const endGx = Math.round(other.x / cs);
        const endGz = Math.round(other.z / cs);

        const result = findPath(startGx, startGz, endGx, endGz, w, h, costFn);
        if (result) {
          const simplified = simplifyPath(result.path, 1.0);
          const smooth = smoothPath(simplified, cs);
          const intermediates = smooth.slice(1, -1);
          graph.addEdge(deadId, bestId, { points: intermediates, width: 6, hierarchy: 'local' });
          continue;
        }
      }
      // Fallback: straight line
      graph.addEdge(deadId, bestId, { width: 6, hierarchy: 'local' });
    }
  }
}

/**
 * Connect disconnected components by finding nearest pairs between them.
 * Uses pathfinding when cityLayers is available.
 */
function connectComponents(graph, cityLayers = null) {
  if (graph.nodes.size === 0) return;

  // Get pathfinding data if available
  const elevation = cityLayers?.getGrid('elevation');
  const params = cityLayers?.getData('params');
  const w = params?.width ?? 0;
  const h = params?.height ?? 0;
  const cs = params?.cellSize ?? 10;
  const waterMask = cityLayers?.getGrid('waterMask');
  const costFn = elevation ? terrainCostFunction(elevation, { waterGrid: waterMask }) : null;

  // Find connected components
  const visited = new Set();
  const components = [];

  for (const [id] of graph.nodes) {
    if (visited.has(id)) continue;

    const component = [];
    const queue = [id];
    visited.add(id);

    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const neighbor of graph.neighbors(current)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    components.push(component);
  }

  if (components.length <= 1) return;

  // Connect each component to the largest one
  components.sort((a, b) => b.length - a.length);
  const mainComponent = new Set(components[0]);

  for (let i = 1; i < components.length; i++) {
    let bestMainId = null;
    let bestOtherId = null;
    let bestDist = Infinity;

    for (const otherId of components[i]) {
      const otherNode = graph.getNode(otherId);
      for (const mainId of mainComponent) {
        const mainNode = graph.getNode(mainId);
        const dist = distance2D(otherNode.x, otherNode.z, mainNode.x, mainNode.z);
        if (dist < bestDist) {
          bestDist = dist;
          bestMainId = mainId;
          bestOtherId = otherId;
        }
      }
    }

    if (bestMainId !== null && bestOtherId !== null) {
      // Try pathfinding for the connection
      if (costFn && w > 0 && h > 0) {
        const otherNode = graph.getNode(bestOtherId);
        const mainNode = graph.getNode(bestMainId);
        const startGx = Math.round(otherNode.x / cs);
        const startGz = Math.round(otherNode.z / cs);
        const endGx = Math.round(mainNode.x / cs);
        const endGz = Math.round(mainNode.z / cs);

        const result = findPath(startGx, startGz, endGx, endGz, w, h, costFn);
        if (result) {
          const simplified = simplifyPath(result.path, 1.0);
          const smooth = smoothPath(simplified, cs);
          const intermediates = smooth.slice(1, -1);
          graph.addEdge(bestOtherId, bestMainId, { points: intermediates, width: 6, hierarchy: 'local' });
          for (const id of components[i]) mainComponent.add(id);
          continue;
        }
      }
      // Fallback: straight line
      graph.addEdge(bestOtherId, bestMainId, { width: 6, hierarchy: 'local' });
      for (const id of components[i]) mainComponent.add(id);
    }
  }
}
