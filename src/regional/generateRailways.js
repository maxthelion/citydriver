/**
 * Generate regional railway network.
 *
 * Strategy: build a tree, not a web.
 *  1. Each off-map city gets a line from the main city. A* cost gives a big
 *     bonus for passing through settlements, so lines naturally serve towns.
 *  2. Track reuse discount means later lines share earlier track, creating
 *     a natural branching tree.
 *  3. Tier-2 settlements get a short branch if not already on track.
 *  4. Water crossings are heavily penalised so railways stay on one side
 *     of rivers until they really need to cross. Actual crossings are
 *     recorded as bridges.
 *
 * Path simplification preserves settlement waypoints: RDP simplifies the
 * path, then any settlement near the raw path is inserted as a fixed
 * waypoint that smoothing cannot move.
 */

import { railwayCostFunction } from '../core/railwayCost.js';
import { findPath, simplifyPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';

const SETTLEMENT_NEAR_RADIUS = 5; // cells — how close to track to count as "served"

/**
 * @param {object} params - { width, height, cellSize }
 * @param {Array} settlements - [{ gx, gz, tier }]
 * @param {Array} offMapCities - [{ gx, gz, importance, role }]
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {import('../core/Grid2D.js').Grid2D|null} slope
 * @param {import('../core/Grid2D.js').Grid2D} waterMask
 * @returns {{ railways: Array, railGrid: Grid2D, bridges: Array }}
 */
export function generateRailways(params, settlements, offMapCities, elevation, slope, waterMask) {
  const { width, height, cellSize = 50 } = params;

  if (!settlements || settlements.length === 0 || !offMapCities || offMapCities.length === 0) {
    return { railways: [], railGrid: new Grid2D(width, height, { type: 'uint8' }), bridges: [] };
  }

  const railGrid = new Grid2D(width, height, { type: 'uint8' });

  // Build a settlement proximity grid — cells near settlements get a cost bonus
  const settlementBonus = _buildSettlementBonus(width, height, settlements);

  const baseCostFn = railwayCostFunction(elevation, {
    slopePenalty: 150,
    waterGrid: waterMask,
    waterPenalty: 500, // very high — stay on one side of rivers
    edgeMargin: 0,
    edgePenalty: 0,
  });

  // Cost function that rewards passing near settlements and strongly prefers existing track
  const railCost = (fromGx, fromGz, toGx, toGz) => {
    const base = baseCostFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(base)) return base;

    // Existing track: nearly free to reuse
    if (railGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.05;
    }

    // Settlement bonus: reduce cost near settlements to attract routes through them
    const bonus = settlementBonus.get(toGx, toGz);
    return base * (1 - bonus * 0.7);
  };

  const mainCity = settlements.reduce((a, b) => a.tier <= b.tier ? a : b);

  const railways = [];
  const bridges = [];

  // Sort off-map cities: capital first, then by importance
  const sortedOffMap = [...offMapCities].sort((a, b) => a.importance - b.importance);

  for (const omc of sortedOffMap) {
    const hierarchy = omc.importance === 1 ? 'trunk' : 'main';
    _addLine(railways, bridges, railGrid, mainCity, omc, hierarchy,
      width, height, cellSize, railCost, waterMask, settlements);
  }

  // Tier-2 settlements get a short branch if not already near track
  const tier2 = settlements.filter(s => s.tier === 2);
  for (const s of tier2) {
    if (_isNearTrack(railGrid, s.gx, s.gz, SETTLEMENT_NEAR_RADIUS)) continue;
    const junction = _findNearestTrack(railGrid, s.gx, s.gz, width, height);
    if (junction && distance2D(s.gx, s.gz, junction.gx, junction.gz) < width * 0.3) {
      _addLine(railways, bridges, railGrid, s, junction, 'branch',
        width, height, cellSize, railCost, waterMask, settlements);
    }
  }

  return { railways, railGrid, bridges };
}

function _addLine(railways, bridges, railGrid, from, to, hierarchy,
  width, height, cellSize, costFn, waterMask, settlements) {
  const result = findPath(from.gx, from.gz, to.gx, to.gz, width, height, costFn);
  if (!result) return;

  // Stamp track and detect bridges (water crossings)
  for (const p of result.path) {
    railGrid.set(p.gx, p.gz, 1);
    if (waterMask && waterMask.get(p.gx, p.gz) > 0) {
      bridges.push({ gx: p.gx, gz: p.gz });
    }
  }

  // Build waypoints: RDP-simplified path, with settlements pinned as waypoints
  const path = _buildWaypoints(result.path, settlements);

  // World-coordinate polyline for city inheritance (clipPolylineToBounds needs {x, z})
  const polyline = path.map(p => ({ x: p.gx * cellSize, z: p.gz * cellSize }));

  railways.push({
    path,
    polyline,
    hierarchy,
    from: { gx: from.gx, gz: from.gz },
    to: { gx: to.gx, gz: to.gz },
  });
}

