/**
 * City generation orchestrator.
 * Runs all city generation phases in sequence, with feedback loops
 * and population-budget-driven city extent.
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
import { getCityValidators, runValidators } from '../validators/cityValidators.js';

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

  // B1a. Extract city context
  const cityLayers = extractCityContext(regionalLayers, settlement, {
    cityRadius,
    cityCellSize,
  });

  // Population budget from settlement tier
  const tier = settlement.tier ?? 3;
  const targetPopulation = POPULATION_BY_TIER[tier] ?? 2000;
  cityLayers.setData('targetPopulation', targetPopulation);

  // B1b. Refine terrain
  refineTerrain(cityLayers, rng.fork('cityTerrain'));

  // B2. Anchor routes
  const roadGraph = generateAnchorRoutes(cityLayers, rng.fork('anchorRoutes'));

  // B3. Density field (initial)
  let density = generateDensityField(cityLayers, roadGraph, rng.fork('density'));
  cityLayers.setGrid('density', density);

  // B4. Arterials
  generateArterials(cityLayers, roadGraph, rng.fork('arterials'));

  // Feedback Loop A: Recompute density after arterials (roads influence density)
  density = generateDensityField(cityLayers, roadGraph, rng.fork('densityPostArterials'));
  cityLayers.setGrid('density', density);

  // B5. Districts
  const districts = generateDistricts(cityLayers, roadGraph, rng.fork('districts'));
  cityLayers.setGrid('districts', districts);

  // B6. Collectors
  generateCollectors(cityLayers, roadGraph, rng.fork('collectors'));

  // B7. Streets
  generateStreets(cityLayers, roadGraph, rng.fork('streets'));

  // B8. Loop closure
  closeLoops(roadGraph, 500, cityLayers);

  // Store road graph
  cityLayers.setData('roadGraph', roadGraph);

  // Feedback Loop D: Compute betweenness centrality approximation and rezone
  rezoneHighCentralityStreets(roadGraph, cityLayers);

  // B9. Plots
  const plots = generatePlots(cityLayers, roadGraph, rng.fork('plots'));
  cityLayers.setData('plots', plots);

  // B10. Buildings (with population budget)
  const buildings = generateBuildings(cityLayers, plots, rng.fork('buildings'));
  cityLayers.setData('buildings', buildings);

  // Feedback Loop B: Flag low-coverage plots as open space
  flagLowCoveragePlots(plots, buildings, cityLayers);

  // B11. Amenities
  const amenities = generateAmenities(cityLayers, buildings, rng.fork('amenities'));
  cityLayers.setData('amenities', amenities);

  // B12. Urban land cover
  const urbanCover = generateCityLandCover(cityLayers, amenities, rng.fork('urbanCover'));
  cityLayers.setGrid('urbanCover', urbanCover);

  // Run city validators
  const validators = getCityValidators();
  const validation = runValidators(cityLayers, validators);
  cityLayers.setData('cityValidation', validation);

  return cityLayers;
}

/**
 * Feedback Loop D: approximate betweenness centrality and rezone
 * high-centrality local streets to commercial.
 */
export function rezoneHighCentralityStreets(roadGraph, cityLayers) {
  const districts = cityLayers.getGrid('districts');
  const params = cityLayers.getData('params');
  if (!districts || !params) return;

  const cs = params.cellSize;

  // Approximate centrality: count how many shortest-path trees pass through each node.
  // Use BFS from a sample of nodes for speed.
  const nodeIds = [...roadGraph.nodes.keys()];
  if (nodeIds.length < 4) return;

  const centralityCount = new Map();
  for (const id of nodeIds) centralityCount.set(id, 0);

  // Sample up to 20 source nodes
  const sampleSize = Math.min(20, nodeIds.length);
  const step = Math.max(1, Math.floor(nodeIds.length / sampleSize));

  for (let s = 0; s < nodeIds.length; s += step) {
    const sourceId = nodeIds[s];
    // BFS
    const visited = new Map(); // nodeId -> parentId
    const queue = [sourceId];
    visited.set(sourceId, null);

    while (queue.length > 0) {
      const cur = queue.shift();
      for (const neighbor of roadGraph.neighbors(cur)) {
        if (!visited.has(neighbor)) {
          visited.set(neighbor, cur);
          queue.push(neighbor);
        }
      }
    }

    // Walk back from each reached node and increment centrality
    for (const [nodeId, parent] of visited) {
      if (parent === null) continue;
      let cur = parent;
      while (cur !== null && cur !== sourceId) {
        centralityCount.set(cur, (centralityCount.get(cur) || 0) + 1);
        cur = visited.get(cur);
      }
    }
  }

  // Find threshold for high centrality (top 15%)
  const counts = [...centralityCount.values()].sort((a, b) => a - b);
  const threshold = counts[Math.floor(counts.length * 0.85)] || 1;

  // Rezone cells near high-centrality local-street nodes to commercial (0)
  for (const [nodeId, count] of centralityCount) {
    if (count < threshold) continue;

    // Check if this node is on a local street
    const edges = roadGraph.incidentEdges(nodeId);
    const isLocal = edges.some(eId => {
      const e = roadGraph.getEdge(eId);
      return e && e.hierarchy === 'local';
    });
    if (!isLocal) continue;

    const node = roadGraph.getNode(nodeId);
    const gx = Math.round(node.x / cs);
    const gz = Math.round(node.z / cs);

    // Rezone nearby cells to commercial
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = gx + dx;
        const cz = gz + dz;
        if (cx >= 0 && cx < districts.width && cz >= 0 && cz < districts.height) {
          const current = districts.get(cx, cz);
          // Only rezone residential to commercial (not industrial/parkland)
          if (current === 1 || current === 2) {
            districts.set(cx, cz, 0); // COMMERCIAL
          }
        }
      }
    }
  }
}

/**
 * Feedback Loop B: flag plots with low building coverage as open space.
 */
function flagLowCoveragePlots(plots, buildings, cityLayers) {
  if (!plots || plots.length === 0 || !buildings) return;

  // Build spatial index of building centroids
  const buildingCentroids = buildings.map(b => b.centroid);

  let openSpaceCount = 0;
  for (const plot of plots) {
    // Check if any building centroid falls inside this plot
    let hasBuildingNear = false;
    for (const bc of buildingCentroids) {
      const dx = bc.x - plot.centroid.x;
      const dz = bc.z - plot.centroid.z;
      if (dx * dx + dz * dz < plot.area) {
        hasBuildingNear = true;
        break;
      }
    }

    if (!hasBuildingNear) {
      plot.openSpace = true;
      openSpaceCount++;
    }
  }

  cityLayers.setData('openSpacePlots', openSpaceCount);
}
