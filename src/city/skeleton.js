/**
 * City skeleton (tick 1).
 * Place nuclei, import anchor routes, connect via Union-Find MST.
 *
 * Spec: statement-of-intent.md "Tick 1: Satellite settlements and road skeleton"
 * Constants: technical-reference.md
 */

import { findPath, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { UnionFind } from '../core/UnionFind.js';
import { distance2D } from '../core/math.js';

// Nucleus caps by tier
function nucleusCap(tier) {
  if (tier <= 1) return 20;
  if (tier <= 2) return 14;
  return 10;
}

// Population weight by tier
function tierWeight(tier) {
  if (tier <= 1) return 0.50;
  if (tier <= 2) return 0.30;
  if (tier <= 3) return 0.10;
  if (tier <= 4) return 0.05;
  return 0.02;
}

// Importance weight for hierarchy computation
function importanceTierWeight(tier) {
  if (tier <= 1) return 1.0;
  if (tier <= 2) return 0.7;
  if (tier <= 3) return 0.45;
  if (tier <= 4) return 0.2;
  return 0.1;
}

/**
 * Place nuclei and build road skeleton on the FeatureMap.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function buildSkeleton(map) {
  const rng = map.rng;
  const settlement = map.settlement;
  const layers = map.regionalLayers;
  const tier = settlement.tier || 3;

  // 1. Place nuclei
  const nuclei = placeNuclei(map, tier, rng);
  map.nuclei = nuclei;

  // 2. Import anchor routes from regional roads
  importAnchorRoutes(map, layers);

  // 3. Connect nuclei via MST
  connectNuclei(map, nuclei);
}

/**
 * Place nucleus seeds on buildable land.
 */
function placeNuclei(map, tier, rng) {
  const cap = nucleusCap(tier);
  const minSpacing = 15; // grid cells
  const nuclei = [];

  // Center nucleus at settlement location
  const centerGx = Math.round((map.settlement.gx * (map.regionalLayers.getData('params').cellSize) - map.originX) / map.cellSize);
  const centerGz = Math.round((map.settlement.gz * (map.regionalLayers.getData('params').cellSize) - map.originZ) / map.cellSize);

  if (centerGx >= 0 && centerGx < map.width && centerGz >= 0 && centerGz < map.height) {
    nuclei.push({
      gx: centerGx,
      gz: centerGz,
      type: classifyNucleus(map, centerGx, centerGz),
      tier: 1,
      index: 0,
    });
  }

  // Place remaining nuclei by niche scoring
  const maxAttempts = map.width * map.height;
  const candidates = [];

  for (let gz = 3; gz < map.height - 3; gz++) {
    for (let gx = 3; gx < map.width - 3; gx++) {
      const b = map.buildability.get(gx, gz);
      if (b < 0.2) continue;

      let minDistToExisting = Infinity;
      for (const n of nuclei) {
        const d = distance2D(gx, gz, n.gx, n.gz);
        if (d < minDistToExisting) minDistToExisting = d;
      }

      if (minDistToExisting < minSpacing) continue;

      const spacingBonus = Math.min(1, minDistToExisting / 30);
      const score = 0.5 * b + 0.5 * spacingBonus;

      candidates.push({ gx, gz, score });
    }
  }

  // Sort by score descending, pick top candidates
  candidates.sort((a, b) => b.score - a.score);

  for (const c of candidates) {
    if (nuclei.length >= cap) break;

    // Re-check spacing against all placed nuclei
    let tooClose = false;
    for (const n of nuclei) {
      if (distance2D(c.gx, c.gz, n.gx, n.gz) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    nuclei.push({
      gx: c.gx,
      gz: c.gz,
      type: classifyNucleus(map, c.gx, c.gz),
      tier: nuclei.length < 3 ? 2 : (nuclei.length < 6 ? 3 : 4),
      index: nuclei.length,
    });
  }

  return nuclei;
}

/**
 * Classify nucleus type based on surrounding terrain.
 */
function classifyNucleus(map, gx, gz) {
  // 1. Adjacent to water?
  const waterRadius = 5;
  for (let dz = -waterRadius; dz <= waterRadius; dz++) {
    for (let dx = -waterRadius; dx <= waterRadius; dx++) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (nx >= 0 && nx < map.width && nz >= 0 && nz < map.height) {
        if (map.waterMask.get(nx, nz) > 0) return 'waterfront';
      }
    }
  }

  // 2. Road junction? (3+ directions within 5 cells)
  let roadDirs = 0;
  const checkRadius = 5;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let r = 1; r <= checkRadius; r++) {
      const nx = gx + dx * r;
      const nz = gz + dz * r;
      if (nx >= 0 && nx < map.width && nz >= 0 && nz < map.height) {
        if (map.roadGrid.get(nx, nz) > 0) { roadDirs++; break; }
      }
    }
  }
  if (roadDirs >= 3) return 'market';

  // 3. Elevated + slope?
  const windowSize = 2;
  let avgElev = 0, avgSlope = 0, count = 0;
  for (let dz = -windowSize; dz <= windowSize; dz++) {
    for (let dx = -windowSize; dx <= windowSize; dx++) {
      const nx = gx + dx, nz = gz + dz;
      if (nx >= 0 && nx < map.width && nz >= 0 && nz < map.height) {
        avgElev += map.elevation.get(nx, nz);
        avgSlope += map.slope.get(nx, nz);
        count++;
      }
    }
  }
  avgElev /= count;
  avgSlope /= count;

  // Compare to global average
  let globalAvgElev = 0;
  let globalCount = 0;
  for (let gz2 = 0; gz2 < map.height; gz2 += 5) {
    for (let gx2 = 0; gx2 < map.width; gx2 += 5) {
      globalAvgElev += map.elevation.get(gx2, gz2);
      globalCount++;
    }
  }
  globalAvgElev /= globalCount;

  if (avgElev > globalAvgElev + 5 && avgSlope > 0.05) return 'hilltop';
  if (avgElev < globalAvgElev - 5 && avgSlope < 0.05) return 'valley';

  // 5. On existing road?
  if (map.roadGrid.get(gx, gz) > 0) return 'roadside';

  return 'suburban';
}

