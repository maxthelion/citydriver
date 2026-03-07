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
import { chaikinSmooth, riverHalfWidth, segmentsToVectorPaths } from '../core/riverGeometry.js';

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

  // Import rivers as features
  const riverPaths = layers.getData('riverPaths');
  if (riverPaths) {
    const cityRiverPaths = _extractCityRivers(riverPaths, originX, originZ, cityGridSize, cityCellSize);
    for (const path of cityRiverPaths) {
      map.addFeature('river', {
        polyline: path.points,
      });
    }
  }

  // Set terrain (computes initial buildability, which needs waterMask first)
  map.setTerrain(elevation, slope);

  // Classify water
  map.classifyWater(seaLevel);

  // Carve channels
  map.carveChannels();

  // Store metadata
  map.seaLevel = seaLevel;
  map.settlement = settlement;
  map.regionalLayers = layers;
  map.rng = rng;

  return map;
}

/**
 * Extract river paths that fall within city bounds, applying extra Chaikin smoothing.
 */
function _extractCityRivers(riverPaths, originX, originZ, gridSize, cellSize) {
  const cityMinX = originX - cellSize;
  const cityMinZ = originZ - cellSize;
  const cityMaxX = originX + gridSize * cellSize + cellSize;
  const cityMaxZ = originZ + gridSize * cellSize + cellSize;

  const result = [];

  for (const path of riverPaths) {
    // Filter to points within city bounds (with margin)
    const clipped = [];
    for (const p of path.points) {
      if (p.x >= cityMinX && p.x <= cityMaxX && p.z >= cityMinZ && p.z <= cityMaxZ) {
        clipped.push({
          x: p.x,
          z: p.z,
          accumulation: p.accumulation,
          width: p.width,
        });
      } else if (clipped.length > 0) {
        // Include one point outside to avoid gaps at boundary
        clipped.push({ x: p.x, z: p.z, accumulation: p.accumulation, width: p.width });
        break;
      }
    }

    if (clipped.length >= 2) {
      // Extra Chaikin pass for higher resolution
      const smoothed = chaikinSmooth(
        clipped.map(p => ({ x: p.x, z: p.z, accumulation: p.accumulation })),
        1
      );
      result.push({
        points: smoothed.map(p => ({
          x: p.x,
          z: p.z,
          accumulation: p.accumulation,
          width: riverHalfWidth(p.accumulation) * 2,
        })),
      });
    }

    // Recurse into children
    if (path.children) {
      const childResults = _extractCityRivers(path.children, originX, originZ, gridSize, cellSize);
      result.push(...childResults);
    }
  }

  return result;
}