/**
 * Build a simplified path that preserves settlement positions as waypoints.
 *
 * 1. Find settlements that are near the raw path
 * 2. RDP-simplify the path
 * 3. Insert settlement positions into the simplified path at the right location
 */
function _buildWaypoints(rawPath, settlements) {
  // Find settlements near the raw path, and where along the path they are
  const servedSettlements = [];
  for (const s of settlements) {
    if (s.tier > 3) continue;
    let bestDist = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < rawPath.length; i++) {
      const d = Math.abs(rawPath[i].gx - s.gx) + Math.abs(rawPath[i].gz - s.gz);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestDist <= SETTLEMENT_NEAR_RADIUS) {
      servedSettlements.push({ gx: s.gx, gz: s.gz, pathIdx: bestIdx, tier: s.tier });
    }
  }

  // Sort by position along path
  servedSettlements.sort((a, b) => a.pathIdx - b.pathIdx);

  // RDP simplify
  const simplified = simplifyPath(rawPath, 8);

  if (servedSettlements.length === 0) return simplified;

  // Build final path: start with simplified points, insert settlement waypoints
  // at the correct position. For each settlement, find where it fits between
  // simplified points and insert it.
  const result = [];
  let settIdx = 0;

  for (let i = 0; i < simplified.length; i++) {
    const sp = simplified[i];
    const nextSp = simplified[i + 1];

    result.push(sp);

    if (!nextSp || settIdx >= servedSettlements.length) continue;

    // Insert any settlements that fall between this simplified point and the next
    while (settIdx < servedSettlements.length) {
      const sett = servedSettlements[settIdx];

      // Is this settlement between sp and nextSp along the raw path?
      // Check by seeing if it's closer to the segment sp→nextSp than to either endpoint
      const dToSp = distance2D(sett.gx, sett.gz, sp.gx, sp.gz);
      const dToNext = distance2D(sett.gx, sett.gz, nextSp.gx, nextSp.gz);
      const segLen = distance2D(sp.gx, sp.gz, nextSp.gx, nextSp.gz);

      if (dToSp < 2 || dToNext < 2) {
        // Too close to an existing point, skip
        settIdx++;
        continue;
      }

      if (dToSp < segLen && dToNext < segLen) {
        // Settlement is between these two points — insert it
        result.push({ gx: sett.gx, gz: sett.gz });
        settIdx++;
      } else {
        break; // this settlement belongs to a later segment
      }
    }
  }

  return result;
}

/**
 * Build a grid where cells near settlements have a value 0-1 indicating
 * how attractive they are for routing through.
 */
function _buildSettlementBonus(width, height, settlements) {
  const grid = new Grid2D(width, height);
  const RADIUS = 8;
  for (const s of settlements) {
    if (s.tier > 3) continue;
    const weight = s.tier === 1 ? 1.0 : s.tier === 2 ? 0.8 : 0.5;
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const gx = s.gx + dx, gz = s.gz + dz;
        if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > RADIUS) continue;
        const falloff = 1 - d / RADIUS;
        const val = weight * falloff;
        if (val > grid.get(gx, gz)) grid.set(gx, gz, val);
      }
    }
  }
  return grid;
}

/**
 * Find the nearest cell that has track on it via BFS.
 */
function _findNearestTrack(railGrid, gx, gz, width, height) {
  const MAX_DIST = 80;
  const queue = [{ gx, gz, d: 0 }];
  const visited = new Set();
  visited.add(`${gx},${gz}`);

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (railGrid.get(cur.gx, cur.gz) > 0) {
      return { gx: cur.gx, gz: cur.gz };
    }
    if (cur.d >= MAX_DIST) continue;
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cur.gx + dx, nz = cur.gz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      const key = `${nx},${nz}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ gx: nx, gz: nz, d: cur.d + 1 });
    }
  }
  return null;
}

function _isNearTrack(railGrid, gx, gz, radius) {
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = gx + dx, nz = gz + dz;
      if (nx >= 0 && nx < railGrid.width && nz >= 0 && nz < railGrid.height) {
        if (railGrid.get(nx, nz) > 0) return true;
      }
    }
  }
  return false;
}
