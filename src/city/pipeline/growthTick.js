// src/city/pipeline/growthTick.js
/**
 * Growth tick orchestration.
 *
 * Each tick runs the influence → value → allocate pipeline:
 *   Phase 1 INFLUENCE: blur reservation masks into proximity gradients
 *   Phase 2 VALUE:     compose per-agent value bitmaps from spatial + influence layers
 *   Phase 3 ALLOCATE:  BFS-claim cells from each agent's value bitmap
 */

import { Grid2D } from '../../core/Grid2D.js';
import { RESERVATION, AGENT_TYPE_TO_RESERVATION } from './growthAgents.js';
import { computeInfluenceLayers } from './influenceLayers.js';
import { composeAllValueLayers } from './valueLayers.js';
import { allocateFromValueBitmap } from './allocate.js';
import { allocateFrontage } from './allocateFrontage.js';
import { allocateRibbon } from './allocateRibbon.js';
import { growRoads } from './growRoads.js';
import { layoutRibbons } from './layoutRibbons.js';

/**
 * Initialize growth state for a map.
 * @param {object} map - FeatureMap
 * @param {object} archetype - archetype with growth config
 * @returns {object} growth state
 */
export function initGrowthState(map, archetype) {
  const claimedCounts = new Map();
  const agentPriority = archetype.growth.agentPriority || Object.keys(archetype.growth.agents || {});
  for (const agentType of agentPriority) {
    claimedCounts.set(agentType, 0);
  }

  // Initialize reservation grid if not present
  if (!map.hasLayer('reservationGrid')) {
    map.setLayer('reservationGrid', new Grid2D(map.width, map.height, {
      type: 'uint8', cellSize: map.cellSize,
      originX: map.originX, originZ: map.originZ,
    }));
  }

  // Count total zone cells for budget calculation
  let totalZoneCells = 0;
  if (map.developmentZones) {
    for (const zone of map.developmentZones) {
      totalZoneCells += zone.cells.length;
    }
  }

  return {
    tick: 0,
    claimedCounts,
    totalZoneCells,
  };
}

/**
 * Run one growth tick.
 * @param {object} map - FeatureMap
 * @param {object} archetype - archetype with growth config
 * @param {object} state - growth state (mutated)
 * @returns {boolean} true if growth is complete (terminated)
 */
