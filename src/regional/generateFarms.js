/**
 * A6b. Farm and hamlet placement.
 * Full scan of the region — place small settlements wherever land quality
 * is good enough. Farms are driven by fertility, flatness, and water access,
 * not coast proximity. A graduated proximity penalty spreads them evenly.
 */

import { distance2D } from '../core/math.js';
import { classifySite, respectsSpacing } from './generateSettlements.js';

/**
 * Score a cell for farm suitability. Different from the general settlement
 * scorer: emphasises fertility and flatness, ignores coast/harbor/defense.
 */
function scoreFarmCell(gx, gz, params, elevation, slope, soilFertility, proximityGrids) {
  const { width, height, seaLevel = 0 } = params;
  const { riverDist, springDist } = proximityGrids;

  const h = elevation.get(gx, gz);
  if (h < seaLevel) return 0;

  const s = slope.get(gx, gz);
  if (s > 0.2) return 0;

  // Neighborhood ruggedness — average slope in a 5-cell radius.
  // A flat cell on a mountain ridge surrounded by steep terrain is not farmable.
  let slopeSum = 0;
  let slopeCount = 0;
  let fertilitySum = 0;
  let fertilityCount = 0;
  const radius = 5;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      slopeSum += slope.get(nx, nz);
      slopeCount++;
      fertilitySum += soilFertility.get(nx, nz);
      fertilityCount++;
    }
  }
  const avgSlope = slopeSum / slopeCount;
  if (avgSlope > 0.1) return 0; // Surrounding terrain too rugged for farming
  const avgFertility = fertilitySum / fertilityCount;

  let score = 0;

  // Flat land — primary driver for farms
  score += Math.max(0, 0.2 - s) * 3;

  // Broad flatness bonus — reward cells where the whole neighborhood is gentle
  score += Math.max(0, 0.1 - avgSlope) * 3;

  // Fertile hinterland — the main reason farms exist
  score += avgFertility * 0.5;

  // Elevation penalty — farms prefer lowlands and valleys.
  // Terrain elevations range roughly 0-400. Farms thin out above ~80, rare above ~200.
  const elevAboveSea = Math.max(0, h - seaLevel);
  if (elevAboveSea > 80) {
    const elevPenalty = Math.min(1, (elevAboveSea - 80) / 150);
    score *= 1.0 - elevPenalty * 0.8;
  }

  // River/stream access — water for livestock and irrigation
  const rDist = riverDist.get(gx, gz);
  if (rDist < 3) score += 0.25;
  else if (rDist < 6) score += 0.1;

  // Spring line — reliable water supply
  const sDist = springDist.get(gx, gz);
  if (sDist < 3) score += 0.15;
  else if (sDist < 6) score += 0.05;

  // Edge avoidance
  const edgeDist = Math.min(gx, gz, width - 1 - gx, height - 1 - gz);
  if (edgeDist < 5) score *= 0.3;

  return score;
}

/**
 * @param {object} params
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {import('../core/Grid2D.js').Grid2D} slope
 * @param {import('../core/Grid2D.js').Grid2D} soilFertility
 * @param {Array} existingSettlements - Already placed tier 1-3 settlements
 * @param {object} proximityGrids - From buildProximityGrids()
 * @param {Array} confluences
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [extras]
 * @returns {Array<{gx, gz, tier, score, type}>}
 */
export function generateFarms(params, elevation, slope, soilFertility, existingSettlements, proximityGrids, confluences, rng, extras) {
  const {
    width,
    height,
    cellSize = 50,
    seaLevel = 0,
  } = params;

  const minSpacing = 7;        // Hard minimum (~350m)
  const softSpacing = 14;      // Graduated penalty kicks in within this range
  const scoreThreshold = 0.25;
  const maxFarms = 120;        // Allow many — land will limit naturally

  // Score all cells and collect candidates
  const candidates = [];
  for (let gz = 3; gz < height - 3; gz++) {
    for (let gx = 3; gx < width - 3; gx++) {
      const s = scoreFarmCell(gx, gz, params, elevation, slope, soilFertility, proximityGrids);
      if (s >= scoreThreshold) {
        candidates.push({ gx, gz, score: s });
      }
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Place farms with spacing constraints + graduated proximity penalty
  const allSettlements = [...existingSettlements];
  const farms = [];

  for (const c of candidates) {
    if (farms.length >= maxFarms) break;

    // Hard spacing check
    if (!respectsSpacing(c.gx, c.gz, allSettlements, minSpacing)) continue;

    // Graduated proximity penalty: reduce score based on nearest peer
    let nearestDist = Infinity;
    for (const s of allSettlements) {
      const d = distance2D(c.gx, c.gz, s.gx, s.gz);
      if (d < nearestDist) nearestDist = d;
    }
    let adjustedScore = c.score;
    if (nearestDist < softSpacing) {
      // Linear penalty: at minSpacing score is halved, at softSpacing no penalty
      const t = (nearestDist - minSpacing) / (softSpacing - minSpacing);
      adjustedScore *= 0.5 + 0.5 * t;
    }

    // After penalty, must still meet threshold
    if (adjustedScore < scoreThreshold) continue;

    // Farms are tier 4 (hamlet) or tier 5 (isolated farm)
    const tier = adjustedScore > 0.45 ? 4 : 5;
    const type = classifySite(c.gx, c.gz, proximityGrids, confluences, extras);

    const farm = {
      gx: c.gx,
      gz: c.gz,
      x: c.gx * cellSize,
      z: c.gz * cellSize,
      tier,
      score: adjustedScore,
      type: type === 'hilltop' ? 'farm' : type,
    };

    farms.push(farm);
    allSettlements.push(farm);
  }

  return farms;
}
