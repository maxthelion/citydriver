/**
 * A7. Regional road generation.
 * Routes roads between settlements using terrain-weighted A* pathfinding.
 * Roads follow valleys, cross rivers at narrow points, pass through highland passes.
 *
 * After pathfinding, roads that share cells are merged via mergeRoadPaths:
 * shared portions are kept once (highest hierarchy), unique tails become
 * separate segments. Eliminates double lines where routes share a corridor.
 *
 * Connection logic uses a phased algorithm with Union-Find to guarantee
 * full connectivity.
 */

import { findPath, terrainCostFunction, simplifyPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';
import { UnionFind } from '../core/UnionFind.js';
import { mergeRoadPaths } from '../core/mergeRoadPaths.js';

const HIER_RANK = { arterial: 1, collector: 2, local: 3, track: 4 };
const RANK_HIER = { 1: 'arterial', 2: 'collector', 3: 'local', 4: 'track' };

/**
 * @param {object} params
 * @param {Array} settlements - [{gx, gz, tier}]
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {import('../core/Grid2D.js').Grid2D} slope
 * @param {import('../core/Grid2D.js').Grid2D} waterMask
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [options]
 * @returns {{ roads: Array<{from, to, path, hierarchy}>, roadGrid: Grid2D }}
 */
export function generateRoads(params, settlements, elevation, slope, waterMask, rng, options = {}) {
  const { width, height, cellSize = 50 } = params;

  if (!settlements || settlements.length < 2) {
    return { roads: options.existingRoads || [], roadGrid: options.existingRoadGrid || new Grid2D(width, height, { type: 'uint8' }) };
  }

  const costFn = terrainCostFunction(elevation, {
    slopePenalty: 15,
    waterGrid: waterMask,
    waterPenalty: 50,
    edgeMargin: 3,
    edgePenalty: 3,
  });

  const roadGrid = options.existingRoadGrid
    ? options.existingRoadGrid.clone()
    : new Grid2D(width, height, { type: 'uint8' });

  // Existing road cells get fixed low cost so new roads merge onto them
  const roadAwareCost = (fromGx, fromGz, toGx, toGz) => {
    const base = costFn(fromGx, fromGz, toGx, toGz);
    if (base < 0) return base;
    if (roadGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.3;
    }
    return base;
  };

  const connections = buildConnections(settlements, width, elevation);

  const existingRoads = options.existingRoads || [];
  const existingPairs = new Set();
  for (const road of existingRoads) {
    existingPairs.add(`${road.from.gx},${road.from.gz}-${road.to.gx},${road.to.gz}`);
    existingPairs.add(`${road.to.gx},${road.to.gz}-${road.from.gx},${road.from.gz}`);
  }

  // Sort: arterials first, then shorter roads first
  const hierarchyOrder = { arterial: 0, collector: 1, local: 2, track: 3 };
  connections.sort((a, b) => {
    const hDiff = (hierarchyOrder[a.hierarchy] ?? 3) - (hierarchyOrder[b.hierarchy] ?? 3);
    if (hDiff !== 0) return hDiff;
    return distance2D(a.from.gx, a.from.gz, a.to.gx, a.to.gz) -
           distance2D(b.from.gx, b.from.gz, b.to.gx, b.to.gz);
  });

  // ============================================================
  // Pathfind all connections, stamp onto roadGrid
  // ============================================================

  const rawPaths = []; // { cells, rank } for mergeRoadPaths

  // Include existing roads so the merge can split them at new junctions
  for (const road of existingRoads) {
    const cells = road.rawPath || road.path;
    if (cells && cells.length >= 2) {
      // All paths get rank 1 for uniform merge; hierarchy assigned post-merge
      rawPaths.push({ cells, rank: 1, hierarchy: road.hierarchy || 'local' });
    }
  }

  for (const conn of connections) {
    const pairKey = `${conn.from.gx},${conn.from.gz}-${conn.to.gx},${conn.to.gz}`;
    if (existingPairs.has(pairKey)) continue;

    const result = findPath(
      conn.from.gx, conn.from.gz,
      conn.to.gx, conn.to.gz,
      width, height, roadAwareCost,
    );

    if (result) {
      for (const p of result.path) roadGrid.set(p.gx, p.gz, 1);
      rawPaths.push({ cells: result.path, rank: 1, hierarchy: conn.hierarchy || 'local' });
    }
  }

  // ============================================================
  // Merge shared segments
  // ============================================================

  const merged = mergeRoadPaths(rawPaths);

  // Build cell → best hierarchy lookup from original paths
  const cellBestHier = new Map();
  for (const p of rawPaths) {
    const rank = HIER_RANK[p.hierarchy] || 4;
    for (const c of p.cells) {
      const key = `${c.gx},${c.gz}`;
      const prev = cellBestHier.get(key) || 9;
      if (rank < prev) cellBestHier.set(key, rank);
    }
  }

  const roads = [];
  for (const seg of merged) {
    if (seg.cells.length < 2) continue;
    const simplified = simplifyPath(seg.cells, 1.5);

    // Derive hierarchy from best original path that used these cells
    let bestRank = 9;
    for (const c of seg.cells) {
      const r = cellBestHier.get(`${c.gx},${c.gz}`) || 9;
      if (r < bestRank) bestRank = r;
    }

    roads.push({
      from: { gx: seg.cells[0].gx, gz: seg.cells[0].gz },
      to: { gx: seg.cells[seg.cells.length - 1].gx, gz: seg.cells[seg.cells.length - 1].gz },
      path: simplified,
      rawPath: seg.cells,
      hierarchy: RANK_HIER[bestRank] || 'local',
    });
  }

  return { roads, roadGrid };
}

// ============================================================
// Helpers
// ============================================================

function estimateCrossingDifficulty(a, b, elevation) {
  const dist = distance2D(a.gx, a.gz, b.gx, b.gz);
  if (dist < 1) return dist;
  const steps = Math.ceil(dist);
  let maxElev = 0, totalAscent = 0, prevElev = elevation.get(a.gx, a.gz);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const gx = Math.round(a.gx + (b.gx - a.gx) * t);
    const gz = Math.round(a.gz + (b.gz - a.gz) * t);
    const elev = elevation.get(
      Math.max(0, Math.min(elevation.width - 1, gx)),
      Math.max(0, Math.min(elevation.height - 1, gz)),
    );
    if (elev > maxElev) maxElev = elev;
    if (elev > prevElev) totalAscent += elev - prevElev;
    prevElev = elev;
  }
  return dist * (1 + maxElev / 100 + totalAscent / 200);
}

