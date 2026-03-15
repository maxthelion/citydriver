/**
 * Compute terrain suitability — pure function of terrain, not mutated
 * by features. Replaces FeatureMap._computeInitialBuildability.
 */
import { Grid2D } from './Grid2D.js';

// Buildability constants (meters)
const EDGE_MARGIN_M = 60;
const EDGE_TAPER_M = 160;
const WATERFRONT_RANGE_M = 200;
const WATERFRONT_BONUS = 0.3;
const WATER_DIST_CUTOFF_M = 300;

function slopeScore(slope) {
  if (slope < 0.05) return 1.0;
  if (slope < 0.15) return 0.9;
  if (slope < 0.3) return 0.7;
  if (slope < 0.5) return 0.4;
  if (slope < 0.7) return 0.15;
  return 0;
}

/**
 * BFS water distance from water cells, 4-connected.
 */
export function computeWaterDistance(waterMask, cutoffCells) {
  const { width, height } = waterMask;
  const dist = new Grid2D(width, height, {
    type: 'float32',
    cellSize: waterMask.cellSize,
    originX: waterMask.originX,
    originZ: waterMask.originZ,
    fill: cutoffCells + 1,
  });

  const queue = [];
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (waterMask.get(gx, gz) > 0) {
        dist.set(gx, gz, 0);
        queue.push(gx | (gz << 16));
      }
    }
  }

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let head = 0;
  while (head < queue.length) {
    const packed = queue[head++];
    const cx = packed & 0xFFFF;
    const cz = packed >> 16;
    const cd = dist.get(cx, cz);
    if (cd >= cutoffCells) continue;

    for (const [dx, dz] of dirs) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      if (dist.get(nx, nz) > cd + 1) {
        dist.set(nx, nz, cd + 1);
        queue.push(nx | (nz << 16));
      }
    }
  }

  return dist;
}

/**
 * Compute terrain suitability grid.
 * Pure function of elevation, slope, water — never mutated by features.
 *
 * @param {Grid2D} elevation
 * @param {Grid2D} slope
 * @param {Grid2D} waterMask
 * @returns {{ suitability: Grid2D, waterDist: Grid2D }}
 */
export function computeTerrainSuitability(elevation, slope, waterMask) {
  const width = elevation.width;
  const height = elevation.height;
  const cellSize = elevation.cellSize;

  const edgeMargin = Math.round(EDGE_MARGIN_M / cellSize);
  const edgeTaper = Math.round(EDGE_TAPER_M / cellSize);
  const waterfrontRange = Math.round(WATERFRONT_RANGE_M / cellSize);
  const cutoffCells = Math.round(WATER_DIST_CUTOFF_M / cellSize);

  const waterDist = computeWaterDistance(waterMask, cutoffCells);

  const suitability = new Grid2D(width, height, {
    type: 'float32',
    cellSize,
    originX: elevation.originX,
    originZ: elevation.originZ,
  });

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const edgeDist = Math.min(gx, gz, width - 1 - gx, height - 1 - gz);
      if (edgeDist < edgeMargin) continue; // stays 0

      if (waterMask.get(gx, gz) > 0) continue; // stays 0

      let score = slopeScore(slope.get(gx, gz));

      // Edge taper
      if (edgeDist < edgeTaper) {
        score *= edgeDist / edgeTaper;
      }

      // Waterfront bonus
      const wd = waterDist.get(gx, gz);
      if (wd > 0 && wd < waterfrontRange) {
        score = Math.min(1, score + WATERFRONT_BONUS * (1 - wd / waterfrontRange));
      }

      suitability.set(gx, gz, score);
    }
  }

  return { suitability, waterDist };
}
