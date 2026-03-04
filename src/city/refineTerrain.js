/**
 * B1b. Refine terrain at city scale.
 * Adds high-frequency detail to the inherited regional heightmap.
 */

import { Grid2D } from '../core/Grid2D.js';
import { PerlinNoise } from '../core/noise.js';

/**
 * Refine the city-scale elevation with high-frequency terrain detail.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/rng.js').SeededRandom} rng
 */
export function refineTerrain(cityLayers, rng) {
  const elevation = cityLayers.getGrid('elevation');
  if (!elevation) return;

  const params = cityLayers.getData('params');
  const noise = new PerlinNoise(rng.fork('cityTerrain'));
  const w = elevation.width;
  const h = elevation.height;
  const cs = elevation.cellSize;

  // Add high-frequency detail
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const existing = elevation.get(gx, gz);

      // Fine noise at city scale
      const wx = (params.originX + gx * cs) * 0.005;
      const wz = (params.originZ + gz * cs) * 0.005;

      const detail = noise.fbm(wx, wz, {
        octaves: 3,
        persistence: 0.4,
        amplitude: 2, // Subtle detail (2m variation)
        frequency: 1,
      });

      elevation.set(gx, gz, existing + detail);
    }
  }

  // Recompute slope at city resolution
  const slope = cityLayers.getGrid('slope') || new Grid2D(w, h, { cellSize: cs });

  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      const dhdx = (elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz)) / (2 * cs);
      const dhdz = (elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1)) / (2 * cs);
      slope.set(gx, gz, Math.sqrt(dhdx * dhdx + dhdz * dhdz));
    }
  }

  cityLayers.setGrid('slope', slope);

  // Carve river channels into city terrain
  const waterMask = cityLayers.getGrid('waterMask');
  const seaLevel = params?.seaLevel ?? 0;
  if (waterMask) {
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (waterMask.get(gx, gz) > 0 && elevation.get(gx, gz) >= seaLevel) {
          // Carve channel: lower by 1-3 units based on nearby water density
          let waterNeighbors = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dz === 0) continue;
              if (waterMask.get(gx + dx, gz + dz) > 0) waterNeighbors++;
            }
          }
          const channelDepth = 1 + (waterNeighbors / 8) * 2; // 1-3 units
          elevation.set(gx, gz, elevation.get(gx, gz) - channelDepth);

          // Smooth channel edges: lower adjacent non-water cells slightly
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dz === 0) continue;
              const nx = gx + dx, nz = gz + dz;
              if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
              if (waterMask.get(nx, nz) === 0 && elevation.get(nx, nz) >= seaLevel) {
                const bankDrop = channelDepth * 0.3;
                elevation.set(nx, nz, elevation.get(nx, nz) - bankDrop);
              }
            }
          }
        }
      }
    }
  }
}
