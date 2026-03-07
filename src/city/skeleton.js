/**
 * City skeleton (tick 1).
 * Place nuclei, import anchor routes, connect via Union-Find MST.
 *
 * Uses the shared buildRoadNetwork pipeline for pathfind → merge → smooth.
 *
 * Spec: statement-of-intent.md "Tick 1: Satellite settlements and road skeleton"
 * Constants: technical-reference.md
 */

import { findPath } from '../core/pathfinding.js';
import { buildRoadNetwork } from '../core/buildRoadNetwork.js';
import { UnionFind } from '../core/UnionFind.js';
import { distance2D } from '../core/math.js';

// Importance weight for hierarchy computation
function importanceTierWeight(tier) {
  if (tier <= 1) return 1.0;
  if (tier <= 2) return 0.7;
  if (tier <= 3) return 0.45;
  if (tier <= 4) return 0.2;
  return 0.1;
}

/**
 * Build skeleton roads on the FeatureMap.
 * Collects anchor + MST + fallback connections, then pathfinds and adds roads.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function buildSkeletonRoads(map) {
  const layers = map.regionalLayers;
  const nuclei = map.nuclei;

  // 2. Collect all road connections (anchor + MST)
  const connections = [];
  const anchorConns = getAnchorConnections(map, layers);
  const mstConns = getMSTConnections(map, nuclei);
  connections.push(...anchorConns);
  connections.push(...mstConns);

  if (connections.length === 0) {
    // Fallback: no regional roads and no MST edges
    connections.push(...getFallbackConnections(map));
  }

  // 3. Shared pipeline: pathfind → merge → smooth
  const costFn = map.createPathCost('anchor');
  const builtRoads = buildRoadNetwork({
    width: map.width,
    height: map.height,
    cellSize: map.cellSize,
    costFn,
    connections,
    roadGrid: map.roadGrid,
    smooth: { simplifyEpsilon: 1.0, chaikinIterations: 4 },
    originX: map.originX,
    originZ: map.originZ,
  });

  // 4. Add merged roads as features + graph edges
  for (const road of builtRoads) {
    if (!road.polyline || road.polyline.length < 2) continue;

    const importance = road.hierarchy === 'arterial' ? 0.9 :
                       road.hierarchy === 'collector' ? 0.6 : 0.45;
    const width = 6 + importance * 10;

    map.addFeature('road', {
      polyline: road.polyline,
      width,
      hierarchy: road.hierarchy,
      importance,
      source: 'skeleton',
    });

    _addRoadToGraph(map, road.polyline, width, road.hierarchy);
  }
}

/**
 * Place nuclei and build road skeleton on the FeatureMap.
 * Thin wrapper around buildSkeletonRoads for backward compatibility.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function buildSkeleton(map) {
  buildSkeletonRoads(map);
}

/**
 * Get connections from regional roads that cross the city.
 * Returns grid-coord connection pairs for buildRoadNetwork.
 */
