/**
 * City generation orchestrator (V4).
 * Setup → growth loop → finishing.
 */

import { extractCityContext } from './extractCityContext.js';
import { importRivers } from './importRivers.js';
import { classifyWater } from './classifyWater.js';
import { refineTerrain } from './refineTerrain.js';
import { generateAnchorRoutes } from './generateAnchorRoutes.js';
import { identifyRiverCrossings } from './riverCrossings.js';
import { seedNuclei } from './seedNuclei.js';
import { generateInstitutionalPlots } from './generateInstitutionalPlots.js';
import { growCity } from './growCity.js';
import { generateBuildings } from './generateBuildings.js';
import { generateAmenities } from './generateAmenities.js';
import { generateCityLandCover } from './generateLandCover.js';
import { extractWaterPolygons } from './extractWaterPolygons.js';
import { getCityValidators, runValidators } from '../validators/cityValidators.js';
import { createOccupancyGrid, attachGrids, stampEdge, stampJunction, stampPlot } from './roadOccupancy.js';
import { computeBuildability } from './buildability.js';
import { connectNuclei } from './connectNuclei.js';
import { Grid2D } from '../core/Grid2D.js';

/** Target population by settlement tier. */
const POPULATION_BY_TIER = {
  1: 50000,
  2: 10000,
  3: 2000,
};

/**
 * Generate a city from regional context.
 *
 * @param {import('../core/LayerStack.js').LayerStack} regionalLayers
 * @param {object} settlement
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [options]
 * @returns {import('../core/LayerStack.js').LayerStack}
 */
export function generateCity(regionalLayers, settlement, rng, options = {}) {
  const { cityRadius = 30, cityCellSize = 10 } = options;

  // ============================================================
  // Phase 0: Setup
  // ============================================================

  // C0a. Extract city context
  const cityLayers = extractCityContext(regionalLayers, settlement, {
    cityRadius,
    cityCellSize,
  });

  // Store reference to regional layers for nucleus seeding
  cityLayers.setData('regionalLayers', regionalLayers);

  // Population budget from settlement tier
  const tier = settlement.tier ?? 3;
  const targetPopulation = POPULATION_BY_TIER[tier] ?? 2000;
  cityLayers.setData('targetPopulation', targetPopulation);

  // C0b1. Import rivers at city resolution
  importRivers(cityLayers);
  classifyWater(cityLayers);

  // C0b. Refine terrain
  refineTerrain(cityLayers, rng.fork('cityTerrain'));

  // C0c. Extract smooth water boundary polygons
  const waterPolygons = extractWaterPolygons(cityLayers);
  cityLayers.setData('waterPolygons', waterPolygons);

  // C0f. Initialize occupancy grid
  const occupancy = createOccupancyGrid(cityLayers.getData('params'));
  cityLayers.setData('occupancy', occupancy);

  // Buildability from terrain (computed once, then incrementally updated by stamps)
  const buildability = computeBuildability(cityLayers);

  // C0d. Anchor routes (Phase 1-4: shared-grid pathfinding)
  const roadGraph = generateAnchorRoutes(cityLayers, rng.fork('anchorRoutes'), occupancy);
  cityLayers.setData('roadGraph', roadGraph);

  // C3b. Initial bridge detection from anchor routes
  const { bridgeGrid, bridges } = identifyRiverCrossings(cityLayers);
  cityLayers.setGrid('bridgeGrid', bridgeGrid);
  cityLayers.setData('bridges', bridges);

  // Wire occupancy → derived grids (buildability, bridgeGrid, waterMask)
  // From here, every stampEdge/stampPlot/stampJunction incrementally updates all grids
  attachGrids(occupancy, {
    buildability,
    bridgeGrid,
    waterMask: cityLayers.getGrid('waterMask'),
    bridges,
  });

  // Stamp all anchor route edges + junctions onto occupancy
  for (const edgeId of roadGraph.edges.keys()) {
    stampEdge(roadGraph, edgeId, occupancy);
  }
  for (const [nodeId, node] of roadGraph.nodes) {
    if (roadGraph.neighbors(nodeId).length >= 3) {
      stampJunction(node.x, node.z, 15, occupancy);
    }
  }

  // C0e. Seed nuclei (primary + regional satellites + generated)
  const nuclei = seedNuclei(cityLayers, roadGraph, rng.fork('nuclei'));
  cityLayers.setData('nuclei', nuclei);

  // Bridge: generateInstitutionalPlots expects 'neighborhoods' and 'density'
  const params = cityLayers.getData('params');
  cityLayers.setData('neighborhoods', nuclei.map(n => ({
    gx: n.gx, gz: n.gz, x: n.x, z: n.z,
    type: n.type, importance: n.tier <= 2 ? 1.0 : 0.5,
    radius: Math.min(params.width, params.height) * 0.2,
  })));
  // Provide a uniform low-density grid as placeholder for institutional placement
  const densityGrid = new Grid2D(params.width, params.height, { cellSize: params.cellSize, fill: 0.3 });
  cityLayers.setGrid('density', densityGrid);

  // C0g. Large institutional plots
  const institutionalPlots = generateInstitutionalPlots(cityLayers, roadGraph, rng.fork('institutions'));
  cityLayers.setData('institutionalPlots', institutionalPlots);

  // Stamp institutional plots onto occupancy
  for (const p of institutionalPlots) {
    if (p.vertices) stampPlot(p.vertices, occupancy);
  }

  // Connect all nuclei to road network and to each other (Union-Find + MST)
  connectNuclei(cityLayers, roadGraph, nuclei, occupancy);

  // ============================================================
  // Phase 1: Growth loop
  // ============================================================

  const { plots: growthPlots, tickSnapshots } = growCity(
    cityLayers, roadGraph, nuclei, rng.fork('growth'),
  );

  const allPlots = [...institutionalPlots, ...growthPlots];
  cityLayers.setData('plots', allPlots);
  cityLayers.setData('roadGraph', roadGraph);

  // ============================================================
  // Phase 2: Finishing
  // ============================================================

  // C2a. Buildings (from all plots)
  const buildings = generateBuildings(cityLayers, allPlots, rng.fork('buildings'));
  cityLayers.setData('buildings', buildings);

  // C2b. Amenities
  const amenities = generateAmenities(cityLayers, buildings, rng.fork('amenities'));
  cityLayers.setData('amenities', amenities);

  // C2c. Urban land cover
  const urbanCover = generateCityLandCover(cityLayers, amenities, rng.fork('urbanCover'));
  cityLayers.setGrid('urbanCover', urbanCover);

  // C2d. Validation
  const validators = getCityValidators();
  const validation = runValidators(cityLayers, validators);
  cityLayers.setData('cityValidation', validation);

  return cityLayers;
}
