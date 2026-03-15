/**
 * Pipeline step: compute land value from terrain features.
 * Reads: slope, waterMask, waterDist, terrainSuitability, nuclei
 * Writes: landValue (layer)
 */

import { Grid2D } from '../../core/Grid2D.js';

// Land value constants
const LV_FLATNESS_WEIGHT = 0.6;
const LV_PROXIMITY_WEIGHT = 0.4;
const LV_FLATNESS_RADIUS_M = 15;
const LV_FLATNESS_MAX_SLOPE = 0.4;
const LV_PROXIMITY_FALLOFF_M = 200;
const LV_WATER_BONUS_MAX = 0.15;
const LV_WATER_BONUS_RANGE_M = 50;
const LV_BUILDABLE_FLOOR = 0.2;

/**
 * @param {object} map - FeatureMap with getLayer/setLayer, nuclei, dimensions
 * @returns {object} map (for chaining)
 */
export function computeLandValue(map) {
  const w = map.width;
  const h = map.height;
  const cs = map.cellSize;

  const slope = map.getLayer('slope');
  const waterMask = map.getLayer('waterMask');
  const waterDist = map.hasLayer('waterDist') ? map.getLayer('waterDist') : null;
  const terrainSuitability = map.hasLayer('terrainSuitability')
    ? map.getLayer('terrainSuitability') : null;

  // Pre-compute local flatness: average slope in a radius around each cell
  const flatnessR = Math.max(1, Math.round(LV_FLATNESS_RADIUS_M / cs));
  const flatness = new Float32Array(w * h);
  if (slope) {
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        let sum = 0, count = 0;
        const r = flatnessR;
        const gxMin = Math.max(0, gx - r), gxMax = Math.min(w - 1, gx + r);
        const gzMin = Math.max(0, gz - r), gzMax = Math.min(h - 1, gz + r);
        for (let nz = gzMin; nz <= gzMax; nz++) {
          for (let nx = gxMin; nx <= gxMax; nx++) {
            sum += slope.get(nx, nz);
            count++;
          }
        }
        const avgSlope = sum / count;
        flatness[gz * w + gx] = 1.0 - Math.min(1, avgSlope / LV_FLATNESS_MAX_SLOPE);
      }
    }
  }

  const waterBonusRange = Math.round(LV_WATER_BONUS_RANGE_M / cs);

  // Nucleus centers for proximity calculation
  const nucleiWorld = [];
  if (map.nuclei && map.nuclei.length > 0) {
    for (const n of map.nuclei) {
      nucleiWorld.push({
        wx: map.originX + n.gx * cs,
        wz: map.originZ + n.gz * cs,
      });
    }
  } else if (map.settlement) {
    const params = map.regionalLayers?.getData('params');
    const rcs = params?.cellSize || 50;
    nucleiWorld.push({
      wx: map.settlement.gx * rcs,
      wz: map.settlement.gz * rcs,
    });
  }

  const landValue = new Grid2D(w, h, {
    type: 'float32',
    cellSize: cs,
    originX: map.originX,
    originZ: map.originZ,
  });

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (waterMask.get(gx, gz) > 0) continue; // stays 0

      const localFlatness = flatness[gz * w + gx];

      // Proximity to nearest nucleus
      const wx = map.originX + gx * cs;
      const wz = map.originZ + gz * cs;
      let minDist = Infinity;
      for (const nc of nucleiWorld) {
        const dx = wx - nc.wx, dz = wz - nc.wz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < minDist) minDist = d;
      }
      const proximity = 1.0 / (1.0 + minDist / LV_PROXIMITY_FALLOFF_M);

      let base = localFlatness * LV_FLATNESS_WEIGHT + proximity * LV_PROXIMITY_WEIGHT;

      // Water bonus
      let waterBonus = 0;
      if (waterDist) {
        const wd = waterDist.get(gx, gz);
        if (wd > 0 && wd <= waterBonusRange) {
          waterBonus = LV_WATER_BONUS_MAX * (1 - wd / waterBonusRange);
        }
      }

      let v = base + waterBonus;

      // Floor for buildable land
      if (terrainSuitability && terrainSuitability.get(gx, gz) > LV_BUILDABLE_FLOOR) {
        v = Math.max(v, LV_BUILDABLE_FLOOR);
      }

      landValue.set(gx, gz, v);
    }
  }

  map.setLayer('landValue', landValue);
  return map;
}
