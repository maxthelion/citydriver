/**
 * Pipeline step: reserve land for non-residential uses based on archetype.
 * Reads: zoneGrid, developmentZones, spatial layers (centrality, etc.)
 * Writes: reservationGrid (layer), reservationZones (array on map)
 *
 * Reservation types (uint8 values in reservationGrid):
 *   0 = unreserved (available for residential)
 *   1 = commercial
 *   2 = industrial
 *   3 = civic
 *   4 = open space
 */

import { Grid2D } from '../../core/Grid2D.js';

export const RESERVATION = {
  NONE: 0,
  COMMERCIAL: 1,
  INDUSTRIAL: 2,
  CIVIC: 3,
  OPEN_SPACE: 4,
};

const USE_TYPE_TO_RESERVATION = {
  commercial: RESERVATION.COMMERCIAL,
  industrial: RESERVATION.INDUSTRIAL,
  civic: RESERVATION.CIVIC,
  openSpace: RESERVATION.OPEN_SPACE,
};

const SPATIAL_LAYER_NAMES = ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness'];

/**
 * @param {object} map - FeatureMap
 * @param {object|null} archetype - City archetype parameters
 * @returns {object} map (for chaining)
 */
export function reserveLandUse(map, archetype) {
  const grid = new Grid2D(map.width, map.height, {
    type: 'uint8',
    cellSize: map.cellSize,
    originX: map.originX,
    originZ: map.originZ,
  });

  const reservationZones = [];

  if (archetype && map.developmentZones && map.developmentZones.length > 0) {
    // Collect all zone cells
    const allZoneCells = [];
    for (const zone of map.developmentZones) {
      for (const cell of zone.cells) {
        allZoneCells.push(cell);
      }
    }
    const totalZoneCells = allZoneCells.length;
    if (totalZoneCells === 0) {
      map.setLayer('reservationGrid', grid);
      map.reservationZones = reservationZones;
      return map;
    }

    // Load spatial layers
    const spatialLayers = {};
    for (const name of SPATIAL_LAYER_NAMES) {
      if (map.hasLayer(name)) spatialLayers[name] = map.getLayer(name);
    }

    // Build zone cell lookup for fast membership check
    const zoneSet = new Set();
    for (const c of allZoneCells) zoneSet.add(c.gx | (c.gz << 16));

    // Reserve each use type in order
    for (const useType of archetype.reservationOrder) {
      const share = archetype.shares[useType];
      if (!share || share <= 0) continue;

      const budget = Math.round(totalZoneCells * share);
      if (budget <= 0) continue;

      const reservationType = USE_TYPE_TO_RESERVATION[useType];
      const placement = archetype.placement[useType];
      const growthMode = archetype.growthMode[useType];

      // Score all unreserved zone cells
      const scored = [];
      for (const c of allZoneCells) {
        if (grid.get(c.gx, c.gz) !== RESERVATION.NONE) continue;
        const score = scoreCell(c.gx, c.gz, placement, spatialLayers);
        scored.push({ gx: c.gx, gz: c.gz, score });
      }

      if (scored.length === 0) continue;

      // Find seed (highest-scoring cell)
      scored.sort((a, b) => b.score - a.score);
      const seed = scored[0];

      // Grow zone from seed
      let claimed;
      if (growthMode === 'directional') {
        const axis = determineAxis(seed.gx, seed.gz, placement, spatialLayers);
        claimed = growDirectional(seed, budget, grid, reservationType, placement, spatialLayers, zoneSet, axis);
      } else {
        claimed = growRadial(seed, budget, grid, reservationType, placement, spatialLayers, zoneSet);
      }

      // Store reservation zone
      if (claimed.length > 0) {
        let cx = 0, cz = 0;
        for (const c of claimed) { cx += c.gx; cz += c.gz; }
        reservationZones.push({
          useType,
          reservationType,
          cells: claimed,
          centroidGx: cx / claimed.length,
          centroidGz: cz / claimed.length,
        });
      }
    }
  }

  map.setLayer('reservationGrid', grid);
  map.reservationZones = reservationZones;
  return map;
}

/**
 * Score a cell for a given use type based on placement weights.
 */
