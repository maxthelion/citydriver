// src/city/pipeline/growthTick.js
/**
 * Growth tick orchestration.
 * Each tick expands development radii and runs growth agents.
 */

import { Grid2D } from '../../core/Grid2D.js';
import { RESERVATION, AGENT_TYPE_TO_RESERVATION, scoreCell, findSeeds, spreadFromSeed } from './growthAgents.js';

/**
 * Separable box blur. Returns a normalised Float32Array (0-1).
 * @param {Float32Array} src - input values
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @param {number} radius - blur radius in cells
 * @returns {Float32Array}
 */
function boxBlur(src, w, h, radius) {
  const dst = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  // Horizontal pass
  for (let z = 0; z < h; z++) {
    let sum = 0;
    for (let x = 0; x < Math.min(radius, w); x++) sum += src[z * w + x];
    for (let x = 0; x < w; x++) {
      const add = x + radius < w ? src[z * w + x + radius] : 0;
      const sub = x - radius - 1 >= 0 ? src[z * w + x - radius - 1] : 0;
      sum += add - sub;
      tmp[z * w + x] = sum;
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let z = 0; z < Math.min(radius, h); z++) sum += tmp[z * w + x];
    for (let z = 0; z < h; z++) {
      const add = z + radius < h ? tmp[(z + radius) * w + x] : 0;
      const sub = z - radius - 1 >= 0 ? tmp[(z - radius - 1) * w + x] : 0;
      sum += add - sub;
      dst[z * w + x] = sum;
    }
  }
  // Normalise to 0-1
  let max = 0;
  for (let i = 0; i < w * h; i++) if (dst[i] > max) max = dst[i];
  if (max > 0) for (let i = 0; i < w * h; i++) dst[i] /= max;
  return dst;
}

/**
 * Initialize growth state for a map.
 * @param {object} map - FeatureMap
 * @param {object} archetype - archetype with growth config
 * @returns {object} growth state
 */
