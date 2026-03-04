/**
 * A1. Geology generation.
 * Produces: rockType, erosionResistance, permeability, soilFertility, springLine grids.
 *
 * Rock types form sedimentary bands with occasional igneous intrusions.
 * Each rock type carries physical properties that drive all downstream layers.
 */

import { Grid2D } from '../core/Grid2D.js';
import { PerlinNoise } from '../core/noise.js';

// Rock type definitions with physical properties
export const ROCK_TYPES = {
  LIMESTONE:  { id: 0, name: 'limestone',  erosionResistance: 0.6, permeability: 0.8, soilFertility: 0.7, cliffTendency: 0.6, material: 'pale_stone' },
  SANDSTONE:  { id: 1, name: 'sandstone',  erosionResistance: 0.4, permeability: 0.6, soilFertility: 0.5, cliffTendency: 0.4, material: 'warm_stone' },
  GRANITE:    { id: 2, name: 'granite',    erosionResistance: 0.9, permeability: 0.1, soilFertility: 0.2, cliffTendency: 0.7, material: 'dark_stone' },
  CLAY:       { id: 3, name: 'clay',       erosionResistance: 0.2, permeability: 0.1, soilFertility: 0.8, cliffTendency: 0.1, material: 'brick' },
  CHALK:      { id: 4, name: 'chalk',      erosionResistance: 0.3, permeability: 0.9, soilFertility: 0.6, cliffTendency: 0.8, material: 'flint' },
  SHALE:      { id: 5, name: 'shale',      erosionResistance: 0.3, permeability: 0.05, soilFertility: 0.3, cliffTendency: 0.3, material: 'dark_stone' },
};

const ROCK_LIST = Object.values(ROCK_TYPES);
const NUM_ROCKS = ROCK_LIST.length;

/**
 * Generate geology layers.
 *
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.cellSize=50]
 * @param {number} [params.bandDirection=0.3] - Angle of sedimentary banding (radians)
 * @param {number} [params.bandCount=5] - Number of major rock type transitions
 * @param {number} [params.intrusionCount=2] - Number of igneous intrusions
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{ rockType: Grid2D, erosionResistance: Grid2D, permeability: Grid2D, soilFertility: Grid2D, springLine: Grid2D }}
 */
export function generateGeology(params, rng) {
  const {
    width,
    height,
    cellSize = 50,
    bandDirection = 0.3,
    bandCount = 5,
    intrusionCount = 2,
  } = params;

  const geoRng = rng.fork('geology');
  const noise = new PerlinNoise(geoRng.fork('noise'));

  const rockType = new Grid2D(width, height, { type: 'uint8', cellSize });
  const erosionResistance = new Grid2D(width, height, { cellSize });
  const permeability = new Grid2D(width, height, { cellSize });
  const soilFertility = new Grid2D(width, height, { cellSize });
  const springLine = new Grid2D(width, height, { cellSize });

  // Direction vector for banding
  const bandDx = Math.cos(bandDirection);
  const bandDz = Math.sin(bandDirection);

  // Assign rock types along bands: project each cell onto the band axis
  // and assign based on position along that axis
  const bandRockOrder = [];
  for (let i = 0; i < bandCount + 2; i++) {
    bandRockOrder.push(ROCK_LIST[geoRng.int(0, NUM_ROCKS - 1)]);
  }

  // Igneous intrusions (circles of granite)
  const intrusions = [];
  for (let i = 0; i < intrusionCount; i++) {
    intrusions.push({
      cx: geoRng.range(width * 0.15, width * 0.85),
      cz: geoRng.range(height * 0.15, height * 0.85),
      radius: geoRng.range(width * 0.04, width * 0.1),
    });
  }

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      // Project onto band direction
      const nx = gx / width;
      const nz = gz / height;
      const proj = nx * bandDx + nz * bandDz;

      // Add noise to band boundaries for irregular transitions
      const bandNoise = noise.fbm(gx * 0.03, gz * 0.03, { octaves: 3, amplitude: 0.08 });
      const bandPos = (proj + bandNoise) * bandCount;
      const bandIdx = Math.max(0, Math.min(bandRockOrder.length - 1, Math.floor(bandPos)));

      let rock = bandRockOrder[bandIdx];

      // Check for igneous intrusions
      for (const intr of intrusions) {
        const dx = gx - intr.cx;
        const dz = gz - intr.cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        // Irregular boundary using noise
        const boundaryNoise = noise.noise2D(gx * 0.1, gz * 0.1) * intr.radius * 0.3;
        if (dist < intr.radius + boundaryNoise) {
          rock = ROCK_TYPES.GRANITE;
        }
      }

      rockType.set(gx, gz, rock.id);
      erosionResistance.set(gx, gz, rock.erosionResistance);
      permeability.set(gx, gz, rock.permeability);
      soilFertility.set(gx, gz, rock.soilFertility);
    }
  }

  // Spring line: boundary between permeable and impermeable rock
  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      const perm = permeability.get(gx, gz);
      let isSpring = 0;

      // Check neighbors for permeability change
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const neighborPerm = permeability.get(gx + dx, gz + dz);
        // Spring line where permeable rock meets impermeable
        if (perm > 0.4 && neighborPerm < 0.2) {
          isSpring = 1;
          break;
        }
      }

      springLine.set(gx, gz, isSpring);
    }
  }

  return { rockType, erosionResistance, permeability, soilFertility, springLine };
}

/**
 * Get rock type info from ID.
 */
export function getRockInfo(id) {
  return ROCK_LIST[id] || ROCK_LIST[0];
}
