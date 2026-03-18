/**
 * Unified coverage layer system.
 * Produces continuous float layers from discrete cell data for organic rendering boundaries.
 */

/**
 * Two-pass separable box blur. Returns a new Float32Array.
 * Edge cells clamp to boundary (no wrap).
 */
export function separableBoxBlur(grid, w, h, radius) {
  const size = radius * 2 + 1;
  const tmp = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        sum += grid[z * w + Math.max(0, Math.min(w - 1, x + dx))];
      }
      tmp[z * w + x] = sum / size;
    }
  }
  const out = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dz = -radius; dz <= radius; dz++) {
        sum += tmp[Math.max(0, Math.min(h - 1, z + dz)) * w + x];
      }
      out[z * w + x] = sum / size;
    }
  }
  return out;
}

/**
 * Deterministic hash → [0, 1].
 */
function hashNorm(a, b, seed) {
  let h = (a * 374761393 + b * 668265263 + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 1911520717);
  h = h ^ (h >>> 13);
  return ((h >>> 0) & 0xffffff) / 0xffffff;
}

/**
 * Perturb grid values with deterministic noise.
 * Amplitude scales parabolically: 4*v*(1-v), so cells at 0 or 1 are unaffected.
 * Returns a new Float32Array.
 */
export function applyHashNoise(grid, w, h, baseAmplitude, seed) {
  const out = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const idx = z * w + x;
      const v = grid[idx];
      const scale = 4 * v * (1 - v);
      const noise = (hashNorm(x, z, seed) - 0.5) * 2 * baseAmplitude * scale;
      out[idx] = Math.max(0, Math.min(1, v + noise));
    }
  }
  return out;
}

/**
 * Stamp water mask onto a float grid. Returns Float32Array.
 */
export function stampWater(map) {
  const { width: w, height: h } = map;
  const out = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (map.waterMask.get(gx, gz) > 0) out[gz * w + gx] = 1.0;
    }
  }
  return out;
}

/**
 * Stamp railway grid with 3-cell buffer. Returns Float32Array.
 */
export function stampRailway(map) {
  const { width: w, height: h } = map;
  const out = new Float32Array(w * h);
  if (!map.railwayGrid) return out;
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (map.railwayGrid.get(gx, gz) === 0) continue;
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < w && nz < h) {
            out[nz * w + nx] = 1.0;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Stamp road grid with 2-cell buffer. Returns Float32Array.
 */
export function stampRoad(map) {
  const { width: w, height: h } = map;
  const out = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (map.roadGrid.get(gx, gz) === 0) continue;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < w && nz < h) {
            out[nz * w + nx] = 1.0;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Stamp development zones + regional settlement cells. Returns Float32Array.
 * Includes road cells + 2-cell buffer (matches old _buildDevelopedProximity behavior).
 */
export function stampDevelopment(map) {
  const { width: w, height: h, cellSize: cs } = map;
  const out = new Float32Array(w * h);

  if (map.developmentZones) {
    for (const zone of map.developmentZones) {
      for (const c of zone.cells) out[c.gz * w + c.gx] = 1.0;
    }
  }

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (map.roadGrid.get(gx, gz) === 0) continue;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < w && nz < h) {
            out[nz * w + nx] = 1.0;
          }
        }
      }
    }
  }

  const regionalLandCover = map.regionalLayers.getGrid('landCover');
  const rcs = map.regionalLayers.getData('params').cellSize;
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (out[gz * w + gx] > 0) continue;
      const wx = map.originX + gx * cs;
      const wz = map.originZ + gz * cs;
      const rx = Math.min(Math.round(wx / rcs), regionalLandCover.width - 1);
      const rz = Math.min(Math.round(wz / rcs), regionalLandCover.height - 1);
      if (regionalLandCover.get(rx, rz) === 5) out[gz * w + gx] = 1.0;
    }
  }

  return out;
}

/**
 * Stamp forest cells (landCover=2 or 6) from regional grid. Returns Float32Array.
 * Uses nearest-neighbor lookup (blur handles smoothing).
 */
