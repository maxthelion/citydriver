/**
 * Classify water cells into sea, lake, and river.
 * Produces a waterType grid: 0=land, 1=sea, 2=lake, 3=river.
 *
 * Sea: water connected to the map boundary (flood-fill from edges).
 * River: cells painted from river path data.
 * Lake: remaining water (enclosed bodies not touching boundary).
 */

import { Grid2D } from '../core/Grid2D.js';

export const WATER_LAND = 0;
export const WATER_SEA = 1;
export const WATER_LAKE = 2;
export const WATER_RIVER = 3;

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 */
export function classifyWater(cityLayers) {
  const params = cityLayers.getData('params');
  const waterMask = cityLayers.getGrid('waterMask');
  const elevation = cityLayers.getGrid('elevation');
  if (!params || !waterMask) return;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;

  const waterType = new Grid2D(w, h, { type: 'uint8', cellSize: cs });

  // Step 1: Mark all water cells initially
  // Build a set of all water cell indices for BFS
  const isWater = new Uint8Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (waterMask.get(gx, gz) > 0 || elevation.get(gx, gz) < seaLevel) {
        isWater[gz * w + gx] = 1;
      }
    }
  }

  // Step 2: Flood-fill from boundary water cells to identify sea
  const visited = new Uint8Array(w * h);
  const queue = [];

  // Seed from all water cells on the map boundary
  for (let gx = 0; gx < w; gx++) {
    if (isWater[gx]) { queue.push(gx); visited[gx] = 1; }
    const bottom = (h - 1) * w + gx;
    if (isWater[bottom]) { queue.push(bottom); visited[bottom] = 1; }
  }
  for (let gz = 1; gz < h - 1; gz++) {
    const left = gz * w;
    const right = gz * w + (w - 1);
    if (isWater[left]) { queue.push(left); visited[left] = 1; }
    if (isWater[right]) { queue.push(right); visited[right] = 1; }
  }

  // BFS to find all connected sea cells
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const gx = idx % w;
    const gz = (idx - gx) / w;
    waterType.set(gx, gz, WATER_SEA);

    for (const [dx, dz] of DIRS) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      const ni = nz * w + nx;
      if (visited[ni] || !isWater[ni]) continue;
      visited[ni] = 1;
      queue.push(ni);
    }
  }

  // Step 3: Mark river cells from riverPaths
  const riverPaths = cityLayers.getData('riverPaths');
  const isRiver = new Uint8Array(w * h);
  if (riverPaths) {
    for (const path of riverPaths) {
      paintRiverCells(path.points, isRiver, w, h, cs);
    }
  }

  // Step 4: Classify remaining water cells
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (waterType.get(gx, gz) !== WATER_LAND) continue; // already sea
      if (!isWater[gz * w + gx]) continue; // not water

      if (isRiver[gz * w + gx]) {
        waterType.set(gx, gz, WATER_RIVER);
      } else {
        waterType.set(gx, gz, WATER_LAKE);
      }
    }
  }

  cityLayers.setGrid('waterType', waterType);
}

/**
 * Mark cells along a river path as river in the isRiver array.
 */
function paintRiverCells(points, isRiver, w, h, cs) {
  if (!points || points.length < 2) return;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 0.01) continue;

    const stepSize = cs * 0.5;
    const steps = Math.ceil(segLen / stepSize);

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const halfW = (a.width * (1 - t) + b.width * t) / 2;
      const cellRadius = Math.ceil(halfW / cs);
      const cgx = Math.floor(px / cs);
      const cgz = Math.floor(pz / cs);

      for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
        for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
          const gx = cgx + ddx;
          const gz = cgz + ddz;
          if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
          const cellCenterX = gx * cs + cs / 2;
          const cellCenterZ = gz * cs + cs / 2;
          const distSq = (cellCenterX - px) ** 2 + (cellCenterZ - pz) ** 2;
          if (distSq <= halfW * halfW) {
            isRiver[gz * w + gx] = 1;
          }
        }
      }
    }
  }
}
