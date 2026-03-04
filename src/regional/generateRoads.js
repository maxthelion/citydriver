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
 * @returns {Array<{from, to, path, hierarchy}>}
 */
export function generateRoads(params, settlements, elevation, slope, waterMask, rng) {
  const {
    width,
    height,
    cellSize = 50,
  } = params;

  if (!settlements || settlements.length < 2) return [];

  const costFn = terrainCostFunction(elevation, {
    slopePenalty: 15,
    waterGrid: waterMask,
    waterPenalty: 50, // roads can cross water (bridges) but at cost
    edgeMargin: 3,
    edgePenalty: 3,
  });

  // Track existing road cells so later roads prefer sharing established routes
  const roadGrid = new Grid2D(width, height, { type: 'uint8' });

  const roadAwareCost = (fromGx, fromGz, toGx, toGz) => {
    const base = costFn(fromGx, fromGz, toGx, toGz);
    if (base < 0) return base; // impassable
    return roadGrid.get(toGx, toGz) > 0 ? base * 0.3 : base;
  };

  // Build connections: connect settlements by hierarchy
  // Tier 1 connects to all tier 2, tier 2 connects to nearby tier 3
  const connections = [];
  const tier1 = settlements.filter(s => s.tier === 1);
  const tier2 = settlements.filter(s => s.tier === 2);
  const tier3 = settlements.filter(s => s.tier === 3);

  // Connect tier 1 to all tier 2
  for (const a of tier1) {
    for (const b of tier2) {
      connections.push({ from: a, to: b, hierarchy: 'arterial' });
    }
  }

  // Connect tier 2 to each other if within range
  for (let i = 0; i < tier2.length; i++) {
    for (let j = i + 1; j < tier2.length; j++) {
      const dist = distance2D(tier2[i].gx, tier2[i].gz, tier2[j].gx, tier2[j].gz);
      if (dist < width * 0.6) {
        connections.push({ from: tier2[i], to: tier2[j], hierarchy: 'arterial' });
      }
    }
  }

  // Connect tier 3 to nearest higher-tier settlement
  for (const village of tier3) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const town of [...tier1, ...tier2]) {
      const d = distance2D(village.gx, village.gz, town.gx, town.gz);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = town;
      }
    }
    if (nearest) {
      connections.push({ from: village, to: nearest, hierarchy: 'collector' });
    }
  }

  // Sort: arterials first so the trunk network exists before feeders pathfind
  connections.sort((a, b) => {
    const order = { arterial: 0, collector: 1 };
    return (order[a.hierarchy] ?? 2) - (order[b.hierarchy] ?? 2);
  });

  // Find paths
  const roads = [];
  for (const conn of connections) {
    const result = findPath(
      conn.from.gx, conn.from.gz,
      conn.to.gx, conn.to.gz,
      width, height, roadAwareCost,
    );

    if (result) {
      // Stamp raw path cells onto roadGrid before simplification
      for (const p of result.path) {
        roadGrid.set(p.gx, p.gz, 1);
      }

      const simplified = simplifyPath(result.path, 1.5);
      roads.push({
        from: { gx: conn.from.gx, gz: conn.from.gz },
        to: { gx: conn.to.gx, gz: conn.to.gz },
        path: simplified,
        hierarchy: conn.hierarchy,
        cost: result.cost,
      });
    }
  }

  return roads;
}