export function stampForest(map) {
  const { width: w, height: h, cellSize: cs } = map;
  const out = new Float32Array(w * h);
  const regionalLandCover = map.regionalLayers.getGrid('landCover');
  const rcs = map.regionalLayers.getData('params').cellSize;

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const wx = map.originX + gx * cs;
      const wz = map.originZ + gz * cs;
      const rx = Math.min(Math.round(wx / rcs), regionalLandCover.width - 1);
      const rz = Math.min(Math.round(wz / rcs), regionalLandCover.height - 1);
      const cover = regionalLandCover.get(rx, rz);
      if (cover === 2) out[gz * w + gx] = 1.0;
      else if (cover === 6) out[gz * w + gx] = 0.6;
    }
  }
  return out;
}

/**
 * Stamp remaining land cover types (farmland=1, moorland=3, marsh=4, bare rock=7, scrub=8).
 * Returns an object { data: Float32Array, dominantCover: Uint8Array }.
 */
export function stampLandCover(map) {
  const { width: w, height: h, cellSize: cs } = map;
  const data = new Float32Array(w * h);
  const dominantCover = new Uint8Array(w * h);
  const regionalLandCover = map.regionalLayers.getGrid('landCover');
  const rcs = map.regionalLayers.getData('params').cellSize;

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const wx = map.originX + gx * cs;
      const wz = map.originZ + gz * cs;
      const rx = Math.min(Math.round(wx / rcs), regionalLandCover.width - 1);
      const rz = Math.min(Math.round(wz / rcs), regionalLandCover.height - 1);
      const cover = regionalLandCover.get(rx, rz);
      if (cover === 1 || cover === 3 || cover === 4 || cover === 7 || cover === 8) {
        data[gz * w + gx] = 1.0;
        dominantCover[gz * w + gx] = cover;
      }
    }
  }
  return { data, dominantCover };
}

/**
 * Enforce priority suppression across layers.
 * Layers are in priority order (index 0 = highest).
 * Each layer object must have a `.data` Float32Array.
 * Mutates layer data in-place.
 */
export function enforcePriority(layers, w, h) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    let available = 1.0;
    for (const layer of layers) {
      layer.data[i] = Math.min(layer.data[i], available);
      available -= layer.data[i];
      available = Math.max(0, available);
    }
  }
}

/** Layer definitions: name, stamp function, blur radius, noise amplitude, seed offset. */
const LAYER_DEFS = [
  { name: 'water',       stamp: stampWater,       blur: 6, noise: 0.15, seed: 1 },
  { name: 'railway',     stamp: stampRailway,     blur: 2, noise: 0.05, seed: 6 },
  { name: 'road',        stamp: stampRoad,        blur: 3, noise: 0.10, seed: 2 },
  { name: 'development', stamp: stampDevelopment, blur: 8, noise: 0.15, seed: 3 },
  { name: 'forest',      stamp: stampForest,      blur: 12, noise: 0.25, seed: 4 },
];

/**
 * Compute all coverage layers for the given city map.
 * Returns { water, road, development, forest, landCover, dominantCover }.
 */
export function computeCoverageLayers(map, seed = 42) {
  const { width: w, height: h } = map;

  const ordered = [];
  const result = {};
  for (const def of LAYER_DEFS) {
    let data = def.stamp(map);
    data = separableBoxBlur(data, w, h, def.blur);
    data = applyHashNoise(data, w, h, def.noise, seed + def.seed);
    ordered.push({ data });
    result[def.name] = data;
  }

  const lc = stampLandCover(map);
  lc.data = separableBoxBlur(lc.data, w, h, 12);
  lc.data = applyHashNoise(lc.data, w, h, 0.25, seed + 5);
  ordered.push({ data: lc.data });
  result.landCover = lc.data;
  result.dominantCover = lc.dominantCover;

  enforcePriority(ordered, w, h);

  return result;
}
