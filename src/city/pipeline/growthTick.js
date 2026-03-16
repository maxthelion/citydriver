// src/city/pipeline/growthTick.js
/**
 * Growth tick orchestration.
 * Each tick expands development radii and runs growth agents.
 */

import { Grid2D } from '../../core/Grid2D.js';
import { RESERVATION, AGENT_TYPE_TO_RESERVATION, scoreCell, findSeeds, spreadFromSeed } from './growthAgents.js';

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

  // Step 1: Expand development frontier
  // Eligibility is based on proximity to existing development, not circular radius.
  // On first tick, seed from nuclei positions. On subsequent ticks, cells adjacent
  // to any claimed cell (within `radiusStepCells` distance) become eligible.
  // This makes the frontier follow the shape of the city, not a circle.

  // Build a distance grid: BFS outward from all claimed cells (and nuclei on tick 1)
  const distGrid = new Int16Array(w * h).fill(-1);
  const queue = [];

  if (state.tick === 1) {
    // First tick: seed from nuclei
    for (const n of map.nuclei) {
      const idx = n.gz * w + n.gx;
      if (distGrid[idx] < 0) {
        distGrid[idx] = 0;
        queue.push(n.gx, n.gz);
      }
    }
  }

  // Also seed from all existing claimed cells
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const v = resGrid.get(gx, gz);
      if (v !== RESERVATION.NONE && v !== RESERVATION.AGRICULTURE) {
        const idx = gz * w + gx;
        if (distGrid[idx] < 0) {
          distGrid[idx] = 0;
          queue.push(gx, gz);
        }
      }
    }
  }

  // BFS to find cells within radiusStepCells of existing development
  let qi = 0;
  while (qi < queue.length) {
    const cx = queue[qi++];
    const cz = queue[qi++];
    const cd = distGrid[cz * w + cx];
    if (cd >= radiusStepCells) continue;
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      const ni = nz * w + nx;
      if (distGrid[ni] >= 0) continue;
      distGrid[ni] = cd + 1;
      queue.push(nx, nz);
    }
  }

  // Step 2: Agriculture retreat — cells now near development become eligible
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (resGrid.get(gx, gz) === RESERVATION.AGRICULTURE && distGrid[gz * w + gx] >= 0) {
        resGrid.set(gx, gz, RESERVATION.NONE);
      }
    }
  }

  // Collect eligible cells: in a zone, within frontier distance, unreserved
  const eligible = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (zoneGrid.get(gx, gz) === 0) continue;
      if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
      if (distGrid[gz * w + gx] < 0) continue; // not within frontier
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
      agentConfig.seedStrategy, agentEligible, agentConfig.seedsPerTick,
      agentConfig.footprint, agentConfig.affinity, layers, w, h, resGrid
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
        if (distGrid[gz * w + gx] >= 0) continue; // inside frontier — skip
        // Check if close to frontier (within 2× radiusStep) for agriculture belt
        let nearFrontier = false;
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          for (let d = 1; d <= radiusStepCells; d++) {
            const nx = gx + dx * d, nz = gz + dz * d;
            if (nx >= 0 && nx < w && nz >= 0 && nz < h && distGrid[nz * w + nx] >= 0) {
              nearFrontier = true;
              break;
            }
          }
          if (nearFrontier) break;
        }
        if (nearFrontier) {
          resGrid.set(gx, gz, RESERVATION.AGRICULTURE);
        }
      }
    }
  }

  // Persist state on map for clone support
  map.growthState = state;

  return false;
}