/**
 * Phased connection algorithm with Union-Find for guaranteed connectivity.
 */
function buildConnections(settlements, gridWidth, elevation) {
  const routable = settlements.filter(s => s.tier <= 5);
  if (routable.length < 2) return [];

  const uf = new UnionFind(routable.length);
  const indexMap = new Map();
  for (let i = 0; i < routable.length; i++) {
    indexMap.set(`${routable[i].gx},${routable[i].gz}`, i);
  }

  const pairSet = new Set();
  const connections = [];

  function addConnection(a, b, hierarchy) {
    const keyA = `${a.gx},${a.gz}`;
    const keyB = `${b.gx},${b.gz}`;
    const pairKey = keyA < keyB ? `${keyA}-${keyB}` : `${keyB}-${keyA}`;
    if (pairSet.has(pairKey)) return;
    pairSet.add(pairKey);
    connections.push({ from: a, to: b, hierarchy });
    const ia = indexMap.get(keyA);
    const ib = indexMap.get(keyB);
    if (ia !== undefined && ib !== undefined) uf.union(ia, ib);
  }

  function assignHierarchy(a, b) {
    const minTier = Math.min(a.tier, b.tier);
    const maxTier = Math.max(a.tier, b.tier);
    if (maxTier === 5 && minTier === 5) return 'track';
    if (maxTier === 5 && minTier === 4) return 'track';
    if (maxTier === 5) return 'local';
    if (minTier <= 2) return 'arterial';
    if (minTier === 3) return 'collector';
    return 'local';
  }

  // Phase 1: Nearest neighbor
  for (let i = 0; i < routable.length; i++) {
    let nearestIdx = -1, nearestDist = Infinity;
    for (let j = 0; j < routable.length; j++) {
      if (i === j) continue;
      const d = distance2D(routable[i].gx, routable[i].gz, routable[j].gx, routable[j].gz);
      if (d < nearestDist) { nearestDist = d; nearestIdx = j; }
    }
    if (nearestIdx >= 0) addConnection(routable[i], routable[nearestIdx], assignHierarchy(routable[i], routable[nearestIdx]));
  }

  // Phase 2: K-nearest + proximity
  const neighborsForTier = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 };
  const maxDistForTier = { 1: gridWidth * 0.8, 2: gridWidth * 0.5, 3: gridWidth * 0.3, 4: 30, 5: 12 };
  const proximityThreshold = 15;

  for (let i = 0; i < routable.length; i++) {
    for (let j = i + 1; j < routable.length; j++) {
      if (distance2D(routable[i].gx, routable[i].gz, routable[j].gx, routable[j].gz) <= proximityThreshold) {
        addConnection(routable[i], routable[j], assignHierarchy(routable[i], routable[j]));
      }
    }
  }

  for (const s of routable) {
    const k = neighborsForTier[s.tier] ?? 2;
    const maxDist = maxDistForTier[s.tier] ?? 30;
    const candidates = routable
      .filter(c => c !== s)
      .map(c => ({ settlement: c, dist: distance2D(s.gx, s.gz, c.gx, c.gz) }))
      .filter(c => c.dist <= maxDist)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k);
    for (const c of candidates) addConnection(s, c.settlement, assignHierarchy(s, c.settlement));
  }

  // Phase 3: Cluster identification
  const componentMap = uf.components();
  const clusters = [];
  const importanceWeights = { 1: 10, 2: 5, 3: 3, 4: 1, 5: 0.5 };

  for (const [root, memberIndices] of componentMap) {
    const members = memberIndices.map(i => routable[i]);
    let cx = 0, cz = 0, importance = 0, highestTier = 5;
    for (const m of members) {
      cx += m.gx; cz += m.gz;
      importance += importanceWeights[m.tier] ?? 1;
      if (m.tier < highestTier) highestTier = m.tier;
    }
    clusters.push({ root, members, count: members.length, highestTier, importance,
      centroid: { gx: cx / members.length, gz: cz / members.length } });
  }

  if (clusters.length <= 1) return connections;

  // Phase 4: Inter-cluster bridging
  const clusterPairs = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      let bestDiff = Infinity, bestA = null, bestB = null;
      for (const a of clusters[i].members) {
        for (const b of clusters[j].members) {
          const diff = estimateCrossingDifficulty(a, b, elevation);
          if (diff < bestDiff) { bestDiff = diff; bestA = a; bestB = b; }
        }
      }
      if (bestA && bestB) clusterPairs.push({ ci: clusters[i], cj: clusters[j], bestA, bestB, difficulty: bestDiff });
    }
  }
  clusterPairs.sort((a, b) => a.difficulty - b.difficulty);

  const clusterUf = new UnionFind(clusters.length);
  const clusterIndexMap = new Map();
  for (let i = 0; i < clusters.length; i++) clusterIndexMap.set(clusters[i].root, i);
  const bridgeCount = new Array(clusters.length).fill(0);

  for (const pair of clusterPairs) {
    const idxI = clusterIndexMap.get(pair.ci.root);
    const idxJ = clusterIndexMap.get(pair.cj.root);
    if (clusterUf.connected(idxI, idxJ)) continue;
    const bothMajor = pair.ci.highestTier <= 2 && pair.cj.highestTier <= 2;
    addConnection(pair.bestA, pair.bestB, bothMajor ? 'arterial' : 'collector');
    clusterUf.union(idxI, idxJ);
    bridgeCount[idxI]++; bridgeCount[idxJ]++;
  }

  function maxBridges(cluster) {
    if (cluster.highestTier <= 2 || cluster.count >= 6) return 3;
    if (cluster.count >= 3) return 2;
    return 1;
  }

  for (const pair of clusterPairs) {
    const idxI = clusterIndexMap.get(pair.ci.root);
    const idxJ = clusterIndexMap.get(pair.cj.root);
    const keyA = `${pair.bestA.gx},${pair.bestA.gz}`;
    const keyB = `${pair.bestB.gx},${pair.bestB.gz}`;
    const pk = keyA < keyB ? `${keyA}-${keyB}` : `${keyB}-${keyA}`;
    if (pairSet.has(pk)) continue;
    if (bridgeCount[idxI] >= maxBridges(pair.ci)) continue;
    if (bridgeCount[idxJ] >= maxBridges(pair.cj)) continue;
    const bothMajor = pair.ci.highestTier <= 2 && pair.cj.highestTier <= 2;
    addConnection(pair.bestA, pair.bestB, bothMajor ? 'arterial' : 'collector');
    bridgeCount[idxI]++; bridgeCount[idxJ]++;
  }

  // Phase 5: Backbone verification
  const majorIndices = [];
  for (let i = 0; i < routable.length; i++) {
    if (routable[i].tier <= 2) majorIndices.push(i);
  }
  if (majorIndices.length >= 2) {
    for (let i = 1; i < majorIndices.length; i++) {
      if (!uf.connected(majorIndices[0], majorIndices[i])) {
        addConnection(routable[majorIndices[0]], routable[majorIndices[i]], 'arterial');
      }
    }
  }

  // Phase 6: Farm tracks
  for (let i = 0; i < routable.length; i++) {
    if (routable[i].tier !== 5) continue;
    const key = `${routable[i].gx},${routable[i].gz}`;
    let has = false;
    for (const pk of pairSet) { if (pk.includes(key)) { has = true; break; } }
    if (!has) {
      let nearestIdx = -1, nearestDist = Infinity;
      for (let j = 0; j < routable.length; j++) {
        if (i === j) continue;
        const d = distance2D(routable[i].gx, routable[i].gz, routable[j].gx, routable[j].gz);
        if (d < nearestDist) { nearestDist = d; nearestIdx = j; }
      }
      if (nearestIdx >= 0) addConnection(routable[i], routable[nearestIdx], 'track');
    }
  }

  return connections;
}
