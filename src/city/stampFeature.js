/**
 * Standalone feature-stamping functions.
 * These were previously side effects inside FeatureMap.addFeature().
 * Each function takes explicit grids and parameters — no FeatureMap dependency.
 */

import { riverHalfWidth } from '../core/riverGeometry.js';
import { RIVER_STAMP_FRACTION, STAMP_STEP_FRACTION } from './constants.js';

/**
 * Stamp a river polyline onto a waterMask grid.
 * Only stamps water cells — does NOT touch buildability.
 *
 * @param {Grid2D} waterMask - uint8 grid to stamp onto
 * @param {object} river - { polyline: [{x, z, accumulation?, width?}] }
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 */
export function stampRiverWaterMask(waterMask, river, cellSize, originX, originZ) {
  const polyline = river.polyline;
  if (!polyline || polyline.length < 2) return;

  const width = waterMask.width;
  const height = waterMask.height;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 0.01) continue;

    const stepSize = cellSize * STAMP_STEP_FRACTION;
    const steps = Math.ceil(segLen / stepSize);

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = a.x + dx * t;
      const pz = a.z + dz * t;

      const aWidth = a.width || riverHalfWidth(a.accumulation || 1) * 2;
      const bWidth = b.width || riverHalfWidth(b.accumulation || 1) * 2;
      const halfW = (aWidth * (1 - t) + bWidth * t) / 2;

      const effectiveRadius = Math.max(halfW, cellSize * RIVER_STAMP_FRACTION);
      const cellRadius = Math.ceil(effectiveRadius / cellSize);
      const cgx = Math.round((px - originX) / cellSize);
      const cgz = Math.round((pz - originZ) / cellSize);

      for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
        for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
          const gx = cgx + ddx;
          const gz = cgz + ddz;
          if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;
          const cellX = originX + gx * cellSize;
          const cellZ = originZ + gz * cellSize;
          if ((cellX - px) ** 2 + (cellZ - pz) ** 2 <= effectiveRadius * effectiveRadius) {
            waterMask.set(gx, gz, 1);
          }
        }
      }
    }
  }
}

/**
 * Stamp a railway polyline onto a railwayGrid.
 * Skips water cells. Does NOT touch buildability.
 *
 * @param {Grid2D} railwayGrid - uint8 grid to stamp onto
 * @param {Grid2D} waterMask - uint8 grid (to avoid stamping over water)
 * @param {Array<{x,z}>} polyline
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 */
export function stampRailwayGrid(railwayGrid, waterMask, polyline, cellSize, originX, originZ) {
  if (!polyline || polyline.length < 2) return;

  const halfWidth = 7; // 7m half-width (14m total — track + embankment)
  const w = railwayGrid.width;
  const h = railwayGrid.height;

  for (let i = 0; i < polyline.length - 1; i++) {
    const ax = polyline[i].x, az = polyline[i].z;
    const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 0.01) continue;

    const stepSize = cellSize * STAMP_STEP_FRACTION;
    const steps = Math.ceil(segLen / stepSize);

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = ax + dx * t;
      const pz = az + dz * t;
      const cellRadius = Math.ceil(halfWidth / cellSize);
      const cgx = Math.round((px - originX) / cellSize);
      const cgz = Math.round((pz - originZ) / cellSize);

      for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
        for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
          const gx = cgx + ddx;
          const gz = cgz + ddz;
          if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
          if (waterMask && waterMask.get(gx, gz) > 0) continue;
          const cellX = originX + gx * cellSize;
          const cellZ = originZ + gz * cellSize;
          if ((cellX - px) ** 2 + (cellZ - pz) ** 2 <= halfWidth * halfWidth) {
            railwayGrid.set(gx, gz, 1);
          }
        }
      }
    }
  }
}
