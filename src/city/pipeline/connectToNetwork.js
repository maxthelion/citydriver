/**
 * Pipeline step: connect zone spines to the skeleton road network.
 * Reads: developmentZones, graph, roadGrid
 * Writes: roads (features)
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
      const roadGrid = map.hasLayer ? map.getLayer('roadGrid') : map.roadGrid;
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

  return map;
}

function _addRoad(map, polyline, hierarchy, width) {
  const roadData = {
    type: 'road',
    polyline,
    width,
    hierarchy,
    importance: hierarchy === 'collector' ? 0.5 : 0.2,
    source: 'land-first',
    id: map.roads ? map.roads.length : 0,
  };

  map.addFeature('road', roadData);
}
