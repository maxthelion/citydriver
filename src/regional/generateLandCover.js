/**
 * A5. Land cover generation.
 * Assigns vegetation and ground cover based on elevation, slope, geology,
 * drainage, and proximity to settlements.
 *
 * Uses suitability scoring: each cell computes a 0-1 score for every cover type,
 * then picks the type with the highest suitability.
 *
 * Includes transition-zone blending to prevent salt-and-pepper noise.
 *
 * Cover types: 0=water, 1=farmland, 2=forest, 3=moorland, 4=marsh,
 *              5=settlement clearing, 6=open woodland, 7=bare rock, 8=scrubland
 */

import { Grid2D } from '../core/Grid2D.js';
import { smoothstep, clamp } from '../core/math.js';

export const COVER = {
  WATER: 0,
  FARMLAND: 1,
  FOREST: 2,
  MOORLAND: 3,
  MARSH: 4,
  SETTLEMENT: 5,
  OPEN_WOODLAND: 6,
  BARE_ROCK: 7,
  SCRUBLAND: 8,
};

/**
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.cellSize=50]
 * @param {number} [params.seaLevel=0]
 * @param {number} [params.treeline=60] - Elevation above sea level where trees stop
 * @param {number} [params.farmingLimit=0.2] - Max slope for farmland
 * @param {Grid2D} elevation
 * @param {Grid2D} slope
 * @param {Grid2D} soilFertility
 * @param {Grid2D} permeability
 * @param {Grid2D} waterMask
 * @param {Array} settlements - [{gx, gz, tier}]
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Grid2D}
 */
