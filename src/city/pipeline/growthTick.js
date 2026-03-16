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

  // Step 1: Expand radii
  let allOutOfBounds = true;
  for (const [idx, radius] of state.nucleusRadii) {
    const newRadius = radius + radiusStepCells;
    state.nucleusRadii.set(idx, newRadius);
    // Check if any part of the radius is still in bounds
    const n = map.nuclei[idx];
    if (n.gx - newRadius < w && n.gx + newRadius >= 0 &&
        n.gz - newRadius < h && n.gz + newRadius >= 0) {
      allOutOfBounds = false;
    }
  }
  if (allOutOfBounds) return true;

  // Step 2: Agriculture retreat — mark agriculture cells within new radii as eligible
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (resGrid.get(gx, gz) === RESERVATION.AGRICULTURE) {
        // Check if within any nucleus radius
        for (const [idx, radius] of state.nucleusRadii) {
          const n = map.nuclei[idx];
          const dx = gx - n.gx, dz = gz - n.gz;
          if (dx * dx + dz * dz <= radius * radius) {
            resGrid.set(gx, gz, RESERVATION.NONE);
            break;
          }
        }
      }
    }
  }

  // Collect eligible cells: in a zone, within any nucleus radius, unreserved
  const eligible = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (zoneGrid.get(gx, gz) === 0) continue;
      if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
      // Check within any nucleus radius
      for (const [idx, radius] of state.nucleusRadii) {
        const n = map.nuclei[idx];
        const dx = gx - n.gx, dz = gz - n.gz;
        if (dx * dx + dz * dz <= radius * radius) {
          eligible.push({ gx, gz });
          break;
        }
      }
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

  // Step 4: Agriculture fills — unclaimed cells beyond all radii
  const agriConfig = growth.agents.agriculture;
  if (agriConfig) {
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (zoneGrid.get(gx, gz) === 0) continue;
        if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
        // Check if OUTSIDE all radii
        let insideAny = false;
        for (const [idx, radius] of state.nucleusRadii) {
          const n = map.nuclei[idx];
          const dx = gx - n.gx, dz = gz - n.gz;
          if (dx * dx + dz * dz <= radius * radius) {
            insideAny = true;
            break;
          }
        }
        if (!insideAny) {
          resGrid.set(gx, gz, RESERVATION.AGRICULTURE);
        }
      }
    }
  }

  // Persist state on map for clone support
  map.growthState = state;

  return false;
}
