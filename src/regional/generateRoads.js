/**
 * A7. Regional road generation.
 * Routes roads between settlements using terrain-weighted A* pathfinding.
 * Roads follow valleys, cross rivers at narrow points, pass through highland passes.
 *
 * Connection logic uses a phased algorithm with Union-Find to guarantee
 * full connectivity:
 *   Phase 1: Nearest neighbor (zero isolates)
 *   Phase 2: Local neighborhood (K-nearest + proximity)
 *   Phase 3: Cluster identification
 *   Phase 4: Inter-cluster bridging (Kruskal's MST + extras)
 *   Phase 5: Backbone verification (all tier 1-2 connected)
 *   Phase 6: Tier 5 farm tracks
 */

import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';
import { UnionFind } from '../core/UnionFind.js';

/**
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.cellSize=50]
 * @param {Array} settlements - [{gx, gz, tier}]
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {import('../core/Grid2D.js').Grid2D} slope
 * @param {import('../core/Grid2D.js').Grid2D} waterMask
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [options]
 * @param {Grid2D} [options.existingRoadGrid] - Road grid from previous pass (for incremental mode)
 * @param {Array} [options.existingRoads] - Roads from previous pass (for incremental mode)
 * @returns {{ roads: Array<{from, to, path, hierarchy}>, roadGrid: Grid2D }}
 */
export function generateRoads(params, settlements, elevation, slope, waterMask, rng, options = {}) {
  const {
    width,
    height,
    cellSize = 50,
  } = params;

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

  // Track existing road cells so later roads prefer sharing established routes
  const roadGrid = options.existingRoadGrid
    ? options.existingRoadGrid.clone()
    : new Grid2D(width, height, { type: 'uint8' });

  const roadAwareCost = (fromGx, fromGz, toGx, toGz) => {
    const base = costFn(fromGx, fromGz, toGx, toGz);
    if (base < 0) return base;
    return roadGrid.get(toGx, toGz) > 0 ? base * 0.3 : base;
  };

  // Build connections using phased algorithm
  const connections = buildConnections(settlements, width, elevation);

  // In incremental mode, skip connections that already exist
  const existingRoads = options.existingRoads || [];
  const existingPairs = new Set();
  for (const road of existingRoads) {
    const keyFwd = `${road.from.gx},${road.from.gz}-${road.to.gx},${road.to.gz}`;
    const keyRev = `${road.to.gx},${road.to.gz}-${road.from.gx},${road.from.gz}`;
    existingPairs.add(keyFwd);
    existingPairs.add(keyRev);
  }

  // Sort: arterials first so the trunk network exists before feeders pathfind.
  // Within each hierarchy, shorter roads first so they stamp the roadGrid
  // early and attract longer roads to merge through them.
  const hierarchyOrder = { arterial: 0, collector: 1, local: 2, track: 3 };
  connections.sort((a, b) => {
    const hDiff = (hierarchyOrder[a.hierarchy] ?? 3) - (hierarchyOrder[b.hierarchy] ?? 3);
    if (hDiff !== 0) return hDiff;
    const distA = distance2D(a.from.gx, a.from.gz, a.to.gx, a.to.gz);
    const distB = distance2D(b.from.gx, b.from.gz, b.to.gx, b.to.gz);
    return distA - distB;
  });

  // Find paths
  const roads = [...existingRoads];
  for (const conn of connections) {
    const pairKey = `${conn.from.gx},${conn.from.gz}-${conn.to.gx},${conn.to.gz}`;
    if (existingPairs.has(pairKey)) continue;

    const result = findPath(
      conn.from.gx, conn.from.gz,
      conn.to.gx, conn.to.gz,
      width, height, roadAwareCost,
    );

    if (result) {
      for (const p of result.path) {
        roadGrid.set(p.gx, p.gz, 1);
      }

      const simplified = simplifyPath(result.path, 1.5);
      roads.push({
        from: { gx: conn.from.gx, gz: conn.from.gz },
        to: { gx: conn.to.gx, gz: conn.to.gz },
        path: simplified,
        rawPath: result.path,
        hierarchy: conn.hierarchy,
        cost: result.cost,
      });
    }
  }

  return { roads, roadGrid };
}

