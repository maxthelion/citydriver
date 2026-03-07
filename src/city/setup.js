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

  // City parameters
  const cityCellSize = 10;
  const cityRadius = 30; // regional cells
  const scaleRatio = regionalCellSize / cityCellSize;
  const cityGridSize = Math.round(cityRadius * 2 * scaleRatio);

  // World-space origin of city grid
  const centerX = settlement.gx * regionalCellSize;
  const centerZ = settlement.gz * regionalCellSize;
  const originX = centerX - (cityGridSize / 2) * cityCellSize;
  const originZ = centerZ - (cityGridSize / 2) * cityCellSize;

  // Extract and refine terrain via bilinear interpolation
  const elevation = new Grid2D(cityGridSize, cityGridSize, {
    cellSize: cityCellSize,
    originX,
    originZ,
  });

  const slope = new Grid2D(cityGridSize, cityGridSize, {
    cellSize: cityCellSize,
    originX,
    originZ,
  });

  // Bilinear interpolation from regional to city resolution
  for (let gz = 0; gz < cityGridSize; gz++) {
    for (let gx = 0; gx < cityGridSize; gx++) {
      const wx = originX + gx * cityCellSize;
      const wz = originZ + gz * cityCellSize;
      const rgx = wx / regionalCellSize;
      const rgz = wz / regionalCellSize;
      elevation.set(gx, gz, regionalElevation.sample(rgx, rgz));
    }
  }

  // Perlin detail refinement: 3 octaves, 0.4 persistence, 2m amplitude
  const noise = new PerlinNoise(rng.fork('terrain-detail'));
  for (let gz = 0; gz < cityGridSize; gz++) {
    for (let gx = 0; gx < cityGridSize; gx++) {
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
  for (let gz = 1; gz < cityGridSize - 1; gz++) {
    for (let gx = 1; gx < cityGridSize - 1; gx++) {
      const dex = elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz);
      const dez = elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1);
      slope.set(gx, gz, Math.sqrt(dex * dex + dez * dez) / (2 * cityCellSize));
    }
  }
  // Edge slopes from nearest interior
  for (let gx = 0; gx < cityGridSize; gx++) {
    slope.set(gx, 0, slope.get(gx, 1));
    slope.set(gx, cityGridSize - 1, slope.get(gx, cityGridSize - 2));
  }
  for (let gz = 0; gz < cityGridSize; gz++) {
    slope.set(0, gz, slope.get(1, gz));
    slope.set(cityGridSize - 1, gz, slope.get(cityGridSize - 2, gz));
  }

  // Create FeatureMap
  const map = new FeatureMap(cityGridSize, cityGridSize, cityCellSize, { originX, originZ });

  // Import waterMask from regional (bilinear + threshold)
  for (let gz = 0; gz < cityGridSize; gz++) {
    for (let gx = 0; gx < cityGridSize; gx++) {
      const wx = originX + gx * cityCellSize;
      const wz = originZ + gz * cityCellSize;
      const rgx = wx / regionalCellSize;
      const rgz = wz / regionalCellSize;
      const val = regionalWaterMask.sample(rgx, rgz);
      if (val >= 0.5) {
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
      maxX: originX + cityGridSize * cityCellSize,
      maxZ: originZ + cityGridSize * cityCellSize,
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

  // Store metadata (needed by computeLandValue for town center)
  map.seaLevel = seaLevel;
  map.settlement = settlement;
  map.regionalLayers = layers;
  map.rng = rng;

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
  const minSpacing = 15; // grid cells
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
          if (gx < 3 || gx >= map.width - 3 || gz < 3 || gz >= map.height - 3) continue;
          if (map.buildability.get(gx, gz) < 0.2) continue;
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

  // Build list of buildable candidate cells (sampled for speed on large grids)
  const buildableCells = [];
  const step = map.width > 200 ? 3 : 1;
  for (let gz = 3; gz < map.height - 3; gz += step) {
    for (let gx = 3; gx < map.width - 3; gx += step) {
      if (map.buildability.get(gx, gz) >= 0.2) {
        buildableCells.push({ gx, gz });
      }
    }
  }

  // Greedy placement: score = value * buildability, with spacing enforcement
  while (nuclei.length < cap) {
    let bestScore = -1;
    let bestCell = null;

    for (const c of buildableCells) {
      let minDist = Infinity;
      for (const n of nuclei) {
        const d = distance2D(c.gx, c.gz, n.gx, n.gz);
        if (d < minDist) minDist = d;
      }
      if (minDist < minSpacing) continue;

      const b = map.buildability.get(c.gx, c.gz);
      const v = map.landValue.get(c.gx, c.gz);
      const spacingBonus = Math.min(1, minDist / 30);
      const score = v * b * (0.7 + 0.3 * spacingBonus);

      if (score > bestScore) {
        bestScore = score;
        bestCell = c;
      }
    }

    if (!bestCell) break;

    const nucleusTier = nuclei.length < 3 ? 2 : (nuclei.length < 6 ? 3 : 4);
    nuclei.push({
      gx: bestCell.gx,
      gz: bestCell.gz,
      type: classifyNucleus(map, bestCell.gx, bestCell.gz),
      tier: nucleusTier,
      index: nuclei.length,
    });

    const intensity = nucleusTier <= 2 ? 0.6 : nucleusTier <= 3 ? 0.4 : 0.25;
    map._spreadValue(bestCell.gx, bestCell.gz, intensity, 15);
  }

  return nuclei;
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