export function initGrowthState(map, archetype) {
  const nucleusRadii = new Map();
  for (let i = 0; i < map.nuclei.length; i++) {
    nucleusRadii.set(i, 0);
  }

  const claimedCounts = new Map();
  const activeSeeds = new Map();
  for (const agentType of archetype.growth.agentPriority) {
    claimedCounts.set(agentType, 0);
    activeSeeds.set(agentType, []);
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
    nucleusRadii,
    activeSeeds,
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
  const radiusStepCells = Math.round(growth.radiusStep / map.cellSize);
  const w = map.width;
  const h = map.height;

  const resGrid = map.getLayer('reservationGrid');
  const zoneGrid = map.getLayer('zoneGrid');

  // Load spatial layers
  const layers = {};
  for (const name of ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness', 'roadGrid', 'landValue']) {
    if (map.hasLayer(name)) layers[name] = map.getLayer(name);
  }

  // Step 1: Compute per-tick spatial layers

  // Build binary mask of existing development (not NONE, not AGRICULTURE)
  const devMask = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const v = resGrid.get(gx, gz);
      devMask[gz * w + gx] = (v !== RESERVATION.NONE && v !== RESERVATION.AGRICULTURE) ? 1.0 : 0.0;
    }
  }
  // On first tick, also seed from nuclei
  if (state.tick === 1) {
    for (const n of map.nuclei) {
      devMask[n.gz * w + n.gx] = 1.0;
    }
  }
  // Box blur to create smooth proximity gradient
  const devProximity = boxBlur(devMask, w, h, radiusStepCells);
  layers.developmentProximity = { get: (x, z) => devProximity[z * w + x] };

  // Build industrial distance layer (inverse of industrial proximity)
  const indMask = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      indMask[gz * w + gx] = resGrid.get(gx, gz) === RESERVATION.INDUSTRIAL ? 1.0 : 0.0;
    }
  }
  const indProximity = boxBlur(indMask, w, h, 40); // ~200m at 5m cells
  // Invert: high value = far from industrial
  const maxInd = Math.max(...indProximity) || 1;
  const indDistance = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    indDistance[i] = 1.0 - indProximity[i] / maxInd;
  }
  layers.industrialDistance = { get: (x, z) => indDistance[z * w + x] };

  // Update nucleus radii to reflect growth (increment by radiusStep each tick)
  for (const [i] of state.nucleusRadii) {
    state.nucleusRadii.set(i, state.tick * radiusStepCells);
  }

  // Step 2: Agriculture retreat — cells with high devProximity that were agriculture become NONE
  const DEV_PROXIMITY_THRESHOLD = 0.01;
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (resGrid.get(gx, gz) === RESERVATION.AGRICULTURE && devProximity[gz * w + gx] >= DEV_PROXIMITY_THRESHOLD) {
        resGrid.set(gx, gz, RESERVATION.NONE);
      }
    }
  }

  // Collect eligible cells: in a zone, unreserved, close enough to existing development
  const eligible = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (zoneGrid.get(gx, gz) === 0) continue;
      if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
      if (devProximity[gz * w + gx] < DEV_PROXIMITY_THRESHOLD) continue;
      eligible.push({ gx, gz });
    }
  }

  if (eligible.length === 0) return true; // all claimed

  // Step 3: Run agents in priority order
  for (const agentType of growth.agentPriority) {
    if (agentType === 'agriculture') continue; // handled separately in step 4

    const agentConfig = growth.agents[agentType];
    if (!agentConfig) continue;

    const resType = AGENT_TYPE_TO_RESERVATION[agentType];
    if (resType === undefined) continue;

    // Check cumulative cap
    const cap = Math.round(agentConfig.share * state.totalZoneCells);
    const claimed = state.claimedCounts.get(agentType) || 0;
    if (claimed >= cap) continue;
    const remainingBudget = cap - claimed;

    // Re-filter eligible (cells may have been claimed by earlier agents this tick)
    const agentEligible = eligible.filter(c => resGrid.get(c.gx, c.gz) === RESERVATION.NONE);
    if (agentEligible.length === 0) continue;

    // Find new seeds
    const seeds = findSeeds(
      agentEligible, agentConfig.seedsPerTick,
      agentConfig.minSpacing || 0, agentConfig.affinity, layers, w, h
    );

    // Grow existing seeds + new seeds
    const allSeeds = [...(state.activeSeeds.get(agentType) || []), ...seeds];
    let totalClaimed = 0;
    const survivingSeeds = [];

    for (const seed of allSeeds) {
      if (totalClaimed >= remainingBudget) break;
      // Check seed is still valid (not claimed by another agent)
      if (resGrid.get(seed.gx, seed.gz) !== RESERVATION.NONE &&
          resGrid.get(seed.gx, seed.gz) !== resType) continue;

      const budget = Math.min(agentConfig.footprint[1], remainingBudget - totalClaimed);
      const newCells = spreadFromSeed(
        seed, budget, resGrid, zoneGrid, resType,
        agentConfig.spreadBehaviour, agentConfig.affinity, layers, w, h
      );
      totalClaimed += newCells.length;

      if (newCells.length > 0) {
        survivingSeeds.push(seed); // keep for next tick
      }
    }

    state.activeSeeds.set(agentType, survivingSeeds);
    state.claimedCounts.set(agentType, claimed + totalClaimed);
  }

  // Step 4: Agriculture fills — unclaimed cells beyond the development frontier
  const agriConfig = growth.agents.agriculture;
  if (agriConfig) {
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (zoneGrid.get(gx, gz) === 0) continue;
        if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
        // Agriculture fills cells that are beyond the development frontier
        // but within a band (nonzero blur from being near the frontier edge)
        const dp = devProximity[gz * w + gx];
        if (dp < DEV_PROXIMITY_THRESHOLD && dp > 0.001) {
          resGrid.set(gx, gz, RESERVATION.AGRICULTURE);
        }
      }
    }
  }

  // Persist state on map for clone support
  map.growthState = state;

  return false;
}