function scoreCell(gx, gz, placement, spatialLayers) {
  let score = 0;
  for (const [layerName, weight] of Object.entries(placement)) {
    const layer = spatialLayers[layerName];
    if (layer) score += weight * layer.get(gx, gz);
  }
  return score;
}

/**
 * Determine the growth axis for directional growth.
 * Uses the gradient of the dominant spatial layer at the seed point.
 */
function determineAxis(gx, gz, placement, spatialLayers) {
  // Find the dominant layer (highest absolute weight)
  let dominantLayer = null;
  let maxWeight = 0;
  for (const [layerName, weight] of Object.entries(placement)) {
    if (Math.abs(weight) > maxWeight && spatialLayers[layerName]) {
      maxWeight = Math.abs(weight);
      dominantLayer = spatialLayers[layerName];
    }
  }

  if (!dominantLayer) return { x: 1, z: 0 };

  // Compute gradient of dominant layer at seed
  const dx = dominantLayer.get(gx + 1, gz) - dominantLayer.get(gx - 1, gz);
  const dz = dominantLayer.get(gx, gz + 1) - dominantLayer.get(gx, gz - 1);
  const len = Math.sqrt(dx * dx + dz * dz);

  if (len < 0.001) return { x: 1, z: 0 };

  // Axis is perpendicular to gradient (along the contour of the dominant field)
  return { x: -dz / len, z: dx / len };
}

/**
 * Radial growth: BFS outward from seed, visiting neighbours in score order.
 */
function growRadial(seed, budget, grid, reservationType, placement, spatialLayers, zoneSet) {
  const claimed = [];
  const visited = new Set();
  // Priority queue as sorted array (fine for these cell counts)
  const frontier = [{ gx: seed.gx, gz: seed.gz, score: seed.score }];
  visited.add(seed.gx | (seed.gz << 16));

  while (frontier.length > 0 && claimed.length < budget) {
    // Take highest-scoring cell from frontier
    let bestIdx = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].score > frontier[bestIdx].score) bestIdx = i;
    }
    const cell = frontier[bestIdx];
    frontier[bestIdx] = frontier[frontier.length - 1];
    frontier.pop();

    // Claim it
    grid.set(cell.gx, cell.gz, reservationType);
    claimed.push({ gx: cell.gx, gz: cell.gz });

    // Add neighbours
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cell.gx + dx, nz = cell.gz + dz;
      const key = nx | (nz << 16);
      if (visited.has(key)) continue;
      visited.add(key);
      if (!zoneSet.has(key)) continue;
      if (grid.get(nx, nz) !== RESERVATION.NONE) continue;
      const score = scoreCell(nx, nz, placement, spatialLayers);
      frontier.push({ gx: nx, gz: nz, score });
    }
  }

  return claimed;
}

/**
 * Directional growth: like radial but prioritises neighbours along an axis.
 * Along-axis neighbours get a 2× score bonus; perpendicular get 0.5×.
 */
function growDirectional(seed, budget, grid, reservationType, placement, spatialLayers, zoneSet, axis) {
  const claimed = [];
  const visited = new Set();
  const frontier = [{ gx: seed.gx, gz: seed.gz, score: seed.score }];
  visited.add(seed.gx | (seed.gz << 16));

  while (frontier.length > 0 && claimed.length < budget) {
    let bestIdx = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].score > frontier[bestIdx].score) bestIdx = i;
    }
    const cell = frontier[bestIdx];
    frontier[bestIdx] = frontier[frontier.length - 1];
    frontier.pop();

    grid.set(cell.gx, cell.gz, reservationType);
    claimed.push({ gx: cell.gx, gz: cell.gz });

    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cell.gx + dx, nz = cell.gz + dz;
      const key = nx | (nz << 16);
      if (visited.has(key)) continue;
      visited.add(key);
      if (!zoneSet.has(key)) continue;
      if (grid.get(nx, nz) !== RESERVATION.NONE) continue;

      const baseScore = scoreCell(nx, nz, placement, spatialLayers);
      // Directional bias: how aligned is this step with the axis?
      const alignment = Math.abs(dx * axis.x + dz * axis.z);
      const bias = alignment > 0.5 ? 2.0 : 0.5;
      frontier.push({ gx: nx, gz: nz, score: baseScore * bias });
    }
  }

  return claimed;
}
