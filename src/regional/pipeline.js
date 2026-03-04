/**
 * Regional generation pipeline.
 * generateRegion(params, rng) => LayerStack
 *
 * Phases are added incrementally. Each phase enriches the LayerStack.
 */

import { LayerStack } from '../core/LayerStack.js';
import { generateGeology } from './generateGeology.js';
import { generateTerrain } from './generateTerrain.js';
import { generateHydrology } from './generateHydrology.js';
import { generateCoastline } from './generateCoastline.js';
import { generateLandCover } from './generateLandCover.js';
import { generateSettlements } from './generateSettlements.js';
import { generateRoads } from './generateRoads.js';

/**
 * @param {object} params
 * @param {number} [params.width=256]
 * @param {number} [params.height=256]
 * @param {number} [params.cellSize=50]
 * @param {number} [params.seaLevel=0]
 * @param {number} [params.bandDirection] - Geology band angle
 * @param {number} [params.bandCount] - Number of rock type transitions
 * @param {number} [params.intrusionCount] - Igneous intrusions
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {LayerStack}
 */
export function generateRegion(params, rng) {
  const {
    width = 256,
    height = 256,
    cellSize = 50,
    seaLevel = 0,
    bandDirection,
    bandCount,
    intrusionCount,
    coastEdges = [],
  } = params;

  const layers = new LayerStack();
  layers.setData('params', { width, height, cellSize, seaLevel });

  // A1. Geology
  const geology = generateGeology({
    width, height, cellSize,
    bandDirection: bandDirection ?? rng.range(0, Math.PI),
    bandCount: bandCount ?? rng.int(4, 7),
    intrusionCount: intrusionCount ?? rng.int(1, 3),
  }, rng);

  layers.setGrid('rockType', geology.rockType);
  layers.setGrid('erosionResistance', geology.erosionResistance);
  layers.setGrid('permeability', geology.permeability);
  layers.setGrid('soilFertility', geology.soilFertility);
  layers.setGrid('springLine', geology.springLine);

  // A2. Terrain
  const terrain = generateTerrain(
    { width, height, cellSize, seaLevel, coastEdges },
    geology,
    rng,
  );

  layers.setGrid('elevation', terrain.elevation);
  layers.setGrid('slope', terrain.slope);

  // A4. Coastline (before hydrology so erosion shapes the coast first)
  const coastResult = generateCoastline(
    { width, height, seaLevel },
    terrain.elevation,
    geology.erosionResistance,
    rng,
  );
  if (coastResult && coastResult.coastlineFeatures) {
    layers.setData('coastlineFeatures', coastResult.coastlineFeatures);
  }

  // A3. Hydrology
  const hydrology = generateHydrology(
    { width, height, cellSize, seaLevel },
    terrain.elevation,
    geology.permeability,
    rng,
  );

  layers.setData('rivers', hydrology.rivers);
  layers.setData('confluences', hydrology.confluences);
  layers.setGrid('waterMask', hydrology.waterMask);

  // A6. Settlements (before land cover so clearing can be applied)
  const settlements = generateSettlements(
    { width, height, cellSize, seaLevel },
    terrain.elevation,
    terrain.slope,
    geology.soilFertility,
    hydrology.waterMask,
    hydrology.confluences,
    hydrology.rivers,
    rng,
    {
      springLine: geology.springLine,
      erosionResistance: geology.erosionResistance,
      coastlineFeatures: coastResult?.coastlineFeatures || [],
    },
  );
  layers.setData('settlements', settlements);

  // A5. Land Cover
  const landCover = generateLandCover(
    { width, height, cellSize, seaLevel },
    terrain.elevation,
    terrain.slope,
    geology.soilFertility,
    geology.permeability,
    hydrology.waterMask,
    settlements,
    rng,
  );
  layers.setGrid('landCover', landCover);

  // A7. Roads
  const roads = generateRoads(
    { width, height, cellSize },
    settlements,
    terrain.elevation,
    terrain.slope,
    hydrology.waterMask,
    rng,
  );
  layers.setData('roads', roads);

  return layers;
}
