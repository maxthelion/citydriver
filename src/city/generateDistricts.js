/**
 * B5. District division — arterials and natural features carve the city into districts.
 * Assigns character: commercial core, dense residential, suburban, industrial, parkland.
 */

import { Grid2D } from '../core/Grid2D.js';
import { smoothstep } from '../core/math.js';

/**
 * District types.
 */
export const DISTRICT = {
  COMMERCIAL: 0,
  DENSE_RESIDENTIAL: 1,
  SUBURBAN: 2,
  INDUSTRIAL: 3,
  PARKLAND: 4,
};

/**
 * Generate district assignments.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Grid2D} - district type per cell
 */
export function generateDistricts(cityLayers, graph, rng) {
  const params = cityLayers.getData('params');
  const density = cityLayers.getGrid('density');
  const elevation = cityLayers.getGrid('elevation');
  const slope = cityLayers.getGrid('slope');
  const waterMask = cityLayers.getGrid('waterMask');

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel;

  const districts = new Grid2D(w, h, { type: 'uint8', cellSize: cs });

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (waterMask && waterMask.get(gx, gz) > 0) continue;
      if (elevation.get(gx, gz) < seaLevel) continue;

      const d = density ? density.get(gx, gz) : 0;
      const s = slope ? slope.get(gx, gz) : 0;

      let district;
      if (d > 0.7) {
        district = DISTRICT.COMMERCIAL;
      } else if (d > 0.4) {
        district = DISTRICT.DENSE_RESIDENTIAL;
      } else if (d > 0.15) {
        district = DISTRICT.SUBURBAN;
      } else if (s > 0.15 || d < 0.05) {
        district = DISTRICT.PARKLAND;
      } else {
        district = DISTRICT.SUBURBAN;
      }

      // Industrial near water + low density
      if (waterMask) {
        let nearWater = false;
        for (const [dx, dz] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
          if (waterMask.get(gx + dx, gz + dz) > 0) { nearWater = true; break; }
        }
        if (nearWater && d > 0.1 && d < 0.4 && s < 0.1) {
          district = DISTRICT.INDUSTRIAL;
        }
      }

      districts.set(gx, gz, district);
    }
  }

  return districts;
}
