/**
 * Pipeline step: compute spatial layers for archetype reservation.
 * Reads: terrainSuitability, waterDist, waterMask, roadGrid, nuclei
 * Writes: centrality, waterfrontness, edgeness, roadFrontage, downwindness (layers)
 */

import { Grid2D } from '../../core/Grid2D.js';

const CENTRALITY_FALLOFF_M = 300;
const WATERFRONT_RANGE_M = 100;
const ROAD_BLUR_RADIUS = 4; // cells

/**
 * @param {object} map - FeatureMap with getLayer/setLayer, nuclei, dimensions
 * @returns {object} map (for chaining)
 */
export function computeSpatialLayers(map) {
  const { width, height, cellSize, originX, originZ } = map;
  const terrain = map.getLayer('terrainSuitability');
  const waterDist = map.hasLayer('waterDist') ? map.getLayer('waterDist') : null;
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const opts = { type: 'float32', cellSize, originX, originZ };

  // --- Centrality ---
  const centrality = new Grid2D(width, height, opts);
  const falloffCells = CENTRALITY_FALLOFF_M / cellSize;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      let minDist = Infinity;
      for (const n of map.nuclei) {
        const dx = gx - n.gx, dz = gz - n.gz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < minDist) minDist = d;
      }
      const raw = 1 / (1 + minDist / falloffCells);
      centrality.set(gx, gz, raw * terrain.get(gx, gz));
    }
  }
  map.setLayer('centrality', centrality);

  // --- Waterfrontness ---
  const waterfrontness = new Grid2D(width, height, opts);
  if (waterDist) {
    const rangeCells = WATERFRONT_RANGE_M / cellSize;
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        const wd = waterDist.get(gx, gz);
        const raw = Math.max(0, 1 - wd / rangeCells);
        waterfrontness.set(gx, gz, raw * terrain.get(gx, gz));
      }
    }
  }
  map.setLayer('waterfrontness', waterfrontness);

  // --- Edgeness ---
  const edgeness = new Grid2D(width, height, opts);
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      edgeness.set(gx, gz, (1 - centrality.get(gx, gz)) * terrain.get(gx, gz));
    }
  }
  map.setLayer('edgeness', edgeness);

  // --- Road Frontage ---
  const roadFrontage = new Grid2D(width, height, opts);
  if (roadGrid) {
    const r = ROAD_BLUR_RADIUS;
    let maxVal = 0;
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        let sum = 0;
        const x0 = Math.max(0, gx - r), x1 = Math.min(width - 1, gx + r);
        const z0 = Math.max(0, gz - r), z1 = Math.min(height - 1, gz + r);
        for (let nz = z0; nz <= z1; nz++) {
          for (let nx = x0; nx <= x1; nx++) {
            sum += roadGrid.get(nx, nz);
          }
        }
        roadFrontage.set(gx, gz, sum);
        if (sum > maxVal) maxVal = sum;
      }
    }
    if (maxVal > 0) {
      for (let gz = 0; gz < height; gz++) {
        for (let gx = 0; gx < width; gx++) {
          roadFrontage.set(gx, gz,
            (roadFrontage.get(gx, gz) / maxVal) * terrain.get(gx, gz));
        }
      }
    }
  }
  map.setLayer('roadFrontage', roadFrontage);

  // --- Downwindness ---
  const windAngle = map.prevailingWindAngle ?? (map.rng ? map.rng.next() * Math.PI * 2 : Math.PI);
  const windDirX = Math.cos(windAngle);
  const windDirZ = Math.sin(windAngle);
  const cx = width / 2, cz = height / 2;

  const downwindness = new Grid2D(width, height, opts);
  let minDot = Infinity, maxDot = -Infinity;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const dot = (gx - cx) * windDirX + (gz - cz) * windDirZ;
      downwindness.set(gx, gz, dot);
      if (dot < minDot) minDot = dot;
      if (dot > maxDot) maxDot = dot;
    }
  }
  const dotRange = maxDot - minDot || 1;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const norm = (downwindness.get(gx, gz) - minDot) / dotRange;
      downwindness.set(gx, gz, norm * terrain.get(gx, gz));
    }
  }
  map.setLayer('downwindness', downwindness);

  return map;
}