/**
 * Import regional roads as anchor routes onto the city map.
 */
function importAnchorRoutes(map, layers) {
  const roads = layers.getData('roads');
  if (!roads || roads.length === 0) {
    // Fallback: no regional roads cross city
    _generateFallbackRoads(map);
    return;
  }

  const params = layers.getData('params');
  const regionalCellSize = params.cellSize;

  // Filter to roads that cross the city area
  const cityMinX = map.originX;
  const cityMinZ = map.originZ;
  const cityMaxX = map.originX + map.width * map.cellSize;
  const cityMaxZ = map.originZ + map.height * map.cellSize;

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

  if (relevantRoads.length === 0) {
    _generateFallbackRoads(map);
    return;
  }

  // Sort by hierarchy (arterials first)
  const hierRank = { arterial: 1, collector: 2, local: 3, track: 4 };
  relevantRoads.sort((a, b) => (hierRank[a.hierarchy] || 3) - (hierRank[b.hierarchy] || 3));

  // Re-pathfind each road at city resolution with shared cost
  const costFn = map.createPathCost('anchor');

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

    // Skip very short routes
    if (distance2D(startPt.gx, startPt.gz, endPt.gx, endPt.gz) < 5) continue;

    const result = findPath(
      startPt.gx, startPt.gz,
      endPt.gx, endPt.gz,
      map.width, map.height,
      costFn
    );

    if (!result) continue;

    const simplified = simplifyPath(result.path, 1.5);
    const smoothed = smoothPath(simplified, map.cellSize, 2);

    // Determine width and hierarchy from importance
    const importance = road.hierarchy === 'arterial' ? 0.9 :
                       road.hierarchy === 'collector' ? 0.6 : 0.45;
    const width = 6 + importance * 10;

    // Add road nodes + edges to graph
    const roadFeature = map.addFeature('road', {
      polyline: smoothed,
      width,
      hierarchy: road.hierarchy || 'local',
      importance,
      source: 'anchor',
    });

    // Add to PlanarGraph
    _addRoadToGraph(map, smoothed, width, road.hierarchy || 'local');
  }
}

/**
 * Generate fallback roads when no regional roads cross the city.
 */
function _generateFallbackRoads(map) {
  const cx = Math.floor(map.width / 2);
  const cz = Math.floor(map.height / 2);
  const margin = 5;
  const costFn = map.createPathCost('anchor');

  // Two roads from center to random margins
  const targets = [
    { gx: margin, gz: Math.floor(map.height / 2) },
    { gx: map.width - margin, gz: Math.floor(map.height / 2) },
  ];

  for (const target of targets) {
    const result = findPath(cx, cz, target.gx, target.gz, map.width, map.height, costFn);
    if (!result) continue;

    const simplified = simplifyPath(result.path, 1.5);
    const smoothed = smoothPath(simplified, map.cellSize, 2);

    map.addFeature('road', {
      polyline: smoothed,
      width: 12,
      hierarchy: 'collector',
      importance: 0.6,
      source: 'fallback',
    });

    _addRoadToGraph(map, smoothed, 12, 'collector');
  }
}

