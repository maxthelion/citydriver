/**
 * Value layer composition.
 *
 * Combines multiple named spatial / influence layers into a single
 * "value bitmap" (Float32Array) per zone type by taking a weighted sum.
 * The result is used by allocateFromValueBitmap to rank candidate cells.
 */

/**
 * Compose a single value layer as a weighted sum of input layers.
 *
 * Each entry in `composition` is { layerName: weight }. For every cell the
 * output value is:
 *
 *   sum(weight_i * layers[name_i].get(gx, gz))   for all (name_i, weight_i)
 *
 * Layers that are absent from `layers` are silently skipped (weight ignored).
 * The result is clamped to [0, 1].
 *
 * @param {object} composition - { layerName: weight, ... }
 * @param {object} layers - { layerName: Grid2D | { get(gx,gz): number } | Float32Array, ... }
 *   Layer accessors. A Float32Array at key `name` is also accepted; in that
 *   case the function accesses it via `layers[name][gz * w + gx]`.
 * @param {number} w - Grid width
 * @param {number} h - Grid height
 * @returns {Float32Array} Composed value bitmap (length = w * h)
 */
export function composeValueLayer(composition, layers, w, h) {
  const out = new Float32Array(w * h);
  const entries = Object.entries(composition);

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      let sum = 0;
      for (const [name, weight] of entries) {
        const layer = layers[name];
        if (layer == null) continue;
        let val;
        if (layer instanceof Float32Array || layer instanceof Uint8Array || layer instanceof Int32Array) {
          val = layer[gz * w + gx];
        } else {
          // Assumes a Grid2D-like object with a .get(gx, gz) method
          val = layer.get(gx, gz);
        }
        sum += weight * val;
      }
      // Clamp to [0, 1]
      out[gz * w + gx] = Math.min(1, Math.max(0, sum));
    }
  }

  return out;
}

/**
 * Compose value layers for all zone types.
 *
 * @param {object} valueComposition - Map of zoneName → composition object
 *   e.g. { commercial: { centrality: 0.6, roadFrontage: 2.0 }, ... }
 * @param {object} layers - All available layers (Grid2D or Float32Array, keyed by name)
 * @param {number} w - Grid width
 * @param {number} h - Grid height
 * @returns {object} Map of zoneName → Float32Array value bitmap
 */
export function composeAllValueLayers(valueComposition, layers, w, h) {
  const result = {};
  for (const [zoneName, composition] of Object.entries(valueComposition)) {
    result[zoneName] = composeValueLayer(composition, layers, w, h);
  }
  return result;
}
