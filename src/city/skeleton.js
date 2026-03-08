/**
 * City skeleton (tick 1).
 * Place nuclei, import anchor routes, connect via Union-Find MST.
 *
 * Uses the shared buildRoadNetwork pipeline for pathfind → merge → smooth.
 *
 * Spec: statement-of-intent.md "Tick 1: Satellite settlements and road skeleton"
 * Constants: technical-reference.md
 */

import { findPath, gridPathToWorldPolyline } from '../core/pathfinding.js';
import { buildRoadNetwork } from '../core/buildRoadNetwork.js';
import { UnionFind } from '../core/UnionFind.js';
import { distance2D } from '../core/math.js';
import { placeBridges } from './bridges.js';

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

  // 2. Collect road connections — MST + anchors (no extras yet)
  const { mstConnections, extraConnections } = getMSTConnections(map, nuclei);
  const connections = [];
  connections.push(...getAnchorConnections(map, layers));
  connections.push(...mstConnections);

  if (connections.length === 0) {
    connections.push(...getFallbackConnections(map));
  }

  // 3. Shared pipeline: pathfind → merge → smooth (MST + anchors only)
  const costFn = map.createPathCost('anchor');
  const builtRoads = buildRoadNetwork({
    width: map.width,
    height: map.height,
    cellSize: map.cellSize,
    costFn,
    connections,
    roadGrid: map.roadGrid,
    smooth: { simplifyEpsilon: 1.0, chaikinIterations: 0 },
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

    addRoadToGraph(map, road.polyline, width, road.hierarchy);
  }

  // 5. Connect any nuclei that ended up far from the road network.
  // The merge step can absorb nucleus endpoints into anchor routes.
  _connectDisconnectedNuclei(map);

  // 6. Add extra edges (cycle creators) AFTER the main skeleton.
  // These are pathfound with a cost function that penalizes existing roads,
  // forcing them to find alternative routes and create genuine cycles.
  _addExtraEdges(map, extraConnections);

  // 7. Place bridges where skeleton roads cross rivers.
  placeBridges(map);
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
  if (nuclei.length < 2) return { mstConnections: [], extraConnections: [] };

  const uf = new UnionFind(nuclei.length);

  const edges = [];
  for (let i = 0; i < nuclei.length; i++) {
    for (let j = i + 1; j < nuclei.length; j++) {
      const d = distance2D(nuclei[i].gx, nuclei[i].gz, nuclei[j].gx, nuclei[j].gz);
      edges.push({ i, j, cost: d });
    }
  }
  edges.sort((a, b) => a.cost - b.cost);

  const mstConnections = [];
  const candidateExtras = [];

  for (const edge of edges) {
    const a = nuclei[edge.i];
    const b = nuclei[edge.j];
    const pairWeight = (importanceTierWeight(a.tier) + importanceTierWeight(b.tier)) / 2;
    const hierarchy = pairWeight > 0.6 ? 'arterial' : pairWeight > 0.3 ? 'collector' : 'local';

    if (!uf.connected(edge.i, edge.j)) {
      uf.union(edge.i, edge.j);
      mstConnections.push({
        from: { gx: a.gx, gz: a.gz },
        to: { gx: b.gx, gz: b.gz },
        hierarchy,
      });
    } else {
      candidateExtras.push({
        from: { gx: a.gx, gz: a.gz },
        to: { gx: b.gx, gz: b.gz },
        hierarchy: hierarchy === 'arterial' ? 'collector' : 'local',
      });
    }
  }

  // Take the shortest non-MST edges, up to ~40% of the MST edge count.
  const maxExtras = Math.max(2, Math.floor(mstConnections.length * 0.4));
  const extraConnections = candidateExtras.slice(0, maxExtras);

  return { mstConnections, extraConnections };
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

/**
 * Add extra edges that create cycles in the graph.
 * Pathfound AFTER the main skeleton with a cost that penalizes existing roads,
 * forcing genuinely different routes.
 */
function _addExtraEdges(map, extraConnections) {
  if (extraConnections.length === 0) return;

  // Cost function that penalizes cells already on roads (opposite of reuse discount)
  const baseCostFn = map.createPathCost('growth');
  const avoidRoadCostFn = (fromGx, fromGz, toGx, toGz) => {
    const base = baseCostFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(base)) return base;
    // Penalize cells that already have roads — force alternative routes
    if (map.roadGrid.get(toGx, toGz) > 0) return base * 5;
    return base;
  };

  for (const conn of extraConnections) {
    const result = findPath(
      conn.from.gx, conn.from.gz,
      conn.to.gx, conn.to.gz,
      map.width, map.height, avoidRoadCostFn,
    );
    if (!result || result.path.length < 2) continue;

    // Stamp onto roadGrid
    for (const p of result.path) {
      map.roadGrid.set(p.gx, p.gz, 1);
    }

    const simplified = _simplifyPathInline(result.path, 1.0);
    const smoothed = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);

    if (smoothed.length < 2) continue;

    const width = 6 + 0.45 * 10;
    map.addFeature('road', {
      polyline: smoothed,
      width,
      hierarchy: conn.hierarchy,
      importance: 0.45,
      source: 'skeleton',
    });

    addRoadToGraph(map, smoothed, width, conn.hierarchy);
  }
}

