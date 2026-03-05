/**
 * City generation orchestrator (V4).
 * Neighborhood-first: place nuclei, connect them, generate influence fields,
 * then build street networks and fill with buildings.
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
import { extractWaterPolygons } from './extractWaterPolygons.js';
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

  // C1. Extract city context
  const cityLayers = extractCityContext(regionalLayers, settlement, {
    cityRadius,
    cityCellSize,
  });

  // Population budget from settlement tier
  const tier = settlement.tier ?? 3;
  const targetPopulation = POPULATION_BY_TIER[tier] ?? 2000;
  cityLayers.setData('targetPopulation', targetPopulation);

  // C2. Refine terrain
  refineTerrain(cityLayers, rng.fork('cityTerrain'));

  // C2b. Extract smooth water boundary polygons
  const waterPolygons = extractWaterPolygons(cityLayers);
  cityLayers.setData('waterPolygons', waterPolygons);

  // C3. Anchor routes (inherited regional roads)
  const roadGraph = generateAnchorRoutes(cityLayers, rng.fork('anchorRoutes'));

  // C3b. River crossings (bridge points)
  const { bridgeGrid, bridges } = identifyRiverCrossings(cityLayers);
  cityLayers.setGrid('bridgeGrid', bridgeGrid);
  cityLayers.setData('bridges', bridges);

  // C4. Place neighborhood nuclei
  const neighborhoods = placeNeighborhoods(cityLayers, roadGraph, rng.fork('neighborhoods'));
  cityLayers.setData('neighborhoods', neighborhoods);

  // C5. Neighborhood influence (density + districts)
  const { density, districts, ownership } = computeNeighborhoodInfluence(cityLayers, neighborhoods);
  cityLayers.setGrid('density', density);
  cityLayers.setGrid('districts', districts);
  cityLayers.setData('ownership', ownership);

  // C6b. Large institutional plots (parks, churches, markets, etc.)
  const institutionalPlots = generateInstitutionalPlots(cityLayers, roadGraph, rng.fork('institutions'));
  cityLayers.setData('institutionalPlots', institutionalPlots);

  // C7. Streets and plots (merged, frontage-first)
  const { plots } = generateStreetsAndPlots(cityLayers, roadGraph, rng.fork('streetsAndPlots'));
  cityLayers.setData('plots', [...institutionalPlots, ...plots]);

  // C8. Loop closure (lightweight safety net)
  closeLoops(roadGraph, 500, cityLayers);

  // Store road graph
  cityLayers.setData('roadGraph', roadGraph);

  // C10. Buildings (with population budget)
  const buildings = generateBuildings(cityLayers, plots, rng.fork('buildings'));
  cityLayers.setData('buildings', buildings);

  // C11. Amenities
  const amenities = generateAmenities(cityLayers, buildings, rng.fork('amenities'));
  cityLayers.setData('amenities', amenities);

  // C12. Urban land cover
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

  const nodeIds = [...roadGraph.nodes.keys()];
  if (nodeIds.length < 4) return;

  const centralityCount = new Map();
  for (const id of nodeIds) centralityCount.set(id, 0);

  const sampleSize = Math.min(20, nodeIds.length);
  const step = Math.max(1, Math.floor(nodeIds.length / sampleSize));

  for (let s = 0; s < nodeIds.length; s += step) {
    const sourceId = nodeIds[s];
    const visited = new Map();
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

    for (const [nodeId, parent] of visited) {
      if (parent === null) continue;
      let cur = parent;
      while (cur !== null && cur !== sourceId) {
        centralityCount.set(cur, (centralityCount.get(cur) || 0) + 1);
        cur = visited.get(cur);
      }
    }
  }

  const counts = [...centralityCount.values()].sort((a, b) => a - b);
  const threshold = counts[Math.floor(counts.length * 0.85)] || 1;

  for (const [nodeId, count] of centralityCount) {
    if (count < threshold) continue;

    const edges = roadGraph.incidentEdges(nodeId);
    const isLocal = edges.some(eId => {
      const e = roadGraph.getEdge(eId);
      return e && e.hierarchy === 'local';
    });
    if (!isLocal) continue;

    const node = roadGraph.getNode(nodeId);
    const gx = Math.round(node.x / cs);
    const gz = Math.round(node.z / cs);

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = gx + dx;
        const cz = gz + dz;
        if (cx >= 0 && cx < districts.width && cz >= 0 && cz < districts.height) {
          const current = districts.get(cx, cz);
          if (current === 1 || current === 2) {
            districts.set(cx, cz, 0);
          }
        }
      }
    }
  }
}
