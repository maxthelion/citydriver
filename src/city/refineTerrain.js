/**
 * B1b. Refine terrain at city scale.
 * Adds high-frequency detail to the inherited regional heightmap.
 * Carves river channels using distance from river centerline for
 * smooth cross-section profiles.
 */

import { Grid2D } from '../core/Grid2D.js';
import { PerlinNoise } from '../core/noise.js';
import { channelProfile, riverMaxDepth } from '../core/riverGeometry.js';

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

  // Carve river channels using centerline distance
  carveRiverChannels(cityLayers, elevation, w, h, cs, params);
}

/**
 * Compute distance from each city cell to the nearest river centerline
 * point, along with the river half-width at that closest point.
 * Returns a Float32Array of normalized distances (0 = center, 1 = edge,
 * >1 = outside river) and stores the raw distance grid on cityLayers.
 */
function computeRiverDistanceGrid(riverPaths, w, h, cs) {
  // dist: world-unit distance to nearest centerline point
  // halfW: river half-width at the nearest centerline point
  const dist = new Float32Array(w * h).fill(Infinity);
  const halfW = new Float32Array(w * h);

  for (const path of riverPaths) {
    const pts = path.points;
    if (pts.length < 2) continue;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      // Max river half-width along this segment (for paint radius)
      const maxHW = Math.max(a.width, b.width) / 2;
      // Paint radius: extend beyond river edge for bank carving
      const paintRadius = maxHW + cs * 3;

      // Walk along segment
      const stepSize = cs * 0.5;
      const steps = Math.ceil(segLen / stepSize);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const hw = (a.width * (1 - t) + b.width * t) / 2;

        const cellRadius = Math.ceil(paintRadius / cs);
        const cgx = Math.floor(px / cs);
        const cgz = Math.floor(pz / cs);

        for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
          for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
            const gx = cgx + ddx;
            const gz = cgz + ddz;
            if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;

            const cellX = gx * cs + cs / 2;
            const cellZ = gz * cs + cs / 2;
            const d = Math.sqrt((cellX - px) ** 2 + (cellZ - pz) ** 2);

            const idx = gz * w + gx;
            if (d < dist[idx]) {
              dist[idx] = d;
              halfW[idx] = hw;
            }
          }
        }
      }
    }
  }

  return { dist, halfW };
}

/**
 * Carve river channels into city elevation using distance from river
 * centerline. Produces smooth V/U-shaped cross-sections instead of
 * blocky rectangular trenches.
 */
function carveRiverChannels(cityLayers, elevation, w, h, cs, params) {
  const riverPaths = cityLayers.getData('riverPaths');
  const seaLevel = params?.seaLevel ?? 0;
  if (!riverPaths || riverPaths.length === 0) return;

  const { dist, halfW } = computeRiverDistanceGrid(riverPaths, w, h, cs);

  // Store for use by buildability
  cityLayers.setData('riverDist', { dist, halfW, width: w, height: h });

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const idx = gz * w + gx;
      const d = dist[idx];
      const hw = halfW[idx];
      if (hw === 0 || d === Infinity) continue;

      const elev = elevation.get(gx, gz);
      if (elev < seaLevel) continue;

      // Normalized distance: 0 = center, 1 = river edge
      const nd = d / hw;
      const depthFraction = channelProfile(nd);
      if (depthFraction <= 0) continue;

      const maxDepth = riverMaxDepth(hw);
      const carve = maxDepth * depthFraction;

      if (carve > 0.05) {
        elevation.set(gx, gz, elev - carve);
      }
    }
  }
}
