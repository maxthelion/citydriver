/**
 * Regional generation pipeline.
 * generateRegion(params, rng) => LayerStack
 *
 * Phases are added incrementally. Each phase enriches the LayerStack.
 * Settlement placement uses a feedback loop:
 *   A6a primaries → A6b farms → A7a roads → A6c market towns → A7b roads → A6d growth
 */

import { LayerStack } from '../core/LayerStack.js';
import { generateGeology } from './generateGeology.js';
import { generateTerrain } from './generateTerrain.js';
import { generateHydrology } from './generateHydrology.js';
import { generateCoastline } from './generateCoastline.js';
import { generateLandCover } from './generateLandCover.js';
import { generateSettlements } from './generateSettlements.js';
import { generateFarms } from './generateFarms.js';
import { generateRoads } from './generateRoads.js';
import { generateMarketTowns } from './generateMarketTowns.js';
import { growSettlements } from './growSettlements.js';

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
  layers.setData('riverPaths', hydrology.riverPaths);
  layers.setGrid('waterMask', hydrology.waterMask);

  const geoExtras = {
    springLine: geology.springLine,
    erosionResistance: geology.erosionResistance,
    coastlineFeatures: coastResult?.coastlineFeatures || [],
  };

  // === Settlement + Road feedback loop ===

  // A6a. Primary settlements (cities, towns, villages)
  const { settlements: primaries, proximityGrids } = generateSettlements(
    { width, height, cellSize, seaLevel },
    terrain.elevation,
    terrain.slope,
    geology.soilFertility,
    hydrology.waterMask,
    hydrology.confluences,
    hydrology.rivers,
    rng.fork('settlements'),
    geoExtras,
  );

  // A6b. Farms and hamlets (geography-driven)
  const farms = generateFarms(
    { width, height, cellSize, seaLevel },
    terrain.elevation,
    terrain.slope,
    geology.soilFertility,
    primaries,
    proximityGrids,
    hydrology.confluences,
    rng.fork('farms'),
    geoExtras,
  );

  let allSettlements = [...primaries, ...farms];

  // A7a. Initial roads (connect primaries + hamlets)
  const roadsA = generateRoads(
    { width, height, cellSize },
    allSettlements,
    terrain.elevation,
    terrain.slope,
    hydrology.waterMask,
    rng.fork('roads'),
  );

  // A6c. Market towns (road-attracted) + promote hamlets on arterials
  const { newTowns, promotions } = generateMarketTowns(
    { width, height, cellSize, seaLevel },
    terrain.elevation,
    terrain.slope,
    geology.soilFertility,
    allSettlements,
    roadsA.roads,
    proximityGrids,
    rng.fork('marketTowns'),
    geoExtras,
  );

  // Apply promotions
  for (const { settlement, newTier } of promotions) {
    settlement.tier = newTier;
  }

  allSettlements = [...allSettlements, ...newTowns];

  // A7b. Road update (incremental — connect new settlements, reuse existing roadGrid)
  const roadsB = generateRoads(
    { width, height, cellSize },
    allSettlements,
    terrain.elevation,
    terrain.slope,
    hydrology.waterMask,
    rng.fork('roadsB'),
    { existingRoadGrid: roadsA.roadGrid, existingRoads: roadsA.roads },
  );

  // A6d. Growth pass (promote busy settlements)
  growSettlements(allSettlements, roadsB.roads);

  layers.setData('settlements', allSettlements);
  layers.setData('roads', roadsB.roads);

  // A5. Land Cover
  const landCover = generateLandCover(
    { width, height, cellSize, seaLevel },
    terrain.elevation,
    terrain.slope,
    geology.soilFertility,
    geology.permeability,
    hydrology.waterMask,
    allSettlements,
    rng,
  );
  layers.setGrid('landCover', landCover);

  return layers;
}
