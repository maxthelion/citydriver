/**
 * Precompute terrain analysis grids for the A* cost function and
 * frontier priority scoring.
 *
 * All grids are at the city terrain resolution (cellSize) and computed
 * once at growth start.
 */

import { Grid2D } from '../core/Grid2D.js';

/**
 * Compute gradient direction per cell via finite differences on the elevation grid.
 * Returns { dxGrid, dzGrid } — each a Grid2D of float32 values representing
 * the elevation gradient components.
 */
export function computeGradientField(elevation, w, h) {
  const dxGrid = new Grid2D(w, h, { type: 'float32' });
  const dzGrid = new Grid2D(w, h, { type: 'float32' });

  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      const dx = (elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz)) / 2;
      const dz = (elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1)) / 2;
      dxGrid.set(gx, gz, dx);
      dzGrid.set(gx, gz, dz);
    }
  }

  return { dxGrid, dzGrid };
}

/**
 * BFS flood from all water cells. Returns:
 * - waterDistGrid: distance-to-water in cells (Grid2D uint16)
 * - shorelineDirGrid: { dxGrid, dzGrid } — at each near-water cell, the direction
 *   parallel to the nearest shoreline (derived from gradient of the distance field)
 */
export function computeWaterDistanceField(waterMask, elevation, seaLevel, w, h) {
  const MAX_DIST = 65535;
  const waterDistGrid = new Grid2D(w, h, { type: 'uint16', fill: MAX_DIST });
  const queue = [];

  // Seed BFS from all water/below-sea-level cells
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const isWater = (waterMask && waterMask.get(gx, gz) > 0) ||
                      (seaLevel !== null && elevation.get(gx, gz) < seaLevel);
      if (isWater) {
        waterDistGrid.set(gx, gz, 0);
        queue.push(gx + gz * w);
      }
    }
  }

  // BFS
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++];
    const gx = key % w;
    const gz = (key - gx) / w;
    const dist = waterDistGrid.get(gx, gz);

    for (const [dx, dz] of DIRS) {
      const nx = gx + dx, nz = gz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      if (waterDistGrid.get(nx, nz) <= dist + 1) continue;
      waterDistGrid.set(nx, nz, dist + 1);
      queue.push(nx + nz * w);
    }
  }

  // Shoreline direction: gradient of distance field (perpendicular to shoreline = distance gradient;
  // parallel = 90-degree rotation of that gradient)
  const shoreDxGrid = new Grid2D(w, h, { type: 'float32' });
  const shoreDzGrid = new Grid2D(w, h, { type: 'float32' });

  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      if (waterDistGrid.get(gx, gz) === 0) continue;
      // Gradient of distance field points away from water (perpendicular to shore)
      const gradX = (waterDistGrid.get(gx + 1, gz) - waterDistGrid.get(gx - 1, gz)) / 2;
      const gradZ = (waterDistGrid.get(gx, gz + 1) - waterDistGrid.get(gx, gz - 1)) / 2;
      // Rotate 90 degrees to get shore-parallel direction
      const len = Math.sqrt(gradX * gradX + gradZ * gradZ) || 1;
      shoreDxGrid.set(gx, gz, -gradZ / len);
      shoreDzGrid.set(gx, gz, gradX / len);
    }
  }

  return {
    waterDistGrid,
    shorelineDirGrid: { dxGrid: shoreDxGrid, dzGrid: shoreDzGrid },
  };
}

/**
 * Compute a 0-1 terrain attraction grid for frontier priority scoring.
 * High values = desirable places to build roads toward.
 */
export function computeTerrainAttraction(elevation, slope, waterDistGrid, w, h, seaLevel) {
  const attraction = new Grid2D(w, h, { type: 'float32' });

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const elev = elevation.get(gx, gz);
      if (seaLevel !== null && elev < seaLevel) continue;

      const s = slope ? slope.get(gx, gz) : 0;
      const wDist = waterDistGrid.get(gx, gz);

      // Waterfront bonus (within 10 cells)
      const waterfrontBonus = wDist < 10 ? 0.4 * (1 - wDist / 10) : 0;

      // Gentle slope bonus (flat land is easy to build, moderate slopes can be graded)
      const slopeBonus = s < 0.05 ? 0.3 : s < 0.1 ? 0.25 : s < 0.2 ? 0.15 : s < 0.3 ? 0.05 : 0;

      // Steep slope penalty (only truly steep terrain is unbuildable)
      const steepPenalty = s > 0.5 ? -0.3 : s > 0.4 ? -0.2 : s > 0.3 ? -0.1 : 0;

      const score = Math.max(0, Math.min(1,
        0.3 + waterfrontBonus + slopeBonus + steepPenalty));
      attraction.set(gx, gz, score);
    }
  }

  return attraction;
}

/**
 * BFS flood from all road cells on the occupancy grid.
 * Returns a Uint16Array at occupancy resolution with distance-to-nearest-road in cells.
 */
export function computeRoadDistanceField(occupancy) {
  const { data, width: aw, height: ah } = occupancy;
  const ROAD = 1, JUNCTION = 3;
  const MAX_DIST = 65535;
  const dist = new Uint16Array(aw * ah).fill(MAX_DIST);
  const queue = [];

  for (let i = 0; i < data.length; i++) {
    if (data[i] === ROAD || data[i] === JUNCTION) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  const DIRS = [-1, 1, -aw, aw];
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const d = dist[idx];
    if (d > 10) break; // Only compute within ~30m at 3m resolution

    for (const offset of DIRS) {
      const ni = idx + offset;
      if (ni < 0 || ni >= dist.length) continue;
      // Prevent wrapping across rows
      if (offset === -1 && (idx % aw) === 0) continue;
      if (offset === 1 && ((idx + 1) % aw) === 0) continue;
      if (dist[ni] <= d + 1) continue;
      dist[ni] = d + 1;
      queue.push(ni);
    }
  }

  return dist;
}
