/**
 * City setup (tick 0).
 * Extract context from regional map, refine terrain, import rivers,
 * classify water, carve channels, compute initial buildability.
 *
 * Spec: statement-of-intent.md "Tick 0: Setup"
 * Constants: technical-reference.md
 */

import { Grid2D } from '../core/Grid2D.js';
import { FeatureMap } from '../core/FeatureMap.js';
import { PerlinNoise } from '../core/noise.js';
import { inheritRivers } from '../core/inheritRivers.js';
import { distance2D } from '../core/math.js';
import { CITY_CELL_SIZE, CITY_RADIUS } from './constants.js';

/**
 * Create a FeatureMap from regional layers centered on a settlement.
 *
 * @param {import('../core/LayerStack.js').LayerStack} layers - Regional data
 * @param {{ gx: number, gz: number }} settlement - Settlement grid coords
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {FeatureMap}
 */
export function setupCity(layers, settlement, rng) {
  const params = layers.getData('params');
  const { cellSize: regionalCellSize, seaLevel } = params;
  const regionalElevation = layers.getGrid('elevation');
  const regionalSlope = layers.getGrid('slope');
  const regionalWaterMask = layers.getGrid('waterMask');

  // City parameters (from shared constants)
  const cityCellSize = CITY_CELL_SIZE;
  const cityRadius = CITY_RADIUS; // regional cells
  const scaleRatio = regionalCellSize / cityCellSize;
  const fullSize = Math.round(cityRadius * 2 * scaleRatio);

  // World-space origin of city grid, clipped to regional bounds
  const centerX = settlement.gx * regionalCellSize;
  const centerZ = settlement.gz * regionalCellSize;
  const regionW = (regionalElevation.width - 1) * regionalCellSize;
  const regionH = (regionalElevation.height - 1) * regionalCellSize;

  let originX = centerX - (fullSize / 2) * cityCellSize;
  let originZ = centerZ - (fullSize / 2) * cityCellSize;
  let endX = originX + fullSize * cityCellSize;
  let endZ = originZ + fullSize * cityCellSize;

  // Clamp to regional data bounds
  if (originX < 0) originX = 0;
  if (originZ < 0) originZ = 0;
  if (endX > regionW) endX = regionW;
  if (endZ > regionH) endZ = regionH;

  const cityGridW = Math.round((endX - originX) / cityCellSize);
  const cityGridH = Math.round((endZ - originZ) / cityCellSize);

  // Extract and refine terrain via bilinear interpolation
  const elevation = new Grid2D(cityGridW, cityGridH, {
    cellSize: cityCellSize,
    originX,
    originZ,
  });

  const slope = new Grid2D(cityGridW, cityGridH, {
    cellSize: cityCellSize,
    originX,
    originZ,
  });

  // Bilinear interpolation from regional to city resolution
  for (let gz = 0; gz < cityGridH; gz++) {
    for (let gx = 0; gx < cityGridW; gx++) {
      const wx = originX + gx * cityCellSize;
      const wz = originZ + gz * cityCellSize;
      const rgx = wx / regionalCellSize;
      const rgz = wz / regionalCellSize;
      elevation.set(gx, gz, regionalElevation.sample(rgx, rgz));
    }
  }

  // Perlin detail refinement: 3 octaves, 0.4 persistence, 2m amplitude
  const noise = new PerlinNoise(rng.fork('terrain-detail'));
  for (let gz = 0; gz < cityGridH; gz++) {
    for (let gx = 0; gx < cityGridW; gx++) {
      const wx = originX + gx * cityCellSize;
      const wz = originZ + gz * cityCellSize;
      const detail = noise.fbm(wx * 0.005, wz * 0.005, {
        octaves: 3,
        persistence: 0.4,
        amplitude: 2,
      });
      elevation.set(gx, gz, elevation.get(gx, gz) + detail);
    }
  }

  // Recompute slope (central difference)
  for (let gz = 1; gz < cityGridH - 1; gz++) {
    for (let gx = 1; gx < cityGridW - 1; gx++) {
      const dex = elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz);
      const dez = elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1);
      slope.set(gx, gz, Math.sqrt(dex * dex + dez * dez) / (2 * cityCellSize));
    }
  }
  // Edge slopes from nearest interior
  for (let gx = 0; gx < cityGridW; gx++) {
    slope.set(gx, 0, slope.get(gx, 1));
    slope.set(gx, cityGridH - 1, slope.get(gx, cityGridH - 2));
  }
  for (let gz = 0; gz < cityGridH; gz++) {
    slope.set(0, gz, slope.get(1, gz));
    slope.set(cityGridW - 1, gz, slope.get(cityGridW - 2, gz));
  }

  // Create FeatureMap
  const map = new FeatureMap(cityGridW, cityGridH, cityCellSize, { originX, originZ });

  // Seed waterMask from sea level (not from regional waterMask, which has
  // coarse 200m-resolution river stamps that look blocky at 20m).
  // River water is handled by the inherited vector paths below.
  for (let gz = 0; gz < cityGridH; gz++) {
    for (let gx = 0; gx < cityGridW; gx++) {
      if (elevation.get(gx, gz) < seaLevel) {
        map.waterMask.set(gx, gz, 1);
      }
    }
  }

  // Import rivers as features (shared inheritance utility)
  const riverPaths = layers.getData('riverPaths');
  if (riverPaths) {
    const bounds = {
      minX: originX,
      minZ: originZ,
      maxX: originX + cityGridW * cityCellSize,
      maxZ: originZ + cityGridH * cityCellSize,
    };
    const cityRivers = inheritRivers(riverPaths, bounds, {
      chaikinPasses: 1,
      margin: cityCellSize,
    });
    for (const river of cityRivers) {
      map.addFeature('river', { polyline: river.polyline });
    }
  }

  // Set terrain (computes initial buildability, which needs waterMask first)
  map.setTerrain(elevation, slope);

  // Classify water
  map.classifyWater(seaLevel);

  // Carve channels
  map.carveChannels();

  // Water depth (BFS from land into water — for narrow-river path costs)
  map.computeWaterDepth();

  // Store metadata (needed by computeLandValue for town center)
  map.seaLevel = seaLevel;
  map.settlement = settlement;
  map.regionalLayers = layers;
  map.rng = rng;

  // Import regional settlements that fall within city bounds
  const allSettlements = layers.getData('settlements');
  if (allSettlements) {
    map.regionalSettlements = allSettlements.filter(s => {
      const wx = s.gx * regionalCellSize;
      const wz = s.gz * regionalCellSize;
      return wx >= originX && wx <= endX && wz >= originZ && wz <= endZ;
    }).map(s => ({
      ...s,
      cityGx: Math.round((s.gx * regionalCellSize - originX) / cityCellSize),
      cityGz: Math.round((s.gz * regionalCellSize - originZ) / cityCellSize),
    }));
  } else {
    map.regionalSettlements = [];
  }

  // Compute initial land value from terrain features
  map.computeLandValue();

  // Place nuclei (shared across all growth strategies)
  const tier = settlement.tier || 3;
  map.nuclei = placeNuclei(map, tier, rng);

  return map;
}

