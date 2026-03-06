/**
 * Unified pathfinding cost function factory.
 *
 * Reads the buildability grid for all terrain checks (water, sea level,
 * slope, edge margin). Only adds pathfinding-specific concerns on top:
 *   - slope penalty (direction-dependent)
 *   - bridge bypass (overrides unbuildable water cells)
 *   - road reuse discount / plot penalty (from occupancy)
 *
 * Replaces: terrainCostFunction, sharedCost, buildGrowthCostFn, satCost, bridgeCost.
 */

import { OCCUPANCY_ROAD, OCCUPANCY_JUNCTION, OCCUPANCY_PLOT } from './roadOccupancy.js';

/**
 * @typedef {object} PathCostOptions
 * @property {number} [slopePenalty=10] - Cost multiplier for elevation change
 * @property {boolean} [allowBridges=true] - Whether bridgeGrid cells bypass unbuildable water
 * @property {number} [bridgeWaterCost=8] - Cost multiplier for water cells when bridges allowed and waterCost finite
 * @property {number} [reuseDiscount=0.5] - Cost multiplier for existing road cells (lower = prefer reuse)
 * @property {number} [plotPenalty=5.0] - Cost multiplier for plot cells
 * @property {number} [unbuildableCost=Infinity] - Cost for cells with buildability ~ 0 (Infinity = impassable)
 */

/**
 * Create a cost function for A* pathfinding.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {object} [options]
 * @returns {function(number, number, number, number): number}
 */
export function createPathCost(cityLayers, options = {}) {
  const {
    slopePenalty = 10,
    allowBridges = true,
    unbuildableCost = Infinity,
    reuseDiscount = 0.5,
    plotPenalty = 5.0,
  } = options;

  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const buildability = cityLayers.getGrid('buildability');
  const bridgeGrid = allowBridges ? cityLayers.getGrid('bridgeGrid') : null;
  const occupancy = cityLayers.getData('occupancy');

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;

  const occData = occupancy?.data;
  const occW = occupancy?.width || 0;
  const occH = occupancy?.height || 0;
  const occRes = occupancy?.res || 3;

  return function cost(fromGx, fromGz, toGx, toGz) {
    // Base distance + slope (the only direction-dependent component)
    const dx = toGx - fromGx;
    const dz = toGz - fromGz;
    const baseDist = Math.sqrt(dx * dx + dz * dz);

    const fromH = elevation.get(fromGx, fromGz);
    const toH = elevation.get(toGx, toGz);
    const slope = Math.abs(toH - fromH) / baseDist;

    let c = baseDist + slope * slopePenalty;

    // Bridge check — bridges bypass unbuildable water
    const isBridge = bridgeGrid && bridgeGrid.get(toGx, toGz) > 0;

    // Buildability: single source of truth for terrain suitability
    // (encodes water, sea level, slope, edge margin, waterfront bonus)
    if (buildability && toGx >= 0 && toGx < w && toGz >= 0 && toGz < h) {
      const b = buildability.get(toGx, toGz);
      if (b < 0.01) {
        // Unbuildable cell (water, sea, steep cliff, edge)
        if (isBridge) {
          // Bridge can cross — expensive but not impassable
          c *= 8;
        } else if (!isFinite(unbuildableCost)) {
          return Infinity;
        } else {
          c *= unbuildableCost;
        }
      } else if (b < 0.3) {
        // Low buildability — moderate penalty
        c *= 1 + 2 * (1 - b / 0.3);
      }
      // b >= 0.3: no terrain penalty
    }

    // Occupancy: road reuse discount / plot penalty
    // (separate from buildability because pathfinding needs to distinguish
    // "existing road" from "existing plot" from "empty land")
    if (occData) {
      const ax = Math.floor((toGx * cs) / occRes);
      const az = Math.floor((toGz * cs) / occRes);
      if (ax >= 0 && ax < occW && az >= 0 && az < occH) {
        const val = occData[az * occW + ax];
        if (val === OCCUPANCY_ROAD || val === OCCUPANCY_JUNCTION) {
          c *= reuseDiscount;
        } else if (val === OCCUPANCY_PLOT) {
          c *= plotPenalty;
        }
      }
    }

    return c;
  };
}

/**
 * Preset: anchor route pathfinding.
 * Strong reuse discount (routes merge onto shared grid).
 */
export function anchorRouteCost(cityLayers) {
  return createPathCost(cityLayers, {
    slopePenalty: 10,
    reuseDiscount: 0.15,
  });
}

/**
 * Preset: growth road pathfinding.
 * Moderate reuse, terrain-aware.
 */
export function growthRoadCost(cityLayers) {
  return createPathCost(cityLayers, {
    slopePenalty: 10,
    reuseDiscount: 0.5,
  });
}

/**
 * Preset: satellite connection pathfinding.
 * Strong reuse (wants to merge onto existing roads).
 */
export function satelliteCost(cityLayers) {
  return createPathCost(cityLayers, {
    slopePenalty: 10,
    reuseDiscount: 0.15,
  });
}

/**
 * Preset: nucleus-to-nucleus connections (Union-Find MST pattern).
 * Less slope-averse (structural roads), can cross water at high cost,
 * strongly prefers existing roads.
 */
export function nucleusConnectionCost(cityLayers) {
  return createPathCost(cityLayers, {
    slopePenalty: 5,
    unbuildableCost: 12,
    reuseDiscount: 0.1,
    plotPenalty: 3.0,
  });
}

/**
 * Preset: bridge-capable connections between neighborhoods.
 * Unbuildable cells are expensive but not impassable.
 */
export function bridgeCost(cityLayers) {
  return createPathCost(cityLayers, {
    slopePenalty: 3,
    unbuildableCost: 8,
    reuseDiscount: 0.1,
  });
}
