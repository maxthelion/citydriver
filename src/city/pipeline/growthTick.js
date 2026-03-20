// src/city/pipeline/growthTick.js
/**
 * Growth tick orchestration — individual phase functions + compatibility wrapper.
 *
 * Phases (exported individually for use by organicGrowthPipeline generator):
 *   runInfluencePhase — blur reservation masks into proximity gradients
 *   runValuePhase     — compose per-agent value bitmaps from spatial + influence layers
 *   runRibbonPhase    — throttled ribbon layout into high-value zones (Phase 2.5)
 *   runAllocatePhase  — BFS-claim cells from each agent's value bitmap
 *   runRoadsPhase     — grow roads from ribbon gaps; agriculture fill
 *
 * runGrowthTick — backward-compat wrapper that runs all phases in sequence.
 *
 * Spec: specs/v5/next-steps.md § Step 6
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

const DEV_PROXIMITY_THRESHOLD = 0.01;

// ── State initialisation ────────────────────────────────────────────────────

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

  if (!map.hasLayer('reservationGrid')) {
    map.setLayer('reservationGrid', new Grid2D(map.width, map.height, {
      type: 'uint8', cellSize: map.cellSize,
      originX: map.originX, originZ: map.originZ,
    }));
  }

  let totalZoneCells = 0;
  if (map.developmentZones) {
    for (const zone of map.developmentZones) totalZoneCells += zone.cells.length;
  }

  return { tick: 0, claimedCounts, totalZoneCells };
}

// ── Phase functions ─────────────────────────────────────────────────────────

/**
 * Phase 1 INFLUENCE: blur reservation masks into proximity gradients.
 * Also retreats agriculture cells near active development.
 *
 * @param {object} map
 * @param {object} archetype
 * @returns {{ influenceLayers: object, devProximity: Float32Array }}
 */
export function runInfluencePhase(map, archetype) {
  const w = map.width, h = map.height;
  const growth = archetype.growth;
  const resGrid = map.getLayer('reservationGrid');
  const influenceRadii = growth.influenceRadii || {};
  const nuclei = map.nuclei || [];

  const influenceLayers = computeInfluenceLayers(resGrid, w, h, influenceRadii, nuclei);
  const devProximity = influenceLayers.developmentProximity;

  // Agriculture retreat: cells near development that were agriculture → NONE
  for (let i = 0; i < w * h; i++) {
    if (resGrid.data[i] === RESERVATION.AGRICULTURE && devProximity[i] >= DEV_PROXIMITY_THRESHOLD) {
      resGrid.data[i] = RESERVATION.NONE;
    }
  }

  return { influenceLayers, devProximity };
}

/**
 * Phase 2 VALUE: compose per-agent value bitmaps from spatial + influence layers.
 *
 * @param {object} map
 * @param {object} archetype
 * @param {object} influenceLayers - output of runInfluencePhase
 * @returns {{ valueLayers: object }}
 */
export function runValuePhase(map, archetype, influenceLayers) {
  const w = map.width, h = map.height;
  const growth = archetype.growth;

  const layers = {};
  for (const name of ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness', 'roadGrid', 'landValue']) {
    if (map.hasLayer(name)) layers[name] = map.getLayer(name);
  }
  for (const [name, arr] of Object.entries(influenceLayers)) {
    layers[name] = arr;
  }

  const valueLayers = composeAllValueLayers(growth.valueComposition || {}, layers, w, h);

  // Store on map for debugging
  map._valueLayers = valueLayers;
  map._influenceLayers = influenceLayers;

  return { valueLayers };
}

/**
 * Phase 2.5 RIBBONS (throttled): extend street network into high-value zones.
 * Only processes zones near existing development. Caps zones per tick.
 *
 * @param {object} map
 * @param {object} archetype
 * @param {object} state - growth state (mutates _processedRibbonZones)
 * @param {Float32Array} devProximity - from runInfluencePhase
 */
export function runRibbonPhase(map, archetype, state, devProximity) {
  if (!map.developmentZones || map.developmentZones.length === 0) return;
  const growth = archetype.growth;
  const maxZonesPerTick = growth.roadGrowth?.zonesPerTick || 5;
  const processedZones = state._processedRibbonZones || new Set();
  const w = map.width;

  const zoneScores = [];
  for (let zi = 0; zi < map.developmentZones.length; zi++) {
    if (processedZones.has(zi)) continue;
    const zone = map.developmentZones[zi];
    let dpSum = 0;
    const sampleStep = Math.max(1, Math.floor(zone.cells.length / 50));
    let count = 0;
    for (let ci = 0; ci < zone.cells.length; ci += sampleStep) {
      const c = zone.cells[ci];
      dpSum += devProximity[c.gz * w + c.gx];
      count++;
    }
    const avgDp = count > 0 ? dpSum / count : 0;
    if (avgDp > DEV_PROXIMITY_THRESHOLD) zoneScores.push({ zi, avgDp });
  }
  zoneScores.sort((a, b) => b.avgDp - a.avgDp);

  const zonesToProcess = zoneScores.slice(0, maxZonesPerTick);
  if (zonesToProcess.length > 0) {
    const allZones = map.developmentZones;
    map.developmentZones = zonesToProcess.map(z => allZones[z.zi]);
    layoutRibbons(map);
    map.developmentZones = allZones;
    for (const z of zonesToProcess) processedZones.add(z.zi);
    state._processedRibbonZones = processedZones;
  }
}

