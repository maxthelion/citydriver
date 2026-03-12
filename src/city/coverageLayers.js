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
