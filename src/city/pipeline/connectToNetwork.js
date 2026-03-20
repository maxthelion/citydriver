/**
 * Pipeline step: connect zone spines to the skeleton road network.
 *
 * Phase 1 (existing): connect zone spine endpoints to the nearest graph node via pathfinding.
 * Phase 2 (Step 4b): find disconnected local-road components and add connector roads.
 *
 * Reads: developmentZones, graph, roadGrid
 * Writes: roads (features)
 *
 * Spec: specs/v5/next-steps.md § Step 4
 */

import { findPath, simplifyPath, gridPathToWorldPolyline } from '../../core/pathfinding.js';

const CONNECTION_MAX_PATH_M = 500;

/**
 * @param {object} map - FeatureMap
 * @returns {object} map (for chaining)
 */
export function connectToNetwork(map) {
  const graph = map.graph;
  if (!graph) return map;

  const costFn = map.createPathCost('growth');
  const zones = map.developmentZones;
  if (!zones) return map;

  for (const zone of zones) {
    const spine = zone._spine;
    if (!spine || spine.length < 2) continue;

    // Try connecting both ends of the spine
    for (const endpoint of [spine[0], spine[spine.length - 1]]) {
      const roadGrid = map.getLayer('roadGrid');
      const egx = Math.round((endpoint.x - map.originX) / map.cellSize);
      const egz = Math.round((endpoint.z - map.originZ) / map.cellSize);
      if (roadGrid && roadGrid.get(egx, egz) > 0) continue; // already on road

      const nearest = graph.nearestNode(endpoint.x, endpoint.z);
      if (!nearest) continue;
      if (nearest.dist < map.cellSize * 3) continue; // close enough
      if (nearest.dist > CONNECTION_MAX_PATH_M) continue; // too far

      const nearestNode = graph.getNode(nearest.id);
      if (!nearestNode) continue;
      const toGx = Math.round((nearestNode.x - map.originX) / map.cellSize);
      const toGz = Math.round((nearestNode.z - map.originZ) / map.cellSize);

      if (egx < 1 || egx >= map.width - 1 || egz < 1 || egz >= map.height - 1) continue;
      if (toGx < 1 || toGx >= map.width - 1 || toGz < 1 || toGz >= map.height - 1) continue;

      const result = findPath(egx, egz, toGx, toGz, map.width, map.height, costFn);
      if (!result || result.path.length < 2) continue;

      const simplified = simplifyPath(result.path, 1.0);
      const worldPoly = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
      if (worldPoly.length < 2) continue;

      // Check path length
      let pathLen = 0;
      for (let i = 1; i < worldPoly.length; i++) {
        const dx = worldPoly[i].x - worldPoly[i - 1].x;
        const dz = worldPoly[i].z - worldPoly[i - 1].z;
        pathLen += Math.sqrt(dx * dx + dz * dz);
      }
      if (pathLen > CONNECTION_MAX_PATH_M) continue;

      _addRoad(map, worldPoly, 'collector', 8);
    }
  }

  // Phase 2 (Step 4b): Full connectivity — ensure every local-road node reaches a skeleton node.
  _ensureFullConnectivity(map, costFn);

  return map;
}

/**
 * Find disconnected local-road components and add connector paths to the skeleton.
 *
 * Algorithm:
 * 1. Find all graph components via BFS.
 * 2. Identify which components contain skeleton (arterial/collector) nodes.
 * 3. For each non-skeleton component, connect its centroid to the nearest graph node
 *    from a skeleton component, using pathfinding.
 *
 * Uses component-level BFS (O(n)) rather than O(n²) per-node scan.
 *
 * @param {object} map
 * @param {Function} costFn
 */