/** Simplified RDP for grid paths. */
function _simplifyPathInline(path, epsilon) {
  if (path.length <= 2) return path;
  let maxDist = 0, maxIdx = 0;
  const first = path[0], last = path[path.length - 1];
  for (let i = 1; i < path.length - 1; i++) {
    const d = _pointLineDistSq(path[i].gx, path[i].gz, first.gx, first.gz, last.gx, last.gz);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (Math.sqrt(maxDist) > epsilon) {
    const left = _simplifyPathInline(path.slice(0, maxIdx + 1), epsilon);
    const right = _simplifyPathInline(path.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function _pointLineDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return (px - ax - t * dx) ** 2 + (pz - az - t * dz) ** 2;
}

/**
 * Connect nuclei that are far from the road network.
 * After buildRoadNetwork merges paths, some nucleus endpoints get absorbed
 * into anchor routes. This adds short spur roads from each disconnected
 * nucleus to the nearest road cell.
 */
function _connectDisconnectedNuclei(map) {
  const graph = map.graph;
  const snapDist = map.cellSize * 3;

  for (const n of map.nuclei) {
    const wx = map.originX + n.gx * map.cellSize;
    const wz = map.originZ + n.gz * map.cellSize;
    const nearest = graph.nearestNode(wx, wz);
    if (nearest && nearest.dist <= snapDist) continue;

    // Nucleus is far from graph — find nearest road cell and pathfind a spur
    let bestDist = Infinity, bestGx = -1, bestGz = -1;
    const searchRadius = 20;
    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const gx = n.gx + dx, gz = n.gz + dz;
        if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) continue;
        if (map.roadGrid.get(gx, gz) === 0) continue;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < bestDist) { bestDist = d; bestGx = gx; bestGz = gz; }
      }
    }

    if (bestGx < 0) continue;

    // Use 'nucleus' preset — tolerates low buildability (cost 12, not Infinity)
    const costFn = map.createPathCost('nucleus');
    const result = findPath(n.gx, n.gz, bestGx, bestGz, map.width, map.height, costFn);
    if (!result || result.path.length < 2) continue;

    // Stamp road grid
    for (const p of result.path) {
      map.roadGrid.set(p.gx, p.gz, 1);
    }

    // Simplify and smooth
    const simplified = _simplifyPathInline(result.path, 1.0);
    const smoothed = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
    if (smoothed.length < 2) continue;

    const width = 6 + 0.3 * 10;
    map.addFeature('road', {
      polyline: smoothed,
      width,
      hierarchy: 'local',
      importance: 0.3,
      source: 'skeleton',
    });

    addRoadToGraph(map, smoothed, width, 'local');
  }
}

// ============================================================
// Graph helpers
// ============================================================

/**
 * Add a smoothed road polyline to the PlanarGraph.
 */
export function addRoadToGraph(map, polyline, width, hierarchy) {
  if (polyline.length < 2) return;

  const graph = map.graph;
  const snapDist = map.cellSize * 3;

  const startPt = polyline[0];
  const endPt = polyline[polyline.length - 1];

  const startNodeId = _findOrCreateNode(graph, startPt.x, startPt.z, snapDist);
  const endNodeId = _findOrCreateNode(graph, endPt.x, endPt.z, snapDist);

  if (startNodeId === endNodeId) return;

  // Skip if there's already an edge between these nodes (prevents duplicate
  // edges that break the half-edge face extraction algorithm)
  if (graph.neighbors(startNodeId).includes(endNodeId)) return;

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
