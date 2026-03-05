/**
 * A7. Regional road generation.
 * Routes roads between settlements using terrain-weighted A* pathfinding.
 * Roads follow valleys, cross rivers at narrow points, pass through highland passes.
 */

import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';

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

  // Build connections by tier hierarchy
  const connections = buildConnections(settlements, width);

  // In incremental mode, skip connections that already exist
  const existingRoads = options.existingRoads || [];
  const existingPairs = new Set();
  for (const road of existingRoads) {
    const keyFwd = `${road.from.gx},${road.from.gz}-${road.to.gx},${road.to.gz}`;
    const keyRev = `${road.to.gx},${road.to.gz}-${road.from.gx},${road.from.gz}`;
    existingPairs.add(keyFwd);
    existingPairs.add(keyRev);
  }

  // Sort: arterials first so the trunk network exists before feeders pathfind
  connections.sort((a, b) => {
    const order = { arterial: 0, collector: 1, local: 2 };
    return (order[a.hierarchy] ?? 3) - (order[b.hierarchy] ?? 3);
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
 * Build connection list using K-nearest-neighbor approach.
 * Each settlement connects to its closest neighbors. Hierarchy is determined
 * by the tiers of the endpoints. Pairs are deduplicated.
 */
function buildConnections(settlements, gridWidth) {
  // Only connect settlements that should have roads (tier <= 4)
  const routable = settlements.filter(s => s.tier <= 4);
  if (routable.length < 2) return [];

  // How many neighbors each tier connects to
  const neighborsForTier = { 1: 5, 2: 4, 3: 3, 4: 2 };
  // Max distance for connections by tier
  const maxDistForTier = {
    1: gridWidth * 0.8,
    2: gridWidth * 0.5,
    3: gridWidth * 0.3,
    4: 30,
  };

  const pairSet = new Set();
  const connections = [];

  function addConnection(a, b) {
    // Deduplicate: use sorted coordinate pair as key
    const keyA = `${a.gx},${a.gz}`;
    const keyB = `${b.gx},${b.gz}`;
    const pairKey = keyA < keyB ? `${keyA}-${keyB}` : `${keyB}-${keyA}`;
    if (pairSet.has(pairKey)) return;
    pairSet.add(pairKey);

    // Hierarchy based on the highest (most important) tier of the pair
    const minTier = Math.min(a.tier, b.tier);
    let hierarchy;
    if (minTier <= 2) hierarchy = 'arterial';
    else if (minTier === 3) hierarchy = 'collector';
    else hierarchy = 'local';

    connections.push({ from: a, to: b, hierarchy });
  }

  // For each settlement, connect to K nearest neighbors
  for (const s of routable) {
    const k = neighborsForTier[s.tier] ?? 2;
    const maxDist = maxDistForTier[s.tier] ?? 30;

    // Find K nearest from all routable settlements
    const candidates = routable
      .filter(c => c !== s)
      .map(c => ({ settlement: c, dist: distance2D(s.gx, s.gz, c.gx, c.gz) }))
      .filter(c => c.dist <= maxDist)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k);

    for (const c of candidates) {
      addConnection(s, c.settlement);
    }
  }

  return connections;
}