// ============================================================
// Nucleus placement
// ============================================================

// Placement tuning constants
const NUCLEUS_MIN_SPACING = 15;          // min grid cells between nuclei
const NUCLEUS_SUPPRESSION_RADIUS = 40;   // radius of value suppression after placement
const NUCLEUS_SUPPRESSION_CORE = 0.3;    // fraction of radius with flat suppression
const NUCLEUS_WATERFRONT_DIST = 6;       // cells from water to count as waterfront
const NUCLEUS_WATERFRONT_RATIO = 0.5;    // max fraction of nuclei that can be waterfront
const NUCLEUS_FLAT_BONUS = 0.6;          // score bonus for flat terrain (slope < threshold)
const NUCLEUS_FLAT_SLOPE_MAX = 0.1;      // slope threshold for flat bonus
const NUCLEUS_SPACING_WEIGHT = 0.3;      // weight of spacing bonus in score
const NUCLEUS_MIN_BUILDABILITY = 0.2;    // min buildability to be a candidate

// Nucleus caps by tier
function nucleusCap(tier) {
  if (tier <= 1) return 20;
  if (tier <= 2) return 14;
  return 10;
}

/**
 * Place nucleus seeds on buildable land.
 */
function placeNuclei(map, tier, rng) {
  const cap = nucleusCap(tier);
  const nuclei = [];

  // Center nucleus at settlement location (nudge to nearest buildable cell if on water)
  let centerGx = Math.round((map.settlement.gx * (map.regionalLayers.getData('params').cellSize) - map.originX) / map.cellSize);
  let centerGz = Math.round((map.settlement.gz * (map.regionalLayers.getData('params').cellSize) - map.originZ) / map.cellSize);

  if (centerGx >= 0 && centerGx < map.width && centerGz >= 0 && centerGz < map.height) {
    // If center is unbuildable (e.g. settlement on river), find nearest buildable cell.
    // Search up to half the map — rivers can be wide at city resolution.
    if (map.buildability.get(centerGx, centerGz) < 0.1) {
      let bestDist = Infinity;
      let bestGx = centerGx, bestGz = centerGz;
      const searchR = Math.floor(Math.min(map.width, map.height) / 2);
      for (let dz = -searchR; dz <= searchR; dz++) {
        for (let dx = -searchR; dx <= searchR; dx++) {
          const gx = centerGx + dx, gz = centerGz + dz;
          if (gx < 10 || gx >= map.width - 10 || gz < 10 || gz >= map.height - 10) continue;
          if (map.buildability.get(gx, gz) < NUCLEUS_MIN_BUILDABILITY) continue;
          const d = dx * dx + dz * dz;
          if (d < bestDist) { bestDist = d; bestGx = gx; bestGz = gz; }
        }
      }
      centerGx = bestGx;
      centerGz = bestGz;
    }

    if (map.buildability.get(centerGx, centerGz) >= 0.1) {
      nuclei.push({
        gx: centerGx,
        gz: centerGz,
        type: classifyNucleus(map, centerGx, centerGz),
        tier: 1,
        index: 0,
      });
    }
  }

  // Build list of buildable candidate cells (sampled for speed on large grids).
  // Use a margin large enough that nuclei have room for growth and roads,
  // and to avoid placing them outside valid regional data when the city
  // grid extends beyond the region boundary.
  const margin = 10;
  const buildableCells = [];
  const step = map.width > 200 ? 3 : 1;
  for (let gz = margin; gz < map.height - margin; gz += step) {
    for (let gx = margin; gx < map.width - margin; gx += step) {
      if (map.buildability.get(gx, gz) >= NUCLEUS_MIN_BUILDABILITY) {
        buildableCells.push({ gx, gz });
      }
    }
  }

  // Local suppression grid — only used during placement, not written to map.landValue
  const suppression = new Float32Array(map.width * map.height);

  // Precompute distance-to-water for waterfront cap
  const waterDist = _computeWaterDistance(map);

  const maxWaterfront = Math.ceil(cap * NUCLEUS_WATERFRONT_RATIO);
  let waterfrontCount = 0;

  // Count center nucleus if it's waterfront, and apply initial suppression
  if (nuclei.length > 0) {
    const cn = nuclei[0];
    if (waterDist[cn.gz * map.width + cn.gx] < NUCLEUS_WATERFRONT_DIST) waterfrontCount++;
    _addSuppression(suppression, map.width, map.height, cn.gx, cn.gz, NUCLEUS_SUPPRESSION_RADIUS);
  }

  // Greedy placement: score = value * buildability, with spacing enforcement
  while (nuclei.length < cap) {
    let bestScore = -1;
    let bestCell = null;

    const waterfrontFull = waterfrontCount >= maxWaterfront;

    for (const c of buildableCells) {
      if (waterfrontFull && waterDist[c.gz * map.width + c.gx] < NUCLEUS_WATERFRONT_DIST) continue;

      let minDist = Infinity;
      for (const n of nuclei) {
        const d = distance2D(c.gx, c.gz, n.gx, n.gz);
        if (d < minDist) minDist = d;
      }
      if (minDist < NUCLEUS_MIN_SPACING) continue;

      const b = map.buildability.get(c.gx, c.gz);
      const v = Math.max(0, map.landValue.get(c.gx, c.gz) - suppression[c.gz * map.width + c.gx]);
      const spacingBonus = Math.min(1, minDist / (NUCLEUS_MIN_SPACING * 2));
      const s = map.slope ? map.slope.get(c.gx, c.gz) : 0;
      const flatBonus = s < NUCLEUS_FLAT_SLOPE_MAX
        ? NUCLEUS_FLAT_BONUS * (1 - s / NUCLEUS_FLAT_SLOPE_MAX) : 0;
      const score = (v + flatBonus) * b
        * (1 - NUCLEUS_SPACING_WEIGHT + NUCLEUS_SPACING_WEIGHT * spacingBonus);

      if (score > bestScore) {
        bestScore = score;
        bestCell = c;
      }
    }

    if (!bestCell) break;

    const isWaterfront = waterDist[bestCell.gz * map.width + bestCell.gx] < NUCLEUS_WATERFRONT_DIST;
    if (isWaterfront) waterfrontCount++;

    const nucleusTier = nuclei.length < 3 ? 2 : (nuclei.length < 6 ? 3 : 4);
    nuclei.push({
      gx: bestCell.gx,
      gz: bestCell.gz,
      type: classifyNucleus(map, bestCell.gx, bestCell.gz),
      tier: nucleusTier,
      index: nuclei.length,
    });

    _addSuppression(suppression, map.width, map.height, bestCell.gx, bestCell.gz, NUCLEUS_SUPPRESSION_RADIUS);
  }

  return nuclei;
}

