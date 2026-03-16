/**
 * Sea floor plunge pass — forces water-mask cells steeply below sea level.
 * Runs after hydrology so waterMask is available.
 *
 * For each water cell, compute distance to nearest land cell (BFS),
 * then set elevation = min(current, -(depthBase + dist * dropRate)).
 * Rock hardness modulates steepness: hard rock = steeper cliffs.
 */
import { Grid2D } from '../core/Grid2D.js';

// Depth at the first underwater cell (minimum plunge)
const PLUNGE_DEPTH_BASE_HARD = 5;   // meters
const PLUNGE_DEPTH_BASE_SOFT = 3;

// Slope of drop-off (meters depth per meter horizontal distance)
const PLUNGE_SLOPE_HARD = 0.08;
const PLUNGE_SLOPE_SOFT = 0.04;

/**
 * BFS land distance: for each water cell, distance to nearest non-water cell.
 * Returns distance in cells (multiply by cellSize for meters).
 */
function computeLandDistance(waterMask, width, height) {
  const dist = new Float32Array(width * height);
  dist.fill(Infinity);

  const queue = [];
  // Seed: land cells adjacent to water
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (waterMask.get(gx, gz) === 0) {
        // Check if any neighbor is water
        for (const [dx, dz] of dirs) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < height && waterMask.get(nx, nz) > 0) {
            dist[gz * width + gx] = 0; // land cell at water boundary
            queue.push(gx | (gz << 16));
            break;
          }
        }
      }
    }
  }

  // BFS from boundary land cells into water
  let head = 0;
  while (head < queue.length) {
    const packed = queue[head++];
    const cx = packed & 0xFFFF;
    const cz = packed >> 16;
    const cd = dist[cz * width + cx];

    for (const [dx, dz] of dirs) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      if (waterMask.get(nx, nz) === 0) continue; // only propagate into water
      const idx = nz * width + nx;
      if (dist[idx] > cd + 1) {
        dist[idx] = cd + 1;
        queue.push(nx | (nz << 16));
      }
    }
  }

  return dist;
}

/**
 * Apply sea floor plunge to elevation grid.
 *
 * @param {Grid2D} elevation - Modified in place
 * @param {Grid2D} waterMask - 1 = water, 0 = land
 * @param {Grid2D} erosionResistance - Rock hardness 0-1
 * @param {number} cellSize - Meters per cell
 * @param {number} seaLevel - Sea level elevation (typically 0)
 */
export function applySeaFloorPlunge(elevation, waterMask, erosionResistance, cellSize, seaLevel) {
  const { width, height } = elevation;
  const landDist = computeLandDistance(waterMask, width, height);

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (waterMask.get(gx, gz) === 0) continue; // skip land

      const distCells = landDist[gz * width + gx];
      if (!isFinite(distCells)) continue; // isolated water with no land neighbor

      const distMeters = distCells * cellSize;
      const resist = erosionResistance.get(gx, gz);

      // Interpolate between soft and hard parameters based on resistance
      const t = Math.min(1, Math.max(0, (resist - 0.3) / 0.3));
      const depthBase = PLUNGE_DEPTH_BASE_SOFT + t * (PLUNGE_DEPTH_BASE_HARD - PLUNGE_DEPTH_BASE_SOFT);
      const slope = PLUNGE_SLOPE_SOFT + t * (PLUNGE_SLOPE_HARD - PLUNGE_SLOPE_SOFT);

      const plungeElev = seaLevel - depthBase - distMeters * slope;
      const current = elevation.get(gx, gz);
      elevation.set(gx, gz, Math.min(current, plungeElev));
    }
  }
}