/**
 * Estimate how difficult it is to cross terrain between two points.
 * Samples elevation along the straight line and penalizes high points and ascent.
 * Used to find mountain passes — prefers pairs crossing through saddles.
 */
function estimateCrossingDifficulty(a, b, elevation) {
  const dist = distance2D(a.gx, a.gz, b.gx, b.gz);
  if (dist < 1) return dist;

  const steps = Math.ceil(dist);
  let maxElev = 0;
  let totalAscent = 0;
  let prevElev = elevation.get(a.gx, a.gz);

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

  // Assign each settlement a stable index for Union-Find
  const uf = new UnionFind(routable.length);
  const indexMap = new Map(); // "gx,gz" -> index
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

    // Update Union-Find
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

  // --- Phase 1: Nearest neighbor guarantee ---
  // Every settlement connects to its single nearest neighbor. Zero isolates.
  for (let i = 0; i < routable.length; i++) {
    let nearestIdx = -1;
    let nearestDist = Infinity;
    for (let j = 0; j < routable.length; j++) {
      if (i === j) continue;
      const d = distance2D(routable[i].gx, routable[i].gz, routable[j].gx, routable[j].gz);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = j;
      }
    }
    if (nearestIdx >= 0) {
      addConnection(routable[i], routable[nearestIdx], assignHierarchy(routable[i], routable[nearestIdx]));
    }
  }

  // --- Phase 2: Local neighborhood (K-nearest + proximity) ---
  const neighborsForTier = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 };
  const maxDistForTier = {
    1: gridWidth * 0.8,
    2: gridWidth * 0.5,
    3: gridWidth * 0.3,
    4: 30,
    5: 12,
  };

  // Proximity guarantee: close pairs always connected
  const proximityThreshold = 15;
  for (let i = 0; i < routable.length; i++) {
    for (let j = i + 1; j < routable.length; j++) {
      const dist = distance2D(routable[i].gx, routable[i].gz, routable[j].gx, routable[j].gz);
      if (dist <= proximityThreshold) {
        addConnection(routable[i], routable[j], assignHierarchy(routable[i], routable[j]));
      }
    }
  }

  // K-nearest per tier
  for (const s of routable) {
    const k = neighborsForTier[s.tier] ?? 2;
    const maxDist = maxDistForTier[s.tier] ?? 30;

    const candidates = routable
      .filter(c => c !== s)
      .map(c => ({ settlement: c, dist: distance2D(s.gx, s.gz, c.gx, c.gz) }))
      .filter(c => c.dist <= maxDist)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k);

    for (const c of candidates) {
      addConnection(s, c.settlement, assignHierarchy(s, c.settlement));
    }
  }

  // --- Phase 3: Cluster identification ---
  const componentMap = uf.components();
  const clusters = [];
  const importanceWeights = { 1: 10, 2: 5, 3: 3, 4: 1, 5: 0.5 };

  for (const [root, memberIndices] of componentMap) {
    const members = memberIndices.map(i => routable[i]);
    let cx = 0, cz = 0, importance = 0, highestTier = 5;
    for (const m of members) {
      cx += m.gx;
      cz += m.gz;
      importance += importanceWeights[m.tier] ?? 1;
      if (m.tier < highestTier) highestTier = m.tier;
    }
    clusters.push({
      root,
      members,
      count: members.length,
      highestTier,
      importance,
      centroid: { gx: cx / members.length, gz: cz / members.length },
    });
  }

  // If only one cluster, skip bridging
  if (clusters.length <= 1) return connections;

  // --- Phase 4: Inter-cluster bridging ---
  // For each pair of clusters, find the best crossing point (lowest difficulty)
  const clusterPairs = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const ci = clusters[i];
      const cj = clusters[j];

      // Find the settlement pair with lowest crossing difficulty
      let bestDifficulty = Infinity;
      let bestA = null, bestB = null;
      for (const a of ci.members) {
        for (const b of cj.members) {
          const diff = estimateCrossingDifficulty(a, b, elevation);
          if (diff < bestDifficulty) {
            bestDifficulty = diff;
            bestA = a;
            bestB = b;
          }
        }
      }

      if (bestA && bestB) {
        clusterPairs.push({
          ci, cj,
          bestA, bestB,
          difficulty: bestDifficulty,
        });
      }
    }
  }

  clusterPairs.sort((a, b) => a.difficulty - b.difficulty);

  // MST pass: bridge all clusters into one component
  const clusterUf = new UnionFind(clusters.length);
  const clusterIndexMap = new Map();
  for (let i = 0; i < clusters.length; i++) {
    clusterIndexMap.set(clusters[i].root, i);
  }

  // Track outbound bridge count per cluster
  const bridgeCount = new Array(clusters.length).fill(0);

  for (const pair of clusterPairs) {
    const idxI = clusterIndexMap.get(pair.ci.root);
    const idxJ = clusterIndexMap.get(pair.cj.root);

    if (clusterUf.connected(idxI, idxJ)) continue;

    // Bridge hierarchy: upgrade for important clusters
    const combinedImportance = pair.ci.importance + pair.cj.importance;
    const bothHaveMajor = pair.ci.highestTier <= 2 && pair.cj.highestTier <= 2;
    let hierarchy;
    if (bothHaveMajor) hierarchy = 'arterial';
    else if (combinedImportance >= 6) hierarchy = 'collector';
    else hierarchy = 'collector'; // bridges are at least collector

    addConnection(pair.bestA, pair.bestB, hierarchy);
    clusterUf.union(idxI, idxJ);
    bridgeCount[idxI]++;
    bridgeCount[idxJ]++;
  }

  // Extra bridges for large/important clusters (beyond MST)
  function maxBridges(cluster) {
    if (cluster.highestTier <= 2 || cluster.count >= 6) return 3;
    if (cluster.count >= 3) return 2;
    return 1;
  }

  for (const pair of clusterPairs) {
    const idxI = clusterIndexMap.get(pair.ci.root);
    const idxJ = clusterIndexMap.get(pair.cj.root);

    // Skip if already connected in this pair (MST already bridged them)
    const keyA = `${pair.bestA.gx},${pair.bestA.gz}`;
    const keyB = `${pair.bestB.gx},${pair.bestB.gz}`;
    const pairKey = keyA < keyB ? `${keyA}-${keyB}` : `${keyB}-${keyA}`;
    if (pairSet.has(pairKey)) continue;

    // Check bridge limits
    if (bridgeCount[idxI] >= maxBridges(pair.ci)) continue;
    if (bridgeCount[idxJ] >= maxBridges(pair.cj)) continue;

    const combinedImportance = pair.ci.importance + pair.cj.importance;
    const bothHaveMajor = pair.ci.highestTier <= 2 && pair.cj.highestTier <= 2;
    let hierarchy;
    if (bothHaveMajor) hierarchy = 'arterial';
    else if (combinedImportance >= 6) hierarchy = 'collector';
    else hierarchy = 'collector';

    addConnection(pair.bestA, pair.bestB, hierarchy);
    bridgeCount[idxI]++;
    bridgeCount[idxJ]++;
  }

  // --- Phase 5: Backbone verification ---
  // Ensure all tier 1-2 are in one component
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

  // --- Phase 6: Farm tracks ---
  // Ensure tier 5 farms all have at least one connection (phase 1 should
  // have handled this, but be defensive)
  for (let i = 0; i < routable.length; i++) {
    if (routable[i].tier !== 5) continue;
    const key = `${routable[i].gx},${routable[i].gz}`;
    let hasConnection = false;
    for (const pk of pairSet) {
      if (pk.includes(key)) { hasConnection = true; break; }
    }
    if (!hasConnection) {
      // Connect to nearest anything
      let nearestIdx = -1;
      let nearestDist = Infinity;
      for (let j = 0; j < routable.length; j++) {
        if (i === j) continue;
        const d = distance2D(routable[i].gx, routable[i].gz, routable[j].gx, routable[j].gz);
        if (d < nearestDist) { nearestDist = d; nearestIdx = j; }
      }
      if (nearestIdx >= 0) {
        addConnection(routable[i], routable[nearestIdx], 'track');
      }
    }
  }

  return connections;
}