export function generateLandCover(params, elevation, slope, soilFertility, permeability, waterMask, settlements, rng) {
  const {
    width,
    height,
    cellSize = 50,
    seaLevel = 0,
    treeline = 60,
    farmingLimit = 0.2,
  } = params;

  const landCover = new Grid2D(width, height, { type: 'uint8', cellSize });

  // Pre-compute settlement influence (clearing around settlements)
  const settlementDist = new Grid2D(width, height, { fill: Infinity });
  if (settlements) {
    for (const s of settlements) {
      const radius = (s.tier === 1 ? 15 : s.tier === 2 ? 10 : 6);
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const gx = s.gx + dx;
          const gz = s.gz + dz;
          if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < settlementDist.get(gx, gz)) {
            settlementDist.set(gx, gz, dist);
          }
        }
      }
    }
  }

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      // Water — always takes precedence
      if (waterMask.get(gx, gz) > 0 || elevation.get(gx, gz) < seaLevel) {
        landCover.set(gx, gz, COVER.WATER);
        continue;
      }

      const h = elevation.get(gx, gz) - seaLevel;
      const s = slope.get(gx, gz);
      const fertility = soilFertility.get(gx, gz);
      const perm = permeability.get(gx, gz);
      const sDist = settlementDist.get(gx, gz);

      // Settlement clearing — always takes precedence
      if (sDist < 3) {
        landCover.set(gx, gz, COVER.SETTLEMENT);
        continue;
      }

      // --- Suitability scoring ---
      // Compute a 0-1 suitability for each natural cover type, pick the best.

      // Farmland: low slope + low elevation + good soil fertility + near settlement
      const farmSlope = clamp(1.0 - s / farmingLimit, 0, 1);
      const farmElev = smoothstep(treeline * 0.6, 0, h); // higher at low elevation
      const farmProximity = smoothstep(25, 3, sDist);     // higher near settlements
      const farmSuit = farmSlope * farmElev * fertility * farmProximity;

      // Forest: moderate slope + moderate elevation + adequate rainfall (use fertility as proxy) + not too dry
      const forestElev = smoothstep(0, 8, h) * smoothstep(treeline, treeline * 0.6, h);
      const forestFertility = clamp(fertility * 1.5, 0, 1);
      const forestSuit = forestElev * forestFertility * clamp(1.0 - s * 2, 0.1, 1);

      // Moorland: high elevation + acidic soil (low fertility)
      const moorElev = smoothstep(treeline * 0.5, treeline, h);
      const moorSoil = clamp(1.0 - fertility, 0, 1);
      const moorSuit = moorElev * (0.4 + moorSoil * 0.6);

      // Marsh: low elevation + impermeable rock (low permeability) + low slope
      const marshElev = smoothstep(15, 0, h);
      const marshPerm = clamp(1.0 - perm / 0.2, 0, 1); // high when perm < 0.2
      const marshSlope = clamp(1.0 - s / 0.05, 0, 1);
      const marshSuit = marshElev * marshPerm * marshSlope;

      // Open woodland: transition between forest and moorland
      const owElev = smoothstep(treeline * 0.4, treeline * 0.7, h) * smoothstep(treeline, treeline * 0.7, h);
      const owSuit = owElev * clamp(fertility * 0.8, 0, 1) * clamp(1.0 - s * 3, 0, 1);

      // Bare rock: very high slope or very high erosion resistance at altitude
      const bareSlope = smoothstep(0.3, 0.6, s);
      const bareResistance = clamp((1.0 - fertility) * (1.0 - perm), 0, 1); // proxy for hard bare rock
      const bareElev = smoothstep(treeline * 0.3, treeline, h);
      const bareSuit = Math.max(bareSlope * 0.8, bareResistance * bareElev * 0.6);

      // Scrubland: dry, moderate slope, poor soil
      const scrubDry = clamp(1.0 - fertility, 0, 1) * clamp(perm, 0, 1); // permeable + infertile = dry
      const scrubElev = smoothstep(0, 10, h) * smoothstep(treeline, treeline * 0.4, h);
      const scrubSlope = clamp(1.0 - s / 0.4, 0, 1);
      const scrubSuit = scrubDry * scrubElev * scrubSlope * 0.7;

      // Pick the cover type with highest suitability
      const scores = [
        // index matches COVER enum values (skip WATER=0, SETTLEMENT=5)
        { cover: COVER.FARMLAND, score: farmSuit },
        { cover: COVER.FOREST, score: forestSuit },
        { cover: COVER.MOORLAND, score: moorSuit },
        { cover: COVER.MARSH, score: marshSuit },
        { cover: COVER.OPEN_WOODLAND, score: owSuit },
        { cover: COVER.BARE_ROCK, score: bareSuit },
        { cover: COVER.SCRUBLAND, score: scrubSuit },
      ];

      let bestCover = COVER.FOREST; // default fallback
      let bestScore = -1;
      for (const entry of scores) {
        if (entry.score > bestScore) {
          bestScore = entry.score;
          bestCover = entry.cover;
        }
      }

      landCover.set(gx, gz, bestCover);
    }
  }

  // --- Transition zone blending pass ---
  // If a cell's type differs from most of its neighbors, it may switch
  // to the dominant neighbor type. Prevents salt-and-pepper noise.
  blendTransitions(landCover, width, height, rng);

  return landCover;
}

/**
 * Blending pass to smooth land cover transitions.
 * If a cell is surrounded mostly by a different cover type, it may switch.
 */
function blendTransitions(landCover, width, height, rng) {
  const blendRng = rng.fork('landcover_blend');

  // Work on a copy to avoid order-dependent artifacts
  const copy = landCover.clone();

  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      const myType = copy.get(gx, gz);

      // Don't blend water or settlement cells
      if (myType === COVER.WATER || myType === COVER.SETTLEMENT) continue;

      // Count neighbor types
      const counts = new Map();
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nType = copy.get(gx + dx, gz + dz);
          if (nType === COVER.WATER || nType === COVER.SETTLEMENT) continue;
          counts.set(nType, (counts.get(nType) || 0) + 1);
        }
      }

      // Find dominant neighbor type
      let dominantType = myType;
      let dominantCount = 0;
      for (const [type, count] of counts) {
        if (count > dominantCount) {
          dominantCount = count;
          dominantType = type;
        }
      }

      // If dominant neighbor differs from this cell and has strong majority,
      // switch with some probability
      if (dominantType !== myType && dominantCount >= 5) {
        // Higher probability for stronger dominance
        const switchProb = (dominantCount - 4) / 4; // 0.25 at 5, 0.5 at 6, etc.
        if (blendRng.range(0, 1) < switchProb) {
          landCover.set(gx, gz, dominantType);
        }
      }
    }
  }
}
