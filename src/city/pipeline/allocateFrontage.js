// src/city/pipeline/allocateFrontage.js
/**
 * Commercial frontage allocation.
 * Walks along road cells and claims cells perpendicular to the road,
 * with depth proportional to the local value bitmap.
 */

import { RESERVATION } from './growthAgents.js';

/**
 * Determine road direction at a cell by looking at road neighbours.
 * Returns a unit vector along the road, or null if isolated.
 */
function roadDirection(gx, gz, roadGrid, w, h) {
  // Check 4-connected neighbours for road cells
  const neighbours = [];
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = gx + dx, nz = gz + dz;
    if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
      neighbours.push({ dx, dz });
    }
  }
  if (neighbours.length === 0) return null;

  // Average direction of road neighbours relative to this cell
  let ax = 0, az = 0;
  for (const n of neighbours) { ax += n.dx; az += n.dz; }
  const len = Math.sqrt(ax * ax + az * az);
  if (len < 0.01) return { dx: 1, dz: 0 }; // fallback
  return { dx: ax / len, dz: az / len };
}

/**
 * Allocate commercial frontage along roads.
 *
 * @param {object} opts
 * @param {Float32Array} opts.valueLayer - commercial value bitmap
 * @param {Grid2D} opts.resGrid - reservation grid (read + write)
 * @param {Grid2D} opts.zoneGrid - zone eligibility
 * @param {Grid2D} opts.roadGrid - road cells
 * @param {Float32Array|null} opts.devProximity - development proximity
 * @param {number} opts.resType - reservation type to write
 * @param {number} opts.budget - max cells to claim
 * @param {number} opts.maxDepth - max cells perpendicular to road
 * @param {number} opts.valueThreshold - min value to claim
 * @param {number} opts.w - grid width
 * @param {number} opts.h - grid height
 * @returns {Array<{gx,gz}>} claimed cells
 */
export function allocateFrontage({
  valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
  resType, budget, maxDepth, valueThreshold, w, h,
}) {
  if (budget <= 0) return [];

  // Step 1: Find road cells with high commercial value nearby
  const roadCells = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (roadGrid.get(gx, gz) === 0) continue;
      // Check value in adjacent non-road cells
      let maxVal = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
          maxVal = Math.max(maxVal, valueLayer[nz * w + nx]);
        }
      }
      if (maxVal >= valueThreshold) {
        roadCells.push({ gx, gz, value: maxVal });
      }
    }
  }

  // Sort by value — claim best road frontage first
  roadCells.sort((a, b) => b.value - a.value);

  // Step 2: For each road cell, claim perpendicular cells
  const claimed = [];

  for (const rc of roadCells) {
    if (claimed.length >= budget) break;

    const dir = roadDirection(rc.gx, rc.gz, roadGrid, w, h);
    if (!dir) continue;

    // Perpendicular direction (both sides)
    const perpX = -dir.dz;
    const perpZ = dir.dx;

    // Depth scales with local value: high value = more depth
    const localValue = valueLayer[rc.gz * w + rc.gx] || rc.value;
    const depth = Math.max(1, Math.round(maxDepth * Math.min(1, localValue)));

    // Claim on both sides of road
    for (const side of [1, -1]) {
      for (let d = 1; d <= depth; d++) {
        if (claimed.length >= budget) break;

        const gx = rc.gx + Math.round(perpX * side * d);
        const gz = rc.gz + Math.round(perpZ * side * d);

        if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
        if (zoneGrid.get(gx, gz) === 0) continue;
        if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
        if (roadGrid.get(gx, gz) > 0) continue; // don't claim road cells
        if (devProximity !== null && devProximity[gz * w + gx] === 0) continue;

        resGrid.set(gx, gz, resType);
        claimed.push({ gx, gz });
      }
    }
  }

  return claimed;
}
