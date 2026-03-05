/**
 * Step-by-step city generation with snapshots for debug rendering.
 * Wraps the same pipeline phases as generateCity() but captures
 * intermediate state after each step.
 */

import { extractCityContext } from './extractCityContext.js';
import { refineTerrain } from './refineTerrain.js';
import { generateAnchorRoutes } from './generateAnchorRoutes.js';
import { generateDensityField } from './generateDensityField.js';
import { generateArterials } from './generateArterials.js';
import { generateDistricts } from './generateDistricts.js';
import { generateCollectors } from './generateCollectors.js';
import { generateStreets } from './generateStreets.js';
import { closeLoops } from './closeLoops.js';
import { generatePlots } from './generatePlots.js';
import { generateBuildings } from './generateBuildings.js';
import { generateAmenities } from './generateAmenities.js';
import { generateCityLandCover } from './generateLandCover.js';
import { rezoneHighCentralityStreets } from './pipeline.js';

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
  const { cityRadius = 30, cityCellSize = 10 } = options;
  const steps = [];

  // B1a: Extract city context
  const cityLayers = extractCityContext(regionalLayers, settlement, {
    cityRadius, cityCellSize,
  });
  const tier = settlement.tier ?? 3;
  cityLayers.setData('targetPopulation', POPULATION_BY_TIER[tier] ?? 2000);

  steps.push({ name: 'Elevation', render: 'elevation' });

  // B1b: Refine terrain
  refineTerrain(cityLayers, rng.fork('cityTerrain'));
  steps.push({ name: 'Slope', render: 'slope' });
  steps.push({ name: 'Water Mask', render: 'waterMask' });

  // B2: Anchor routes
  const roadGraph = generateAnchorRoutes(cityLayers, rng.fork('anchorRoutes'));
  let prevEdges = new Set();
  let curEdges = new Set(roadGraph.edges.keys());
  // Only highlight structural roads as "new" — inherited roads show in hierarchy colour
  const structuralEdges = new Set();
  for (const edgeId of curEdges) {
    const edge = roadGraph.getEdge(edgeId);
    if (edge && edge.hierarchy === 'structural') structuralEdges.add(edgeId);
  }
  steps.push({
    name: 'Anchor Routes', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: structuralEdges,
  });
  prevEdges = new Set(curEdges);

  // B3: Density (initial)
  let density = generateDensityField(cityLayers, roadGraph, rng.fork('density'));
  cityLayers.setGrid('density', density);
  const densityV1 = density.clone();
  steps.push({ name: 'Density', render: 'density', grid: densityV1 });

  // B4: Arterials
  generateArterials(cityLayers, roadGraph, rng.fork('arterials'));
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Arterials', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  prevEdges = new Set(curEdges);

  // Feedback A: Density v2
  density = generateDensityField(cityLayers, roadGraph, rng.fork('densityPostArterials'));
  cityLayers.setGrid('density', density);
  steps.push({ name: 'Density v2', render: 'density' });

  // B5: Districts
  const districts = generateDistricts(cityLayers, roadGraph, rng.fork('districts'));
  cityLayers.setGrid('districts', districts);
  const districtsV1 = districts.clone();
  steps.push({ name: 'Districts', render: 'districts', grid: districtsV1 });

  // B6: Collectors
  generateCollectors(cityLayers, roadGraph, rng.fork('collectors'));
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Collectors', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  prevEdges = new Set(curEdges);

  // B7: Streets
  generateStreets(cityLayers, roadGraph, rng.fork('streets'));
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Streets', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  prevEdges = new Set(curEdges);

  // B8: Loop closure
  closeLoops(roadGraph, 500, cityLayers);
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Loop Closure', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  cityLayers.setData('roadGraph', roadGraph);

  // Feedback D: Rezone
  rezoneHighCentralityStreets(roadGraph, cityLayers);
  steps.push({ name: 'Rezone', render: 'districts' });

  // B9: Plots
  const plots = generatePlots(cityLayers, roadGraph, rng.fork('plots'));
  cityLayers.setData('plots', plots);
  steps.push({ name: 'Plots', render: 'plots' });

  // B10: Buildings
  const buildings = generateBuildings(cityLayers, plots, rng.fork('buildings'));
  cityLayers.setData('buildings', buildings);
  steps.push({ name: 'Buildings', render: 'buildings' });

  // B11: Amenities
  const amenities = generateAmenities(cityLayers, buildings, rng.fork('amenities'));
  cityLayers.setData('amenities', amenities);
  steps.push({ name: 'Amenities', render: 'amenities' });

  // B12: Urban land cover
  const urbanCover = generateCityLandCover(cityLayers, amenities, rng.fork('urbanCover'));
  cityLayers.setGrid('urbanCover', urbanCover);
  steps.push({ name: 'Land Cover', render: 'urbanCover' });

  return { cityLayers, roadGraph, steps };
}
