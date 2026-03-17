/**
 * Influence layer computation.
 *
 * Blurs zone claim masks (from a reservation grid) into smooth proximity
 * gradients. These gradients are then used by growth agents as spatial
 * inputs for scoring candidate cells.
 */

import { RESERVATION } from './growthAgents.js';

/**
 * Separable box blur of a flat Float32Array, normalised to [0, 1].
 *
 * Uses a running-sum sliding window for O(w*h) complexity regardless of
 * radius. The horizontal pass writes to a temp buffer; the vertical pass
 * writes the final result.
 *
 * @param {Float32Array} src - Input values, row-major (length = w * h)
 * @param {number} w - Grid width
 * @param {number} h - Grid height
 * @param {number} radius - Blur half-width in cells (kernel size = 2*radius+1)
 * @returns {Float32Array} Blurred and normalised result
 */
export function boxBlur(src, w, h, radius) {
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);

  // Horizontal pass: blur rows from src → tmp
  for (let z = 0; z < h; z++) {
    let sum = 0;
    // Prime the window with the first `radius` cells
    for (let x = 0; x < Math.min(radius, w); x++) {
      sum += src[z * w + x];
    }
    for (let x = 0; x < w; x++) {
      // Add right edge of window
      const addX = x + radius;
      if (addX < w) sum += src[z * w + addX];
      // Remove left edge that falls off
      const subX = x - radius - 1;
      if (subX >= 0) sum -= src[z * w + subX];
      tmp[z * w + x] = sum;
    }
  }

  // Vertical pass: blur columns from tmp → dst
  for (let x = 0; x < w; x++) {
    let sum = 0;
    // Prime the window with the first `radius` rows
    for (let z = 0; z < Math.min(radius, h); z++) {
      sum += tmp[z * w + x];
    }
    for (let z = 0; z < h; z++) {
      // Add bottom edge of window
      const addZ = z + radius;
      if (addZ < h) sum += tmp[addZ * w + x];
      // Remove top edge that falls off
      const subZ = z - radius - 1;
      if (subZ >= 0) sum -= tmp[subZ * w + x];
      dst[z * w + x] = sum;
    }
  }

  // Normalise to [0, 1]
  let max = 0;
  for (let i = 0; i < w * h; i++) {
    if (dst[i] > max) max = dst[i];
  }
  if (max > 0) {
    for (let i = 0; i < w * h; i++) {
      dst[i] /= max;
    }
  }

  return dst;
}

/**
 * Compute influence layers by blurring zone claim masks from resGrid.
 *
 * For each entry in influenceRadii, builds a binary mask of cells that hold
 * the matching reservation type (or any of a list of types), blurs it, and
 * returns the result as a named Float32Array.
 *
 * Additionally, a special `developmentProximity` layer is always produced:
 * a blur of all non-NONE, non-AGRICULTURE cells (i.e. "anything built").
 *
 * @param {Grid2D} resGrid - Reservation grid (uint8, read-only)
 * @param {number} w - Grid width
 * @param {number} h - Grid height
 * @param {object} influenceRadii - Map of layerName → { types: number[], radius: number }
 *   where types is an array of RESERVATION values whose presence is blurred.
 * @param {Array<{gx:number, gz:number}>} [nuclei=[]] - Nucleus cells seeded
 *   into the developmentProximity mask on tick 1 to kick off frontier growth.
 * @returns {object} Map of layerName → Float32Array (length = w * h)
 */
export function computeInfluenceLayers(resGrid, w, h, influenceRadii, nuclei = []) {
  const result = {};

  // --- developmentProximity: blur of all non-NONE, non-AGRICULTURE cells ---
  const devMask = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = resGrid.data[i];
    if (v !== RESERVATION.NONE && v !== RESERVATION.AGRICULTURE) {
      devMask[i] = 1.0;
    }
  }
  // Seed nuclei so the frontier can start spreading from tick 1
  for (const n of nuclei) {
    if (n.gx >= 0 && n.gx < w && n.gz >= 0 && n.gz < h) {
      devMask[n.gz * w + n.gx] = 1.0;
    }
  }

  // Derive a default radius from the influenceRadii entries (max radius found),
  // falling back to a sensible default of 20 cells.
  let defaultRadius = 20;
  for (const cfg of Object.values(influenceRadii)) {
    if (cfg.radius > defaultRadius) defaultRadius = cfg.radius;
  }
  result.developmentProximity = boxBlur(devMask, w, h, defaultRadius);

  // --- Named influence layers from influenceRadii ---
  for (const [name, cfg] of Object.entries(influenceRadii)) {
    const { types, radius } = cfg;
    const typeSet = new Set(types);
    const mask = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (typeSet.has(resGrid.data[i])) {
        mask[i] = 1.0;
      }
    }
    result[name] = boxBlur(mask, w, h, radius);
  }

  return result;
}
