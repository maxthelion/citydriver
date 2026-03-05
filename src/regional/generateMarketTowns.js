/**
 * A6c. Road-attracted settlement placement.
 * After roads exist, place market towns at good locations along arterials.
 * Also promote hamlets that sit on arterial routes.
 */

import { Grid2D } from '../core/Grid2D.js';
import { distance2D } from '../core/math.js';
import { scoreCell, respectsSpacing } from './generateSettlements.js';

/**
 * Build a road proximity grid: each cell stores distance to nearest road cell.
 */
function buildRoadProximityGrid(roads, width, height) {
  const roadDist = new Grid2D(width, height, { type: 'float32', fill: 999 });

  // Stamp road cells at distance 0, then BFS outward
  const queue = [];
  for (const road of roads) {
    const path = road.rawPath || road.path;
    for (const p of path) {
      if (p.gx >= 0 && p.gx < width && p.gz >= 0 && p.gz < height) {
        if (roadDist.get(p.gx, p.gz) > 0) {
          roadDist.set(p.gx, p.gz, 0);
          queue.push(p.gx, p.gz);
        }
      }
    }
  }

  // BFS to radius 15
  const maxDist = 15;
  let head = 0;
  while (head < queue.length) {
    const cx = queue[head++];
    const cz = queue[head++];
    const cd = roadDist.get(cx, cz);
    if (cd >= maxDist) continue;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
        const nd = cd + (dx !== 0 && dz !== 0 ? 1.414 : 1.0);
        if (nd < roadDist.get(nx, nz)) {
          roadDist.set(nx, nz, nd);
          queue.push(nx, nz);
        }
      }
    }
  }

  return roadDist;
}

/**
 * @param {object} params
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {import('../core/Grid2D.js').Grid2D} slope
 * @param {import('../core/Grid2D.js').Grid2D} soilFertility
 * @param {Array} settlements - All existing settlements (tier 1-5)
 * @param {Array} roads - From generateRoads()
 * @param {object} proximityGrids - From buildProximityGrids()
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [extras]
 * @returns {{ newTowns: Array, promotions: Array<{settlement, newTier}> }}
 */
export function generateMarketTowns(params, elevation, slope, soilFertility, settlements, roads, proximityGrids, rng, extras) {
  const {
    width,
    height,
    cellSize = 50,
  } = params;

  const roadDist = buildRoadProximityGrid(roads, width, height);
  const minSpacingFromTowns = 15; // Min distance from tier 1-3
  const minSpacingFromEachOther = 10;
  const maxMarketTowns = 6;

  const tier1to3 = settlements.filter(s => s.tier <= 3);

  // Score candidates: land quality + road proximity bonus
  const candidates = [];
  for (let gz = 3; gz < height - 3; gz += 2) { // Sample every 2 for speed
    for (let gx = 3; gx < width - 3; gx += 2) {
      const rd = roadDist.get(gx, gz);
      if (rd > 3) continue; // Must be near a road

      const landScore = scoreCell(gx, gz, params, elevation, slope, soilFertility, proximityGrids, extras);
      if (landScore < 0.15) continue; // Minimum land quality

      // Road proximity bonus: closer = better
      const roadBonus = Math.max(0, (3 - rd) / 3) * 0.4;

      // Bonus for being between two settlements (midpoint of a trade route)
      let betweennessBonus = 0;
      for (let i = 0; i < tier1to3.length; i++) {
        for (let j = i + 1; j < tier1to3.length; j++) {
          const a = tier1to3[i];
          const b = tier1to3[j];
          const distAB = distance2D(a.gx, a.gz, b.gx, b.gz);
          const distAC = distance2D(a.gx, a.gz, gx, gz);
          const distBC = distance2D(b.gx, b.gz, gx, gz);
          // Check if roughly on the path between A and B
          const detour = (distAC + distBC) / Math.max(1, distAB);
          if (detour < 1.3 && distAC > 8 && distBC > 8) {
            betweennessBonus = Math.max(betweennessBonus, 0.3 * (1.3 - detour) / 0.3);
          }
        }
      }

      const totalScore = landScore + roadBonus + betweennessBonus;
      candidates.push({ gx, gz, score: totalScore, landScore });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Place market towns
  const newTowns = [];
  for (const c of candidates) {
    if (newTowns.length >= maxMarketTowns) break;

    // Must be far enough from existing tier 1-3
    if (!respectsSpacing(c.gx, c.gz, tier1to3, minSpacingFromTowns)) continue;
    // And from other new market towns
    if (!respectsSpacing(c.gx, c.gz, newTowns, minSpacingFromEachOther)) continue;

    newTowns.push({
      gx: c.gx,
      gz: c.gz,
      x: c.gx * cellSize,
      z: c.gz * cellSize,
      tier: 3,
      score: c.score,
      type: 'market',
    });
  }

  // Promote hamlets on arterial routes to villages
  const promotions = [];
  const arterialRoads = roads.filter(r => r.hierarchy === 'arterial');
  for (const s of settlements) {
    if (s.tier !== 4) continue; // Only promote hamlets

    // Check if near an arterial road
    let nearArterial = false;
    for (const road of arterialRoads) {
      const path = road.rawPath || road.path;
      for (const p of path) {
        if (distance2D(s.gx, s.gz, p.gx, p.gz) < 2) {
          nearArterial = true;
          break;
        }
      }
      if (nearArterial) break;
    }

    if (nearArterial) {
      promotions.push({ settlement: s, newTier: 3 });
    }
  }

  return { newTowns, promotions };
}
