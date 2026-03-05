/**
 * Step-by-step city generation with snapshots for debug rendering.
 * V4 pipeline: neighborhoods-first approach.
 */

import { extractCityContext } from './extractCityContext.js';
import { refineTerrain } from './refineTerrain.js';
import { generateAnchorRoutes } from './generateAnchorRoutes.js';
import { placeNeighborhoods } from './placeNeighborhoods.js';
import { connectNeighborhoods } from './connectNeighborhoods.js';
import { computeNeighborhoodInfluence } from './neighborhoodInfluence.js';
import { generateNeighborhoodStreets } from './generateNeighborhoodStreets.js';
import { closeLoops } from './closeLoops.js';
import { generatePlots } from './generatePlots.js';
import { generateBuildings } from './generateBuildings.js';
import { generateAmenities } from './generateAmenities.js';
import { generateCityLandCover } from './generateLandCover.js';

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

  // C1: Extract city context
  const cityLayers = extractCityContext(regionalLayers, settlement, {
    cityRadius, cityCellSize,
  });
  const tier = settlement.tier ?? 3;
  cityLayers.setData('targetPopulation', POPULATION_BY_TIER[tier] ?? 2000);

  steps.push({ name: 'Elevation', render: 'elevation' });

  // C2: Refine terrain
  refineTerrain(cityLayers, rng.fork('cityTerrain'));
  steps.push({ name: 'Slope', render: 'slope' });
  steps.push({ name: 'Water Mask', render: 'waterMask' });

  // C3: Anchor routes (inherited regional roads)
  const roadGraph = generateAnchorRoutes(cityLayers, rng.fork('anchorRoutes'));
  let prevEdges = new Set();
  let curEdges = new Set(roadGraph.edges.keys());
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

  // C4: Place neighborhood nuclei
  const neighborhoods = placeNeighborhoods(cityLayers, roadGraph, rng.fork('neighborhoods'));
  cityLayers.setData('neighborhoods', neighborhoods);

  // C5: Connect neighborhoods (arterial network)
  connectNeighborhoods(cityLayers, roadGraph, neighborhoods, rng.fork('connectNeighborhoods'));
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Neighborhoods', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  prevEdges = new Set(curEdges);

  // C6: Neighborhood influence (density + districts)
  const { density, districts, ownership } = computeNeighborhoodInfluence(cityLayers, neighborhoods);
  cityLayers.setGrid('density', density);
  cityLayers.setGrid('districts', districts);
  cityLayers.setData('ownership', ownership);

  steps.push({
    name: 'Neighborhood Map', render: 'neighborhoods',
    neighborhoods, ownership,
  });
  steps.push({ name: 'Density', render: 'density' });
  steps.push({ name: 'Districts', render: 'districts' });

  // C7: Neighborhood streets (per-type grid patterns)
  generateNeighborhoodStreets(cityLayers, roadGraph, rng.fork('streets'));
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Streets', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  prevEdges = new Set(curEdges);

  // C8: Loop closure (lightweight safety net)
  closeLoops(roadGraph, 500, cityLayers);
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Loop Closure', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  cityLayers.setData('roadGraph', roadGraph);

  // C9: Plots
  const plots = generatePlots(cityLayers, roadGraph, rng.fork('plots'));
  cityLayers.setData('plots', plots);
  steps.push({ name: 'Plots', render: 'plots' });

  // C10: Buildings
  const buildings = generateBuildings(cityLayers, plots, rng.fork('buildings'));
  cityLayers.setData('buildings', buildings);
  steps.push({ name: 'Buildings', render: 'buildings' });

  // C11: Amenities
  const amenities = generateAmenities(cityLayers, buildings, rng.fork('amenities'));
  cityLayers.setData('amenities', amenities);
  steps.push({ name: 'Amenities', render: 'amenities' });

  // C12: Urban land cover
  const urbanCover = generateCityLandCover(cityLayers, amenities, rng.fork('urbanCover'));
  cityLayers.setGrid('urbanCover', urbanCover);
  steps.push({ name: 'Land Cover', render: 'urbanCover' });

  return { cityLayers, roadGraph, steps };
}
