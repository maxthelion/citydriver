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
const FLOOD_MARGIN_M = 3.0;  // land below seaLevel + this is in the flood zone
const FLOOD_MARGIN_DIST = 5; // cells within this distance of water AND below flood level

/**
 * Compute a flood zone grid: 1 = flood zone (unbuildable), 0 = safe.
 * Cells are in the flood zone if they are below seaLevel + FLOOD_MARGIN_M
 * AND within FLOOD_MARGIN_DIST cells of water.
 *
 * @param {Grid2D} elevation
 * @param {Grid2D} waterMask
 * @param {number} seaLevel
 * @returns {Grid2D} floodZone — uint8 grid, 1 = flood zone
 */
export function computeFloodZone(elevation, waterMask, seaLevel = 0) {
  const { width, height } = elevation;
  const cellSize = elevation.cellSize;
  const cutoffCells = FLOOD_MARGIN_DIST;

  const waterDist = computeWaterDistance(waterMask, cutoffCells);
  const floodZone = new Grid2D(width, height, {
    type: 'uint8',
    cellSize,
    originX: elevation.originX,
    originZ: elevation.originZ,
  });

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const elev = elevation.get(gx, gz);
      const wdist = waterDist.get(gx, gz);
      if (elev < seaLevel + FLOOD_MARGIN_M && wdist <= FLOOD_MARGIN_DIST) {
        floodZone.set(gx, gz, 1);
      }
    }
  }

  return floodZone;
}

export function computeTerrainSuitability(elevation, slope, waterMask, seaLevel = 0, floodZone = null) {
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

      // Flood zone: precomputed grid marks low-lying coastal land as unbuildable
      if (floodZone && floodZone.get(gx, gz) > 0) continue; // stays 0

      const wdist = waterDist.get(gx, gz);
      let score = slopeScore(slope.get(gx, gz));

      // Edge taper
      if (edgeDist < edgeTaper) {
        score *= edgeDist / edgeTaper;
      }

      // Waterfront bonus
      if (wdist > 0 && wdist < waterfrontRange) {
        score = Math.min(1, score + WATERFRONT_BONUS * (1 - wdist / waterfrontRange));
      }

      suitability.set(gx, gz, score);
    }
  }

  return { suitability, waterDist };
}
