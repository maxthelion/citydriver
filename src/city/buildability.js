/**
 * Unified buildability grid.
 *
 * Composites elevation, slope, water, occupancy, and water proximity
 * into a single float32 grid (0 = unbuildable, 1 = ideal).
 *
 * Recomputed after any operation that modifies occupancy (road stamping,
 * plot placement). Every system that needs "can we build here?" or
 * "how desirable is this cell?" reads this grid.
 *
 * Replaces: terrainAttraction, isBuildable(), isPlotBuildableSimple(),
 * and all ad-hoc elevation/slope/water checks scattered across files.
 */

import { Grid2D } from '../core/Grid2D.js';

/**
 * Compute (or recompute) the buildability grid.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {object} [occupancy] - occupancy grid (may be null early in pipeline)
 * @returns {Grid2D} float32 grid, 0 = unbuildable, 0..1 = buildability score
 */
export function computeBuildability(cityLayers, occupancy = null) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const slope = cityLayers.getGrid('slope');
  const waterMask = cityLayers.getGrid('waterMask');

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;

  // Precompute water distance via BFS (needed for waterfront bonus)
  const waterDist = computeWaterDistance(waterMask, elevation, seaLevel, w, h);

  const grid = new Grid2D(w, h, { type: 'float32', cellSize: cs });

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      // --- Hard constraints (unbuildable = 0) ---
      if (elevation.get(gx, gz) < seaLevel) continue;
      if (waterMask && waterMask.get(gx, gz) > 0) continue;

      const edgeDist = Math.min(gx, gz, w - 1 - gx, h - 1 - gz);
      if (edgeDist < 3) continue;

      // --- Slope: continuous falloff ---
      const s = slope ? slope.get(gx, gz) : 0;
      let score;
      if (s < 0.05) score = 1.0;
      else if (s < 0.15) score = 0.9;
      else if (s < 0.3) score = 0.7;    // gradeable
      else if (s < 0.5) score = 0.4;    // difficult but possible
      else if (s < 0.7) score = 0.15;   // marginal
      else continue;                      // unbuildable

      // --- Edge margin taper ---
      if (edgeDist < 8) score *= edgeDist / 8;

      // --- Waterfront bonus ---
      const wDist = waterDist[gz * w + gx];
      if (wDist > 0 && wDist < 10) {
        score = Math.min(1, score + 0.3 * (1 - wDist / 10));
      }

      // --- Occupancy: already used land = 0 ---
      if (occupancy) {
        const ax = Math.floor((gx * cs) / occupancy.res);
        const az = Math.floor((gz * cs) / occupancy.res);
        if (ax >= 0 && ax < occupancy.width && az >= 0 && az < occupancy.height) {
          if (occupancy.data[az * occupancy.width + ax] > 0) {
            score = 0;
          }
        }
      }

      grid.set(gx, gz, score);
    }
  }

  cityLayers.setGrid('buildability', grid);
  return grid;
}

/**
 * BFS water distance (lightweight — no shoreline direction, just distance).
 * Returns Uint16Array at city grid resolution.
 */
function computeWaterDistance(waterMask, elevation, seaLevel, w, h) {
  const MAX_DIST = 65535;
  const dist = new Uint16Array(w * h).fill(MAX_DIST);
  const queue = [];

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const isWater = (waterMask && waterMask.get(gx, gz) > 0) ||
                      (seaLevel !== null && elevation.get(gx, gz) < seaLevel);
      if (isWater) {
        dist[gz * w + gx] = 0;
        queue.push(gx + gz * w);
      }
    }
  }

  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++];
    const gx = key % w;
    const gz = (key - gx) / w;
    const d = dist[gz * w + gx];
    if (d >= 15) continue; // only need nearby cells

    for (const [dx, dz] of DIRS) {
      const nx = gx + dx, nz = gz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      const ni = nz * w + nx;
      if (dist[ni] <= d + 1) continue;
      dist[ni] = d + 1;
      queue.push(ni);
    }
  }

  return dist;
}