function getAnchorConnections(map, layers) {
  const roads = layers.getData('roads');
  if (!roads || roads.length === 0) return [];

  const params = layers.getData('params');
  const regionalCellSize = params.cellSize;

  const cityMinX = map.originX;
  const cityMinZ = map.originZ;
  const cityMaxX = map.originX + map.width * map.cellSize;
  const cityMaxZ = map.originZ + map.height * map.cellSize;

  const hierRank = { arterial: 1, collector: 2, local: 3, track: 4 };
  const relevantRoads = [];

  for (const road of roads) {
    const path = road.rawPath || road.path;
    if (!path) continue;

    let inside = false;
    for (const p of path) {
      const wx = p.gx * regionalCellSize;
      const wz = p.gz * regionalCellSize;
      if (wx >= cityMinX && wx <= cityMaxX && wz >= cityMinZ && wz <= cityMaxZ) {
        inside = true;
        break;
      }
    }
    if (inside) relevantRoads.push(road);
  }

  // Sort by hierarchy (arterials first)
  relevantRoads.sort((a, b) => (hierRank[a.hierarchy] || 3) - (hierRank[b.hierarchy] || 3));

  const connections = [];
  for (const road of relevantRoads) {
    const path = road.rawPath || road.path;

    // Find entry and exit points within city bounds
    const cityPoints = [];
    for (const p of path) {
      const wx = p.gx * regionalCellSize;
      const wz = p.gz * regionalCellSize;
      const cgx = Math.round((wx - map.originX) / map.cellSize);
      const cgz = Math.round((wz - map.originZ) / map.cellSize);
      if (cgx >= 1 && cgx < map.width - 1 && cgz >= 1 && cgz < map.height - 1) {
        cityPoints.push({ gx: cgx, gz: cgz });
      }
    }

    if (cityPoints.length < 2) continue;

    const startPt = cityPoints[0];
    const endPt = cityPoints[cityPoints.length - 1];
    if (distance2D(startPt.gx, startPt.gz, endPt.gx, endPt.gz) < 5) continue;

    connections.push({
      from: startPt,
      to: endPt,
      hierarchy: road.hierarchy || 'local',
    });
  }

  return connections;
}

/**
 * Get MST connections between nuclei.
 * Uses Union-Find to find inter-component edges, returns connection pairs.
 */
function getMSTConnections(map, nuclei) {
  if (nuclei.length < 2) return [];

  // Simple MST: connect all nuclei by shortest distance, skipping already-connected
  const uf = new UnionFind(nuclei.length);

  // Kruskal's MST
  const edges = [];
  for (let i = 0; i < nuclei.length; i++) {
    for (let j = i + 1; j < nuclei.length; j++) {
      const d = distance2D(nuclei[i].gx, nuclei[i].gz, nuclei[j].gx, nuclei[j].gz);
      edges.push({ i, j, cost: d });
    }
  }
  edges.sort((a, b) => a.cost - b.cost);

  const connections = [];
  for (const edge of edges) {
    if (uf.connected(edge.i, edge.j)) continue;
    uf.union(edge.i, edge.j);

    const a = nuclei[edge.i];
    const b = nuclei[edge.j];

    // Compute hierarchy from tier weights
    const pairWeight = (importanceTierWeight(a.tier) + importanceTierWeight(b.tier)) / 2;
    const hierarchy = pairWeight > 0.6 ? 'arterial' : pairWeight > 0.3 ? 'collector' : 'local';

    connections.push({
      from: { gx: a.gx, gz: a.gz },
      to: { gx: b.gx, gz: b.gz },
      hierarchy,
    });
  }

  return connections;
}

/**
 * Fallback connections when no regional roads cross the city.
 */
function getFallbackConnections(map) {
  const cx = Math.floor(map.width / 2);
  const cz = Math.floor(map.height / 2);
  const margin = 5;

  return [
    { from: { gx: cx, gz: cz }, to: { gx: margin, gz: cz }, hierarchy: 'collector' },
    { from: { gx: cx, gz: cz }, to: { gx: map.width - margin, gz: cz }, hierarchy: 'collector' },
  ];
}

// ============================================================
// Graph helpers
// ============================================================

/**
 * Add a smoothed road polyline to the PlanarGraph.
 */
function _addRoadToGraph(map, polyline, width, hierarchy) {
  if (polyline.length < 2) return;

  const graph = map.graph;
  const snapDist = map.cellSize * 3;

  const startPt = polyline[0];
  const endPt = polyline[polyline.length - 1];

  const startNodeId = _findOrCreateNode(graph, startPt.x, startPt.z, snapDist);
  const endNodeId = _findOrCreateNode(graph, endPt.x, endPt.z, snapDist);

  if (startNodeId === endNodeId) return;

  const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
  graph.addEdge(startNodeId, endNodeId, { points, width, hierarchy });
}

function _findOrCreateNode(graph, x, z, snapDist) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < snapDist) {
    return nearest.id;
  }
  return graph.addNode(x, z);
}