/**
 * Phase 3 ALLOCATE: for each agent in priority order, claim cells from value bitmap.
 *
 * @param {object} map
 * @param {object} archetype
 * @param {object} state - growth state (mutates claimedCounts)
 * @param {object} valueLayers - from runValuePhase
 * @param {Float32Array} devProximity - from runInfluencePhase
 * @returns {{ anyAllocated: boolean, allRibbonGaps: object[], allRibbonEndpoints: object[] }}
 */
export function runAllocatePhase(map, archetype, state, valueLayers, devProximity) {
  const w = map.width, h = map.height;
  const growth = archetype.growth;
  const resGrid  = map.getLayer('reservationGrid');
  const zoneGrid = map.getLayer('zoneGrid');
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const slopeGrid = map.hasLayer('slope') ? map.getLayer('slope') : null;

  const agentPriority = growth.agentPriority || Object.keys(growth.agents || {});
  let anyAllocated = false;
  const allRibbonGaps = [];
  const allRibbonEndpoints = [];

  for (const agentType of agentPriority) {
    if (agentType === 'agriculture') continue;
    const agentConfig = (growth.agents || {})[agentType];
    if (!agentConfig) continue;

    const resType = AGENT_TYPE_TO_RESERVATION[agentType];
    if (resType === undefined) continue;

    const cap = Math.round(agentConfig.share * state.totalZoneCells);
    const claimed = state.claimedCounts.get(agentType) || 0;
    if (claimed >= cap) continue;

    const remainingTotal = cap - claimed;
    const tickBudget = agentConfig.budgetPerTick
      ? Math.round(agentConfig.budgetPerTick * state.totalZoneCells)
      : remainingTotal;
    const budget = Math.min(tickBudget, remainingTotal);
    if (budget <= 0) continue;

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

  return { anyAllocated, allRibbonGaps, allRibbonEndpoints };
}

/**
 * Phase 4 ROADS: grow streets from ribbon results + agriculture fill.
 *
 * @param {object} map
 * @param {object} archetype
 * @param {object} state - growth state (mutates claimedCounts)
 * @param {{ anyAllocated: boolean, allRibbonGaps: object[], allRibbonEndpoints: object[] }} allocResult
 * @returns {boolean} true if growth is complete (no allocations happened)
 */
export function runRoadsPhase(map, archetype, state, allocResult) {
  const w = map.width, h = map.height;
  const growth = archetype.growth;
  const { anyAllocated, allRibbonGaps, allRibbonEndpoints } = allocResult;

  const roadGrid  = map.hasLayer('roadGrid')  ? map.getLayer('roadGrid')  : null;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;

  if (roadGrid && (allRibbonGaps.length > 0 || allRibbonEndpoints.length > 0)) {
    const roadConfig = growth.roadGrowth || {};
    growRoads({
      roadGrid, waterMask,
      ribbonGaps: allRibbonGaps,
      ribbonEndpoints: allRibbonEndpoints,
      w, h,
      maxCrossStreetLength: roadConfig.maxCrossStreetLength || 40,
      pathClosingDistance:  roadConfig.pathClosingDistance  || 30,
      roadNetwork: map.roadNetwork || null,
    });
  }

  // Agriculture fill: cells just beyond the development frontier
  const agriConfig = (growth.agents || {}).agriculture;
  const resGrid = map.getLayer('reservationGrid');
  const zoneGrid = map.getLayer('zoneGrid');

  if (agriConfig && resGrid && zoneGrid) {
    const agriCap = Math.round(agriConfig.share * state.totalZoneCells);
    const agriClaimed = state.claimedCounts.get('agriculture') || 0;

    // Recompute devProximity for agriculture from influence layers (use stored)
    const devProximity = map._influenceLayers?.developmentProximity;
    if (agriClaimed < agriCap && devProximity) {
      let newAgriCount = 0;
      for (let gz = 0; gz < h; gz++) {
        for (let gx = 0; gx < w; gx++) {
          if (newAgriCount + agriClaimed >= agriCap) break;
          if (zoneGrid.get(gx, gz) === 0) continue;
          if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
          const dp = devProximity[gz * w + gx];
          if (dp < DEV_PROXIMITY_THRESHOLD && dp > 0.0005) {
            resGrid.set(gx, gz, RESERVATION.AGRICULTURE);
            newAgriCount++;
          }
        }
      }
      if (newAgriCount > 0) {
        state.claimedCounts.set('agriculture', agriClaimed + newAgriCount);
      }
    }
  }

  // Persist state on map for clone support
  map.growthState = state;

  return !anyAllocated;
}

// ── Backward-compat wrapper ────────────────────────────────────────────────

/**
 * Run one complete growth tick (all phases).
 * Backward-compatible wrapper — called by the old state machine path.
 *
 * @param {object} map
 * @param {object} archetype
 * @param {object} state - growth state (mutated)
 * @returns {boolean} true if growth is complete
 */
export function runGrowthTick(map, archetype, state) {
  const maxTicks = archetype.growth.maxGrowthTicks || 8;
  if (state.tick >= maxTicks) return true;
  state.tick++;

  const influenceResult = runInfluencePhase(map, archetype);
  const valueResult     = runValuePhase(map, archetype, influenceResult.influenceLayers);

  runRibbonPhase(map, archetype, state, influenceResult.devProximity);

  const allocResult     = runAllocatePhase(map, archetype, state, valueResult.valueLayers, influenceResult.devProximity);
  return runRoadsPhase(map, archetype, state, allocResult);
}