function _ensureFullConnectivity(map, costFn) {
  const graph = map.graph;
  if (!graph || graph.nodes.size === 0) return;

  // Find all connected components via BFS
  const componentOf = new Map(); // nodeId → componentId
  const components  = [];        // component index → { nodes: Set, hasSkeleton: bool }
  let nextComp = 0;

  for (const [startId] of graph.nodes) {
    if (componentOf.has(startId)) continue;

    const compIdx = nextComp++;
    const comp = { nodes: new Set(), hasSkeleton: false };
    components.push(comp);

    const queue = [startId];
    componentOf.set(startId, compIdx);
    comp.nodes.add(startId);

    while (queue.length > 0) {
      const id = queue.pop();
      const adj = graph._adjacency.get(id);
      if (!adj) continue;
      for (const { neighborId } of adj) {
        if (!componentOf.has(neighborId)) {
          componentOf.set(neighborId, compIdx);
          comp.nodes.add(neighborId);
          queue.push(neighborId);
        }
      }
    }
  }

  // Mark components that contain skeleton nodes (any node on arterial/collector edge)
  for (const [, edge] of graph.edges) {
    if (edge.hierarchy === 'arterial' || edge.hierarchy === 'collector') {
      const ci = componentOf.get(edge.from);
      if (ci !== undefined) components[ci].hasSkeleton = true;
    }
  }

  // Collect non-skeleton components, sorted by size descending (connect the largest first)
  const orphanComps = components
    .filter(c => !c.hasSkeleton && c.nodes.size > 0)
    .sort((a, b) => b.nodes.size - a.nodes.size);

  if (orphanComps.length === 0) return;

  // Cap the number of pathfinding operations — large cities can have thousands of tiny
  // disconnected ribbon stubs. Connecting them all via findPath would be O(n × grid_size).
  // Only connect the largest N orphan components.
  const MAX_CONNECTORS = 20;
  const toConnect = orphanComps.slice(0, MAX_CONNECTORS);

  // Find centroid of each orphan component
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;

  for (const comp of toConnect) {
    // Compute centroid of this component's nodes
    let cx = 0, cz = 0;
    for (const nid of comp.nodes) {
      const n = graph.nodes.get(nid);
      if (n) { cx += n.x; cz += n.z; }
    }
    cx /= comp.nodes.size;
    cz /= comp.nodes.size;

    // Find nearest node in ANY skeleton component via nearestNode scan
    // (O(n) but n is total nodes — acceptable for rare disconnected components)
    let bestDist = Infinity, bestNode = null;
    for (const [nid, n] of graph.nodes) {
      if (comp.nodes.has(nid)) continue; // same component
      const ci = componentOf.get(nid);
      if (ci === undefined || !components[ci].hasSkeleton) continue;
      const d = (n.x - cx) ** 2 + (n.z - cz) ** 2;
      if (d < bestDist) { bestDist = d; bestNode = n; }
    }
    if (!bestNode || bestDist > CONNECTION_MAX_PATH_M ** 2) continue;

    const fromGx = Math.round((cx - ox) / cs);
    const fromGz = Math.round((cz - oz) / cs);
    const toGx   = Math.round((bestNode.x - ox) / cs);
    const toGz   = Math.round((bestNode.z - oz) / cs);

    if (fromGx < 1 || fromGx >= map.width - 1 || fromGz < 1 || fromGz >= map.height - 1) continue;
    if (toGx   < 1 || toGx   >= map.width - 1 || toGz   < 1 || toGz   >= map.height - 1) continue;
    if (fromGx === toGx && fromGz === toGz) continue;

    const result = findPath(fromGx, fromGz, toGx, toGz, map.width, map.height, costFn);
    if (!result || result.path.length < 2) continue;

    const simplified = simplifyPath(result.path, 1.0);
    const worldPoly  = gridPathToWorldPolyline(simplified, cs, ox, oz);
    if (worldPoly.length < 2) continue;

    let pathLen = 0;
    for (let i = 1; i < worldPoly.length; i++) {
      const dx = worldPoly[i].x - worldPoly[i - 1].x;
      const dz = worldPoly[i].z - worldPoly[i - 1].z;
      pathLen += Math.sqrt(dx * dx + dz * dz);
    }
    if (pathLen > CONNECTION_MAX_PATH_M) continue;

    _addRoad(map, worldPoly, 'collector', 8);
  }
}

function _addRoad(map, polyline, hierarchy, width) {
  map.roadNetwork.add(polyline, {
    width,
    hierarchy,
    importance: hierarchy === 'collector' ? 0.5 : 0.2,
    source: 'land-first',
  });
}
