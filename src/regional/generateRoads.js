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
 * Build connection list from settlements based on tier hierarchy.
 */
function buildConnections(settlements, gridWidth) {
  const connections = [];
  const tier1 = settlements.filter(s => s.tier === 1);
  const tier2 = settlements.filter(s => s.tier === 2);
  const tier3 = settlements.filter(s => s.tier === 3);
  const tier4 = settlements.filter(s => s.tier === 4);

  // Tier 1 to all tier 2 (arterial)
  for (const a of tier1) {
    for (const b of tier2) {
      connections.push({ from: a, to: b, hierarchy: 'arterial' });
    }
  }

  // Tier 2 to each other if within range (arterial)
  for (let i = 0; i < tier2.length; i++) {
    for (let j = i + 1; j < tier2.length; j++) {
      const dist = distance2D(tier2[i].gx, tier2[i].gz, tier2[j].gx, tier2[j].gz);
      if (dist < gridWidth * 0.6) {
        connections.push({ from: tier2[i], to: tier2[j], hierarchy: 'arterial' });
      }
    }
  }

  // Tier 3 to nearest higher-tier (collector)
  const higherTier = [...tier1, ...tier2];
  for (const village of tier3) {
    const nearest = findNearest(village, higherTier);
    if (nearest) {
      connections.push({ from: village, to: nearest, hierarchy: 'collector' });
    }
  }

  // Tier 4 (hamlets) to nearest settlement of any tier within range (local)
  const allHigher = [...tier1, ...tier2, ...tier3];
  for (const hamlet of tier4) {
    const nearest = findNearest(hamlet, allHigher, 40); // Max 40 cells
    if (nearest) {
      connections.push({ from: hamlet, to: nearest, hierarchy: 'local' });
    }
  }

  // Tier 5 (farms) get no roads — they're just map markers

  return connections;
}

function findNearest(settlement, candidates, maxDist = Infinity) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const c of candidates) {
    const d = distance2D(settlement.gx, settlement.gz, c.gx, c.gz);
    if (d < nearestDist && d < maxDist) {
      nearestDist = d;
      nearest = c;
    }
  }
  return nearest;
}
