/**
 * Interactive pipeline: split city setup from growth so the viewer
 * can step through growth one tick at a time.
 */

import { extractCityContext } from './extractCityContext.js';
import { importRivers } from './importRivers.js';
import { classifyWater } from './classifyWater.js';
import { refineTerrain } from './refineTerrain.js';
import { generateAnchorRoutes } from './generateAnchorRoutes.js';
import { identifyRiverCrossings } from './riverCrossings.js';
import { seedNuclei } from './seedNuclei.js';
import { generateInstitutionalPlots } from './generateInstitutionalPlots.js';
import { extractWaterPolygons } from './extractWaterPolygons.js';
import { createOccupancyGrid, stampEdge, stampJunction, stampPlot } from './roadOccupancy.js';
import { Grid2D } from '../core/Grid2D.js';
import {
  computeGradientField,
  computeWaterDistanceField,
  computeTerrainAttraction,
} from './terrainFields.js';

const POPULATION_BY_TIER = { 1: 50000, 2: 10000, 3: 2000 };

/**
 * Run Phase 0 of city generation — everything before the growth loop.
 * Returns a state object that tickGrowth() can advance.
 */
export function setupCity(regionalLayers, settlement, rng, options = {}) {
  const { cityRadius = 30, cityCellSize = 10 } = options;

  const cityLayers = extractCityContext(regionalLayers, settlement, {
    cityRadius, cityCellSize,
  });
  cityLayers.setData('regionalLayers', regionalLayers);

  const tier = settlement.tier ?? 3;
  cityLayers.setData('targetPopulation', POPULATION_BY_TIER[tier] ?? 2000);

  importRivers(cityLayers);
  classifyWater(cityLayers);

  refineTerrain(cityLayers, rng.fork('cityTerrain'));

  const waterPolygons = extractWaterPolygons(cityLayers);
  cityLayers.setData('waterPolygons', waterPolygons);

  const occupancy = createOccupancyGrid(cityLayers.getData('params'));
  cityLayers.setData('occupancy', occupancy);

  const roadGraph = generateAnchorRoutes(cityLayers, rng.fork('anchorRoutes'));

  for (const edgeId of roadGraph.edges.keys()) {
    stampEdge(roadGraph, edgeId, occupancy);
  }
  for (const [nodeId, node] of roadGraph.nodes) {
    if (roadGraph.neighbors(nodeId).length >= 3) {
      stampJunction(node.x, node.z, 15, occupancy);
    }
  }

  const { bridgeGrid, bridges } = identifyRiverCrossings(cityLayers);
  cityLayers.setGrid('bridgeGrid', bridgeGrid);
  cityLayers.setData('bridges', bridges);

  const nuclei = seedNuclei(cityLayers, roadGraph, rng.fork('nuclei'));
  cityLayers.setData('nuclei', nuclei);

  const params = cityLayers.getData('params');
  cityLayers.setData('neighborhoods', nuclei.map(n => ({
    gx: n.gx, gz: n.gz, x: n.x, z: n.z,
    type: n.type, importance: n.tier <= 2 ? 1.0 : 0.5,
    radius: Math.min(params.width, params.height) * 0.2,
  })));
  const densityGrid = new Grid2D(params.width, params.height, { cellSize: params.cellSize, fill: 0.3 });
  cityLayers.setGrid('density', densityGrid);

  const institutionalPlots = generateInstitutionalPlots(cityLayers, roadGraph, rng.fork('institutions'));
  cityLayers.setData('institutionalPlots', institutionalPlots);
  cityLayers.setData('plots', institutionalPlots);

  for (const p of institutionalPlots) {
    if (p.vertices) stampPlot(p.vertices, occupancy);
  }

  cityLayers.setData('roadGraph', roadGraph);

  // Precompute terrain fields for layer rendering
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  const slope = cityLayers.getGrid('slope');
  const w = params.width, h = params.height;
  const seaLevel = params.seaLevel ?? 0;

  const { dxGrid: gradDx, dzGrid: gradDz } = computeGradientField(elevation, w, h);
  const { waterDistGrid } = computeWaterDistanceField(waterMask, elevation, seaLevel, w, h);
  const terrainAttraction = computeTerrainAttraction(elevation, slope, waterDistGrid, w, h, seaLevel);

  const terrainFields = { gradDx, gradDz, waterDistGrid, terrainAttraction };

  return { cityLayers, roadGraph, nuclei, occupancy, terrainFields, tick: 0 };
}

/**
 * Run one growth tick. Placeholder — returns empty changes.
 * This is where the new growth algorithm will be implemented.
 */
export function tickGrowth(state, rng) {
  state.tick++;
  return {
    addedEdges: [],
    addedPlots: [],
    affectedLayers: [],
  };
}
