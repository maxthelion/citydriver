/**
 * C6. Neighborhood influence fields.
 * Each nucleus radiates density. Combined field replaces the abstract
 * radial density. Districts are assigned by dominant neighborhood.
 */

import { Grid2D } from '../core/Grid2D.js';
import { distance2D } from '../core/math.js';

/** District types matching the existing DISTRICT enum in generateDistricts.js */
const DISTRICT = {
  COMMERCIAL: 0,
  DENSE_RESIDENTIAL: 1,
  SUBURBAN: 2,
  INDUSTRIAL: 3,
  PARKLAND: 4,
};

const TYPE_TO_DISTRICT = {
  oldTown: DISTRICT.COMMERCIAL,
  waterfront: DISTRICT.INDUSTRIAL,
  market: DISTRICT.COMMERCIAL,
  roadside: DISTRICT.DENSE_RESIDENTIAL,
  hilltop: DISTRICT.SUBURBAN,
  valley: DISTRICT.SUBURBAN,
  suburban: DISTRICT.SUBURBAN,
  industrial: DISTRICT.INDUSTRIAL,
};

/** How quickly density falls off per neighborhood type. Lower = more compact. */
const TYPE_FALLOFF = {
  oldTown: 0.6,
  waterfront: 0.8,
  market: 0.7,
  roadside: 0.9,
  hilltop: 1.0,
  valley: 0.9,
  suburban: 1.2,
  industrial: 0.8,
};

/**
 * Compute density field and district grid from neighborhood nuclei.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {Array} neighborhoods
 * @returns {{ density: Grid2D, districts: Grid2D, ownership: Grid2D }}
 */
export function computeNeighborhoodInfluence(cityLayers, neighborhoods) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const slope = cityLayers.getGrid('slope');
  const waterMask = cityLayers.getGrid('waterMask');

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;

  const density = new Grid2D(w, h, { cellSize: cs });
  const districts = new Grid2D(w, h, { type: 'uint8', cellSize: cs });
  // Ownership: which neighborhood index dominates each cell (-1 = none)
  const ownership = new Grid2D(w, h, { type: 'int32', cellSize: cs, fill: -1 });

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      // Skip unbuildable cells
      if (waterMask && waterMask.get(gx, gz) > 0) continue;
      if (elevation.get(gx, gz) < seaLevel) continue;

      const s = slope ? slope.get(gx, gz) : 0;
      const slopePenalty = Math.max(0, 1.0 - s * 4);

      let maxDensity = 0;
      let dominantIdx = -1;

      for (let i = 0; i < neighborhoods.length; i++) {
        const n = neighborhoods[i];
        const dist = distance2D(gx, gz, n.gx, n.gz);
        if (dist > n.radius * 1.5) continue; // Skip distant nuclei

        const falloffRate = TYPE_FALLOFF[n.type] ?? 1.0;
        const t = dist / n.radius;
        // Smooth falloff: 1 at center, 0 at radius
        const radial = Math.max(0, 1.0 - t * falloffRate);
        const influence = n.importance * radial * radial * slopePenalty;

        if (influence > maxDensity) {
          maxDensity = influence;
          dominantIdx = i;
        }
      }

      density.set(gx, gz, Math.min(1, maxDensity));

      if (dominantIdx >= 0 && maxDensity > 0.05) {
        ownership.set(gx, gz, dominantIdx);

        // District from neighborhood type, modified by density
        const nType = neighborhoods[dominantIdx].type;
        let district = TYPE_TO_DISTRICT[nType] ?? DISTRICT.SUBURBAN;

        // High-density areas near old town or market become commercial
        if (maxDensity > 0.6 && (nType === 'oldTown' || nType === 'market' || nType === 'roadside')) {
          district = DISTRICT.COMMERCIAL;
        }
        // Medium density in commercial areas becomes dense residential
        else if (maxDensity > 0.3 && maxDensity <= 0.6 && district === DISTRICT.COMMERCIAL) {
          district = DISTRICT.DENSE_RESIDENTIAL;
        }
        // Low-density anywhere becomes suburban or parkland
        if (maxDensity < 0.15 && s > 0.1) {
          district = DISTRICT.PARKLAND;
        }

        districts.set(gx, gz, district);
      } else if (maxDensity <= 0.05) {
        // Outside all neighborhoods: parkland if steep, suburban fringe if flat
        if (s > 0.15) districts.set(gx, gz, DISTRICT.PARKLAND);
      }
    }
  }

  return { density, districts, ownership };
}
