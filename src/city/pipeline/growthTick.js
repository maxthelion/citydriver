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

  // Phase 3 ALLOCATE: for each agent in priority order, claim cells from its value bitmap
  const agentPriority = growth.agentPriority || Object.keys(growth.agents || {});
  let anyAllocated = false;

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
    const budget = Math.min(agentConfig.budgetPerTick || remainingTotal, remainingTotal);
    if (budget <= 0) continue;

    // Get this agent's value layer (fall back to empty if not in valueComposition)
    const valueLayer = valueLayers[agentType] || new Float32Array(w * h);

    const newCells = allocateFromValueBitmap({
      valueLayer,
      resGrid,
      zoneGrid,
      devProximity,
      resType,
      budget,
      minFootprint: agentConfig.minFootprint || 1,
      w,
      h,
    });

    if (newCells.length > 0) {
      anyAllocated = true;
      state.claimedCounts.set(agentType, claimed + newCells.length);
    }
  }

  // Agriculture fill: unclaimed cells just beyond the development frontier
  const agriConfig = (growth.agents || {}).agriculture;
  if (agriConfig) {
    const agriValueLayer = valueLayers.agriculture || new Float32Array(w * h);
    const agriCap = Math.round(agriConfig.share * state.totalZoneCells);
    const agriClaimed = state.claimedCounts.get('agriculture') || 0;
    const agriBudget = Math.min(agriConfig.budgetPerTick || agriCap, agriCap - agriClaimed);

    if (agriBudget > 0) {
      // Agriculture fills cells that are outside the active frontier
      // (devProximity is small but nonzero — just beyond the settled fringe)
      // Build a custom value layer for agriculture: eligible only beyond frontier
      const agriMask = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const dp = devProximity[i];
        if (resGrid.data[i] === RESERVATION.NONE && dp < DEV_PROXIMITY_THRESHOLD && dp > 0.001) {
          agriMask[i] = agriValueLayer[i] > 0 ? agriValueLayer[i] : 0.5;
        }
      }

      // Direct fill without devProximity filter (we've already filtered via agriMask)
      const newAgriCells = allocateFromValueBitmap({
        valueLayer: agriMask,
        resGrid,
        zoneGrid,
        devProximity: null, // already encoded in agriMask
        resType: RESERVATION.AGRICULTURE,
        budget: agriBudget,
        minFootprint: agriConfig.minFootprint || 1,
        w,
        h,
      });

      if (newAgriCells.length > 0) {
        anyAllocated = true;
        state.claimedCounts.set('agriculture', agriClaimed + newAgriCells.length);
      }
    }
  }

  // Persist state on map for clone support
  map.growthState = state;

  // Terminate if nothing was allocated (all caps reached or no eligible cells)
  return !anyAllocated;
}