export function runGrowthTick(map, archetype, state) {
  const growth = archetype.growth;
  const maxTicks = growth.maxGrowthTicks || 8;

  // Check termination
  if (state.tick >= maxTicks) return true;

  state.tick++;

  const w = map.width;
  const h = map.height;

  const resGrid = map.getLayer('reservationGrid');
  const zoneGrid = map.getLayer('zoneGrid');

  // Load base spatial layers from map (Grid2D or array-like accessors)
  const layers = {};
  for (const name of ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness', 'roadGrid', 'landValue']) {
    if (map.hasLayer(name)) layers[name] = map.getLayer(name);
  }

  // Phase 1 INFLUENCE: compute blurred proximity gradients from the reservation grid
  const influenceRadii = growth.influenceRadii || {};
  const nuclei = map.nuclei || [];
  const influenceLayers = computeInfluenceLayers(resGrid, w, h, influenceRadii, nuclei);

  // Merge influence layers (Float32Array values) into the combined layers object.
  // composeAllValueLayers accepts both Grid2D (.get method) and Float32Array (index access).
  for (const [name, arr] of Object.entries(influenceLayers)) {
    layers[name] = arr;
  }

  // Pull out the development proximity array for use as a filter in allocate
  const devProximity = influenceLayers.developmentProximity;
  const DEV_PROXIMITY_THRESHOLD = 0.01;

  // Phase 2 VALUE: compose per-agent value bitmaps
  const valueComposition = growth.valueComposition || {};
  const valueLayers = composeAllValueLayers(valueComposition, layers, w, h);

  // Store on map for debugging
  map._valueLayers = valueLayers;
  map._influenceLayers = influenceLayers;

  // Agriculture retreat: cells near development that were agriculture → NONE
  for (let i = 0; i < w * h; i++) {
    if (resGrid.data[i] === RESERVATION.AGRICULTURE && devProximity[i] >= DEV_PROXIMITY_THRESHOLD) {
      resGrid.data[i] = RESERVATION.NONE;
    }
  }

  // Phase 2.5 ROADS: extend street network into high-value areas (throttled layoutRibbons)
  // Only process zones near existing development. Cap zones per tick.
  if (map.developmentZones && map.developmentZones.length > 0) {
    const maxZonesPerTick = growth.roadGrowth?.zonesPerTick || 5;
    const processedZones = state._processedRibbonZones || new Set();

    // Score zones by average devProximity of their cells — develop near existing city first
    const zoneScores = [];
    for (let zi = 0; zi < map.developmentZones.length; zi++) {
      if (processedZones.has(zi)) continue;
      const zone = map.developmentZones[zi];
      let dpSum = 0;
      const sampleStep = Math.max(1, Math.floor(zone.cells.length / 50)); // sample for speed
      let count = 0;
      for (let ci = 0; ci < zone.cells.length; ci += sampleStep) {
        const c = zone.cells[ci];
        dpSum += devProximity[c.gz * w + c.gx];
        count++;
      }
      const avgDp = count > 0 ? dpSum / count : 0;
      if (avgDp > DEV_PROXIMITY_THRESHOLD) {
        zoneScores.push({ zi, avgDp });
      }
    }
    zoneScores.sort((a, b) => b.avgDp - a.avgDp);

    // Process top N zones — layoutRibbons on a subset
    const zonesToProcess = zoneScores.slice(0, maxZonesPerTick);
    if (zonesToProcess.length > 0) {
      // Temporarily set developmentZones to just the selected zones
      const allZones = map.developmentZones;
      map.developmentZones = zonesToProcess.map(z => allZones[z.zi]);
      layoutRibbons(map);
      map.developmentZones = allZones;

      for (const z of zonesToProcess) processedZones.add(z.zi);
      state._processedRibbonZones = processedZones;
    }
  }

  // Phase 3 ALLOCATE: for each agent in priority order, dispatch to correct allocator
  const agentPriority = growth.agentPriority || Object.keys(growth.agents || {});
  let anyAllocated = false;
  const allRibbonGaps = [];
  const allRibbonEndpoints = [];

  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const slopeGrid = map.hasLayer('slope') ? map.getLayer('slope') : null;

  for (const agentType of agentPriority) {
    if (agentType === 'agriculture') continue; // handled after other agents

    const agentConfig = (growth.agents || {})[agentType];
    if (!agentConfig) continue;

    const resType = AGENT_TYPE_TO_RESERVATION[agentType];
    if (resType === undefined) continue;

    // Check cumulative cap
    const cap = Math.round(agentConfig.share * state.totalZoneCells);
    const claimed = state.claimedCounts.get(agentType) || 0;
    if (claimed >= cap) continue;

    const remainingTotal = cap - claimed;
    const tickBudget = agentConfig.budgetPerTick
      ? Math.round(agentConfig.budgetPerTick * state.totalZoneCells)
      : remainingTotal;
    const budget = Math.min(tickBudget, remainingTotal);
    if (budget <= 0) continue;

    // Get this agent's value layer
    const valueLayer = valueLayers[agentType] || new Float32Array(w * h);

    let newCells;
    const allocatorType = agentConfig.allocator || 'blob';

    if (allocatorType === 'frontage' && roadGrid) {
      newCells = allocateFrontage({
        valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
        resType, budget,
        maxDepth: agentConfig.maxDepth || 3,
        valueThreshold: agentConfig.valueThreshold || 0.3,
        w, h,
      });
    } else if (allocatorType === 'ribbon' && roadGrid) {
      const result = allocateRibbon({
        valueLayer, resGrid, zoneGrid, roadGrid, slope: slopeGrid, devProximity,
        resType, budget,
        plotDepth: agentConfig.plotDepth || 3,
        gapWidth: agentConfig.gapWidth || 1,
        maxRibbonLength: agentConfig.maxRibbonLength || 30,
        seedCount: agentConfig.seedCount || 5,
        noise: agentConfig.noise || 0.1,
        w, h, cellSize: map.cellSize,
      });
      newCells = result.claimed;
      allRibbonGaps.push(...result.ribbonGaps);
      allRibbonEndpoints.push(...result.ribbonEndpoints);
    } else {
      // Default: BFS blob
      newCells = allocateFromValueBitmap({
        valueLayer, resGrid, zoneGrid, devProximity, resType, budget,
        minFootprint: agentConfig.minFootprint || 1,
        seedCount: agentConfig.seedCount || 3,
        minSpacing: agentConfig.minSpacing || 20,
        noise: agentConfig.noise != null ? agentConfig.noise : 0.15,
        w, h,
      });
    }

    if (newCells && newCells.length > 0) {
      anyAllocated = true;
      state.claimedCounts.set(agentType, claimed + newCells.length);
    }
  }

  // Phase 4 ROADS: grow streets from ribbon results
  if (roadGrid && (allRibbonGaps.length > 0 || allRibbonEndpoints.length > 0)) {
    const roadConfig = growth.roadGrowth || {};
    const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
    growRoads({
      roadGrid,
      waterMask,
      ribbonGaps: allRibbonGaps,
      ribbonEndpoints: allRibbonEndpoints,
      w, h,
      maxCrossStreetLength: roadConfig.maxCrossStreetLength || 40,
      pathClosingDistance: roadConfig.pathClosingDistance || 30,
    });
  }

  // Agriculture fill: contiguous belt just beyond the development frontier
  const agriConfig = (growth.agents || {}).agriculture;
  if (agriConfig) {
    const agriCap = Math.round(agriConfig.share * state.totalZoneCells);
    const agriClaimed = state.claimedCounts.get('agriculture') || 0;
    if (agriClaimed < agriCap) {
      // Simple fill: all zone cells that are beyond the frontier but near it
      let newAgriCount = 0;
      for (let gz = 0; gz < h; gz++) {
        for (let gx = 0; gx < w; gx++) {
          if (newAgriCount + agriClaimed >= agriCap) break;
          if (zoneGrid.get(gx, gz) === 0) continue;
          if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
          const dp = devProximity[gz * w + gx];
          // Beyond the active frontier but within the blur radius (near development)
          if (dp < DEV_PROXIMITY_THRESHOLD && dp > 0.0005) {
            resGrid.set(gx, gz, RESERVATION.AGRICULTURE);
            newAgriCount++;
          }
        }
      }
      if (newAgriCount > 0) {
        anyAllocated = true;
        state.claimedCounts.set('agriculture', agriClaimed + newAgriCount);
      }
    }
  }

  // Persist state on map for clone support
  map.growthState = state;

  // Terminate if nothing was allocated (all caps reached or no eligible cells)
  return !anyAllocated;
}
