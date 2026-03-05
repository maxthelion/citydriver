/**
 * Step-by-step city generation with snapshots for debug rendering.
 * V4 pipeline: neighborhoods-first approach.
 */

import { extractCityContext } from './extractCityContext.js';
import { refineTerrain } from './refineTerrain.js';
import { generateAnchorRoutes } from './generateAnchorRoutes.js';
import { identifyRiverCrossings } from './riverCrossings.js';
import { placeNeighborhoods } from './placeNeighborhoods.js';
import { computeNeighborhoodInfluence } from './neighborhoodInfluence.js';
import { generateInstitutionalPlots } from './generateInstitutionalPlots.js';
import { generateStreetsAndPlots } from './generateStreetsAndPlots.js';
import { closeLoops } from './closeLoops.js';
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
  const { cityRadius = 30, cityCellSize = 10, stopAfter } = options;
  const steps = [];
  const stop = (name) => stopAfter && name.toLowerCase() === stopAfter.toLowerCase();

  // C1: Extract city context
  const cityLayers = extractCityContext(regionalLayers, settlement, {
    cityRadius, cityCellSize,
  });
  const tier = settlement.tier ?? 3;
  cityLayers.setData('targetPopulation', POPULATION_BY_TIER[tier] ?? 2000);

  steps.push({ name: 'Elevation', render: 'elevation' });
  if (stop('elevation')) return { cityLayers, roadGraph: null, steps };

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
  if (stop('anchor routes')) { cityLayers.setData('roadGraph', roadGraph); return { cityLayers, roadGraph, steps }; }
  prevEdges = new Set(curEdges);

  // C3b: River crossings (bridge points)
  const { bridgeGrid, bridges } = identifyRiverCrossings(cityLayers);
  cityLayers.setGrid('bridgeGrid', bridgeGrid);
  cityLayers.setData('bridges', bridges);

  // C4: Place neighborhood nuclei
  const neighborhoods = placeNeighborhoods(cityLayers, roadGraph, rng.fork('neighborhoods'));
  cityLayers.setData('neighborhoods', neighborhoods);

  // C5: Neighborhood influence (density + districts) — no connector roads
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
  if (stop('districts') || stop('density') || stop('neighborhoods')) {
    cityLayers.setData('roadGraph', roadGraph);
    return { cityLayers, roadGraph, steps };
  }

  // C6b: Large institutional plots
  const institutionalPlots = generateInstitutionalPlots(cityLayers, roadGraph, rng.fork('institutions'));
  cityLayers.setData('institutionalPlots', institutionalPlots);
  cityLayers.setData('plots', institutionalPlots); // temporary — will be merged with frontage plots
  steps.push({ name: 'Institutions', render: 'plots' });
  if (stop('institutions')) {
    cityLayers.setData('roadGraph', roadGraph);
    return { cityLayers, roadGraph, steps };
  }

  // C7: Streets and plots (merged, frontage-first)
  const { plots, newEdgeIds: streetPlotEdges } = generateStreetsAndPlots(cityLayers, roadGraph, rng.fork('streetsAndPlots'));
  cityLayers.setData('plots', [...institutionalPlots, ...plots]);
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Streets + Plots', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: streetPlotEdges,
  });
  steps.push({ name: 'Plots', render: 'plots' });
  if (stop('plots') || stop('streets + plots')) {
    cityLayers.setData('roadGraph', roadGraph);
    return { cityLayers, roadGraph, steps };
  }
  prevEdges = new Set(curEdges);

  // C8: Loop closure (lightweight safety net)
  closeLoops(roadGraph, 500, cityLayers);
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({
    name: 'Loop Closure', render: 'roads',
    edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges),
  });
  cityLayers.setData('roadGraph', roadGraph);

  // C10: Buildings
  const buildings = generateBuildings(cityLayers, plots, rng.fork('buildings'));
  cityLayers.setData('buildings', buildings);
  steps.push({ name: 'Buildings', render: 'buildings' });
  if (stop('buildings')) return { cityLayers, roadGraph, steps };

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
