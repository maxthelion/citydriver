/**
 * B11. Amenity placement.
 * Schools, parks, commercial frontages placed using catchment rules.
 */

import { distance2D } from '../core/math.js';

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {Array} buildings
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<{type, x, z, radius}>}
 */
export function generateAmenities(cityLayers, buildings, rng) {
  const params = cityLayers.getData('params');
  const density = cityLayers.getGrid('density');
  const cs = params.cellSize;
  const w = params.width;
  const h = params.height;

  const amenities = [];

  // Place amenities at density peaks
  const placed = [];

  // Parks — in areas with moderate density and good spacing
  const parkSpacing = cs * 30;
  for (let gz = 10; gz < h - 10; gz += 8) {
    for (let gx = 10; gx < w - 10; gx += 8) {
      const d = density ? density.get(gx, gz) : 0;
      if (d < 0.15 || d > 0.6) continue;

      const x = gx * cs;
      const z = gz * cs;

      // Check spacing from other parks
      let tooClose = false;
      for (const p of placed) {
        if (p.type === 'park' && distance2D(x, z, p.x, p.z) < parkSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      if (rng.next() > 0.7) {
        const park = { type: 'park', x, z, radius: cs * 5 + rng.range(0, cs * 3) };
        amenities.push(park);
        placed.push(park);
      }
    }
  }

  // Schools — one per ~400m catchment
  const schoolSpacing = cs * 40;
  for (let gz = 15; gz < h - 15; gz += 12) {
    for (let gx = 15; gx < w - 15; gx += 12) {
      const d = density ? density.get(gx, gz) : 0;
      if (d < 0.2) continue;

      const x = gx * cs;
      const z = gz * cs;

      let tooClose = false;
      for (const p of placed) {
        if (p.type === 'school' && distance2D(x, z, p.x, p.z) < schoolSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      if (rng.next() > 0.6) {
        const school = { type: 'school', x, z, radius: cs * 3 };
        amenities.push(school);
        placed.push(school);
      }
    }
  }

  return amenities;
}