/**
 * BFS distance from each land cell to nearest water cell.
 */
function _computeWaterDistance(map) {
  const w = map.width, h = map.height;
  const dist = new Uint8Array(w * h).fill(255);
  const queue = [];

  // Seed with water cells
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        dist[gz * w + gx] = 0;
        queue.push(gz * w + gx);
      }
    }
  }

  // BFS
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const gx = idx % w, gz = (idx - gx) / w;
    const d = dist[idx] + 1;
    if (d > 30) continue; // only need nearby distances
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = gx + dx, nz = gz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      const nIdx = nz * w + nx;
      if (d < dist[nIdx]) {
        dist[nIdx] = d;
        queue.push(nIdx);
      }
    }
  }

  return dist;
}

/**
 * Add suppression to a local array (not the map) so subsequent nuclei spread out.
 */
function _addSuppression(suppression, w, h, cx, cz, radius) {
  const coreRadius = radius * NUCLEUS_SUPPRESSION_CORE;
  const rSq = radius * radius;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const gx = cx + dx, gz = cz + dz;
      if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
      const distSq = dx * dx + dz * dz;
      if (distSq > rSq) continue;
      const dist = Math.sqrt(distSq);
      // Full suppression within core, quadratic falloff beyond
      const amount = dist <= coreRadius ? 1.0
        : ((1 - (dist - coreRadius) / (radius - coreRadius)) ** 2);
      suppression[gz * w + gx] += amount;
    }
  }
}

/**
 * Classify nucleus type based on surrounding terrain.
 */
function classifyNucleus(map, gx, gz) {
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

  if (map.roadGrid.get(gx, gz) > 0) return 'roadside';

  return 'suburban';
}

