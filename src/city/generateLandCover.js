/**
 * B12. Urban land cover.
 * Parks, gardens, river buffers, woodland on slopes.
 */

import { Grid2D } from '../core/Grid2D.js';

export const URBAN_COVER = {
  NONE: 0,
  GARDEN: 1,
  PARK: 2,
  WOODLAND: 3,
  RIVER_BUFFER: 4,
  PAVED: 5,
};

/**
 * Generate urban land cover grid.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {Array} amenities
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Grid2D}
 */
export function generateCityLandCover(cityLayers, amenities, rng) {
  const params = cityLayers.getData('params');
  const density = cityLayers.getGrid('density');
  const slope = cityLayers.getGrid('slope');
  const waterMask = cityLayers.getGrid('waterMask');
  const elevation = cityLayers.getGrid('elevation');

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel;

  const cover = new Grid2D(w, h, { type: 'uint8', cellSize: cs });

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (waterMask && waterMask.get(gx, gz) > 0) continue;
      if (elevation && elevation.get(gx, gz) < seaLevel) continue;

      const d = density ? density.get(gx, gz) : 0;
      const s = slope ? slope.get(gx, gz) : 0;

      // River buffer: near water
      if (waterMask) {
        let nearWater = false;
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0], [0, -2], [0, 2]]) {
          if (waterMask.get(gx + dx, gz + dz) > 0) { nearWater = true; break; }
        }
        if (nearWater) {
          cover.set(gx, gz, URBAN_COVER.RIVER_BUFFER);
          continue;
        }
      }

      // Woodland on steep slopes
      if (s > 0.2 && d < 0.1) {
        cover.set(gx, gz, URBAN_COVER.WOODLAND);
        continue;
      }

      // Gardens in suburban areas
      if (d > 0.1 && d < 0.4) {
        cover.set(gx, gz, URBAN_COVER.GARDEN);
        continue;
      }

      // Paved in dense areas
      if (d > 0.4) {
        cover.set(gx, gz, URBAN_COVER.PAVED);
        continue;
      }
    }
  }

  // Mark parks from amenities
  for (const a of amenities) {
    if (a.type !== 'park') continue;
    const parkGx = Math.round(a.x / cs);
    const parkGz = Math.round(a.z / cs);
    const radius = Math.round(a.radius / cs);

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        const gx = parkGx + dx;
        const gz = parkGz + dz;
        if (gx >= 0 && gx < w && gz >= 0 && gz < h) {
          cover.set(gx, gz, URBAN_COVER.PARK);
        }
      }
    }
  }

  return cover;
}