/**
 * Connect nuclei to each other and to the road network via MST.
 */
function connectNuclei(map, nuclei) {
  if (nuclei.length < 2) return;

  // Attach each nucleus to nearest road node
  for (const nucleus of nuclei) {
    const wx = map.originX + nucleus.gx * map.cellSize;
    const wz = map.originZ + nucleus.gz * map.cellSize;
    const nearest = map.graph.nearestNode(wx, wz);
    if (nearest) {
      nucleus.nearestNodeId = nearest.id;
      nucleus.nearestNodeDist = nearest.dist;
    }
  }

  // Union-Find for connectivity
  const uf = new UnionFind(nuclei.length);

  // Check existing connectivity via graph BFS
  for (let i = 0; i < nuclei.length; i++) {
    for (let j = i + 1; j < nuclei.length; j++) {
      if (nuclei[i].nearestNodeId != null && nuclei[j].nearestNodeId != null) {
        const pathLen = map.graph.shortestPathLength(nuclei[i].nearestNodeId, nuclei[j].nearestNodeId);
        if (isFinite(pathLen)) {
          uf.union(i, j);
        }
      }
    }
  }

  // Kruskal's MST on inter-component edges
  const edges = [];
  for (let i = 0; i < nuclei.length; i++) {
    for (let j = i + 1; j < nuclei.length; j++) {
      if (uf.connected(i, j)) continue;
      const d = distance2D(nuclei[i].gx, nuclei[i].gz, nuclei[j].gx, nuclei[j].gz);
      edges.push({ i, j, cost: d });
    }
  }
  edges.sort((a, b) => a.cost - b.cost);

  const costFn = map.createPathCost('nucleus');

  for (const edge of edges) {
    if (uf.connected(edge.i, edge.j)) continue;

    const a = nuclei[edge.i];
    const b = nuclei[edge.j];

    const result = findPath(a.gx, a.gz, b.gx, b.gz, map.width, map.height, costFn);
    if (!result) continue;

    uf.union(edge.i, edge.j);

    const simplified = simplifyPath(result.path, 1.5);
    const smoothed = smoothPath(simplified, map.cellSize, 2);

    // Compute importance from tier weights
    const pairWeight = (importanceTierWeight(a.tier) + importanceTierWeight(b.tier)) / 2;
    const maxLen = Math.sqrt(map.width ** 2 + map.height ** 2) * map.cellSize;
    const lengthWeight = Math.min(1, (result.cost * map.cellSize) / maxLen);
    const importance = Math.min(1, 0.4 * pairWeight + 0.3 * lengthWeight + 0.3); // bridgeWeight=1 for MST

    const hierarchy = importance > 0.7 ? 'arterial' : importance > 0.4 ? 'collector' : 'local';
    const width = 6 + importance * 10;

    map.addFeature('road', {
      polyline: smoothed,
      width,
      hierarchy,
      importance,
      source: 'mst',
    });

    _addRoadToGraph(map, smoothed, width, hierarchy);
  }

  // Safety net: connect remaining isolated components
  if (uf.componentCount() > 1) {
    const components = uf.components();
    const compList = [...components.values()];

    for (let i = 1; i < compList.length; i++) {
      const aIdx = compList[0][0];
      const bIdx = compList[i][0];
      const a = nuclei[aIdx];
      const b = nuclei[bIdx];

      const result = findPath(a.gx, a.gz, b.gx, b.gz, map.width, map.height, costFn);
      if (result) {
        uf.union(aIdx, bIdx);
        const simplified = simplifyPath(result.path, 1.5);
        const smoothed = smoothPath(simplified, map.cellSize, 2);

        map.addFeature('road', {
          polyline: smoothed,
          width: 8,
          hierarchy: 'local',
          importance: 0.3,
          source: 'safety-net',
        });

        _addRoadToGraph(map, smoothed, 8, 'local');
      }
    }
  }
}

/**
 * Add a smoothed road polyline to the PlanarGraph.
 * Creates nodes at endpoints and intermediate junctions.
 */
function _addRoadToGraph(map, polyline, width, hierarchy) {
  if (polyline.length < 2) return;

  const graph = map.graph;
  const snapDist = map.cellSize * 1.5;

  // Find or create start/end nodes
  const startPt = polyline[0];
  const endPt = polyline[polyline.length - 1];

  const startNodeId = _findOrCreateNode(graph, startPt.x, startPt.z, snapDist);
  const endNodeId = _findOrCreateNode(graph, endPt.x, endPt.z, snapDist);

  if (startNodeId === endNodeId) return;

  // Intermediate points (excluding endpoints)
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
