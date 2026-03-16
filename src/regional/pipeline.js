/**
 * Regional generation pipeline.
 * generateRegion(params, rng) => LayerStack
 *
 * Phases are added incrementally. Each phase enriches the LayerStack.
 * Settlement placement uses a feedback loop:
 *   A6a primaries → A6b farms → A7a roads → A6c market towns → A7b roads → A6d growth
 */

import { LayerStack } from '../core/LayerStack.js';
import { generateTectonics } from './generateTectonics.js';
import { generateGeology } from './generateGeology.js';
import { generateTerrain } from './generateTerrain.js';
import { planRiverCorridors } from './planRiverCorridors.js';
import { generateHydrology } from './generateHydrology.js';
import { generateCoastline } from './generateCoastline.js';
import { generateLandCover } from './generateLandCover.js';
import { generateSettlements } from './generateSettlements.js';
import { generateFarms } from './generateFarms.js';
import { generateRoads } from './generateRoads.js';
import { applySeaFloorPlunge } from './seaFloorPlunge.js';
import { generateMarketTowns } from './generateMarketTowns.js';
import { growSettlements } from './growSettlements.js';

/**
 * @param {object} params
 * @param {number} [params.width=256]
 * @param {number} [params.height=256]
 * @param {number} [params.cellSize=50]
 * @param {number} [params.seaLevel=0]
 * @param {string[]} [params.coastEdges] - Override coast edge placement
 * @param {number} [params.plateAngle] - Override plate angle
 * @param {number} [params.intensity] - Override tectonic intensity
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {LayerStack}
 */
export function generateRegion(params, rng) {
  const {
    width = 256,
    height = 256,
    cellSize = 50,
    seaLevel = 0,
  } = params;

  const layers = new LayerStack();
  layers.setData('params', { width, height, cellSize, seaLevel });

  // A0. Tectonic context — drives everything downstream
  const tectonics = generateTectonics({
    coastEdges: params.coastEdges,
    plateAngle: params.plateAngle,
    intensity: params.intensity,
  }, rng);
  layers.setData('tectonics', tectonics);

  // A0b. River corridor planning (before geology and terrain)
  const { corridors, corridorDist, corridorInfluence } = planRiverCorridors(
    { width, height, cellSize }, tectonics, rng,
  );
  layers.setData('riverCorridors', corridors);
  layers.setGrid('corridorDist', corridorDist);
  layers.setGrid('corridorInfluence', corridorInfluence);

  // A1. Geology (driven by tectonic context)
  const geology = generateGeology({
    width, height, cellSize,
    bandDirection: tectonics.bandDirection,
    bandCount: tectonics.bandCount,
    intrusionCount: tectonics.intrusionCount,
    rockBias: tectonics.rockBias,
  }, rng);

  layers.setGrid('rockType', geology.rockType);
  layers.setGrid('erosionResistance', geology.erosionResistance);
  layers.setGrid('permeability', geology.permeability);
  layers.setGrid('soilFertility', geology.soilFertility);
  layers.setGrid('springLine', geology.springLine);

  // A2. Terrain (driven by tectonic context, corridors suppress ridges)
  const terrain = generateTerrain(
    { width, height, cellSize, seaLevel, tectonics, corridorInfluence },
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

  // A3. Hydrology (with corridor accumulation and valley carving)
  const hydrology = generateHydrology(
    { width, height, cellSize, seaLevel },
    terrain.elevation,
    geology.permeability,
    rng,
    { erosionResistance: geology.erosionResistance, riverCorridors: corridors },
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
    { width, height, cellSize, seaLevel, treeline: tectonics.treeline },
    terrain.elevation,
    terrain.slope,
    geology.soilFertility,
    geology.permeability,
    hydrology.waterMask,
    allSettlements,
    rng,
  );
  layers.setGrid('landCover', landCover);

  // Sea floor plunge: force underwater terrain steeply below sea level.
  // Runs last so settlement and road scoring use the natural pre-plunge elevation.
  applySeaFloorPlunge(
    terrain.elevation, hydrology.waterMask, geology.erosionResistance, cellSize, seaLevel
  );

  return layers;
}
