/**
 * Step-by-step city generation with snapshots for debug rendering.
 * V4 pipeline: setup → growth loop → finishing.
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
import { createOccupancyGrid, attachGrids, stampEdge, stampJunction, stampPlot } from './roadOccupancy.js';
import { computeBuildability } from './buildability.js';
import { connectNuclei } from './connectNuclei.js';
import { Grid2D } from '../core/Grid2D.js';

const POPULATION_BY_TIER = { 1: 50000, 2: 10000, 3: 2000 };

function difference(a, b) {
  return new Set([...a].filter(id => !b.has(id)));
}

/**
 * Generate a city step-by-step, returning snapshots for debug rendering.
 *
 * @param {import('../core/LayerStack.js').LayerStack} regionalLayers
 * @param {object} settlement
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [options]
 * @returns {{ cityLayers, roadGraph, steps: Array<{name, render, ...}> }}
 */
export function generateCityStepByStep(regionalLayers, settlement, rng, options = {}) {
  const { cityRadius = 30, cityCellSize = 10, stopAfter } = options;
  const steps = [];
  const stop = (name) => stopAfter && name.toLowerCase() === stopAfter.toLowerCase();

  // ============================================================
  // Phase 0: Setup
  // ============================================================

  // C0a: Extract city context
  const cityLayers = extractCityContext(regionalLayers, settlement, {
    cityRadius, cityCellSize,
  });
  cityLayers.setData('regionalLayers', regionalLayers);
  const tier = settlement.tier ?? 3;
  cityLayers.setData('targetPopulation', POPULATION_BY_TIER[tier] ?? 2000);

  steps.push({ name: 'Elevation', render: 'elevation' });
  if (stop('elevation')) return { cityLayers, roadGraph: null, steps };

  // Import rivers at city resolution and classify water bodies
  importRivers(cityLayers);
  classifyWater(cityLayers);

  // C0b: Refine terrain
  refineTerrain(cityLayers, rng.fork('cityTerrain'));
  steps.push({ name: 'Slope', render: 'slope' });
  steps.push({ name: 'Water Mask', render: 'waterMask' });

  // C0c: Extract smooth water boundary polygons
  const waterPolygons = extractWaterPolygons(cityLayers);
  cityLayers.setData('waterPolygons', waterPolygons);

  // C0f: Initialize occupancy grid
  const occupancy = createOccupancyGrid(cityLayers.getData('params'));
  cityLayers.setData('occupancy', occupancy);

  const buildability = computeBuildability(cityLayers);

  // C0d: Anchor routes (Phase 1-4 only)
  const roadGraph = generateAnchorRoutes(cityLayers, rng.fork('anchorRoutes'), occupancy);
  cityLayers.setData('roadGraph', roadGraph);

  // C3b: Initial bridge detection from anchor routes
  const { bridgeGrid, bridges } = identifyRiverCrossings(cityLayers);
  cityLayers.setGrid('bridgeGrid', bridgeGrid);
  cityLayers.setData('bridges', bridges);

  // Wire occupancy → derived grids for incremental updates
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

  let prevEdges = new Set();
  let curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Anchor Routes', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: new Set(curEdges),
  });
  if (stop('anchor routes')) { return { cityLayers, roadGraph, steps }; }
  prevEdges = new Set(curEdges);

  // C0e: Seed nuclei
  const nuclei = seedNuclei(cityLayers, roadGraph, rng.fork('nuclei'));
  cityLayers.setData('nuclei', nuclei);

  // Debug: Nuclei visualization
  steps.push({
    name: 'Nuclei', render: 'nuclei',
    nuclei: nuclei.map(n => ({
      x: n.x, z: n.z, id: n.id, type: n.type, tier: n.tier,
      targetPop: n.targetPopulation, connected: n.connected,
      isPrimary: n.id === 0,
    })),
  });
  if (stop('nuclei')) { cityLayers.setData('roadGraph', roadGraph); return { cityLayers, roadGraph, steps }; }

  // Bridge: generateInstitutionalPlots expects 'neighborhoods' and 'density'
  const params = cityLayers.getData('params');
  cityLayers.setData('neighborhoods', nuclei.map(n => ({
    gx: n.gx, gz: n.gz, x: n.x, z: n.z,
    type: n.type, importance: n.tier <= 2 ? 1.0 : 0.5,
    radius: Math.min(params.width, params.height) * 0.2,
  })));
  const densityGrid = new Grid2D(params.width, params.height, { cellSize: params.cellSize, fill: 0.3 });
  cityLayers.setGrid('density', densityGrid);

  // C0g: Institutional plots
  const institutionalPlots = generateInstitutionalPlots(cityLayers, roadGraph, rng.fork('institutions'));
  cityLayers.setData('institutionalPlots', institutionalPlots);
  cityLayers.setData('plots', institutionalPlots);

  for (const p of institutionalPlots) {
    if (p.vertices) stampPlot(p.vertices, occupancy);
  }

  steps.push({ name: 'Institutions', render: 'plots' });

  // Connect all nuclei (Union-Find + MST)
  connectNuclei(cityLayers, roadGraph, nuclei, occupancy);

  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Nucleus Connections', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  prevEdges = new Set(curEdges);

  if (stop('institutions')) {
    cityLayers.setData('roadGraph', roadGraph);
    return { cityLayers, roadGraph, steps };
  }

  // ============================================================
  // Phase 1: Growth loop
  // ============================================================

  const preGrowthEdges = new Set(roadGraph.edges.keys());
  const { plots: growthPlots, tickSnapshots } = growCity(
    cityLayers, roadGraph, nuclei, rng.fork('growth'),
  );

  const allPlots = [...institutionalPlots, ...growthPlots];
  cityLayers.setData('plots', allPlots);

  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Growth Loop', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, preGrowthEdges),
  });
  steps.push({ name: 'Plots', render: 'plots' });
  if (stop('plots') || stop('growth loop')) {
    cityLayers.setData('roadGraph', roadGraph);
    return { cityLayers, roadGraph, steps };
  }

  cityLayers.setData('roadGraph', roadGraph);

  // ============================================================
  // Phase 2: Finishing
  // ============================================================

  // Buildings
  const buildings = generateBuildings(cityLayers, allPlots, rng.fork('buildings'));
  cityLayers.setData('buildings', buildings);
  steps.push({ name: 'Buildings', render: 'buildings' });
  if (stop('buildings')) return { cityLayers, roadGraph, steps };

  // Amenities
  const amenities = generateAmenities(cityLayers, buildings, rng.fork('amenities'));
  cityLayers.setData('amenities', amenities);
  steps.push({ name: 'Amenities', render: 'amenities' });

  // Urban land cover
  const urbanCover = generateCityLandCover(cityLayers, amenities, rng.fork('urbanCover'));
  cityLayers.setGrid('urbanCover', urbanCover);
  steps.push({ name: 'Land Cover', render: 'urbanCover' });

  return { cityLayers, roadGraph, steps };
}
