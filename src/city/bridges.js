/**
 * Bridge placement system.
 *
 * Finds where skeleton roads cross rivers, scores and filters crossings,
 * then places perpendicular bridge features with landing spur connections.
 *
 * Spec: specs/v5/observations.md "Bridge Placement System"
 */

import { findPath } from '../core/pathfinding.js';
import { addRoadToGraph } from './skeleton.js';

const MIN_BRIDGE_SPACING = 25; // cells (~250m)
const MAX_BRIDGE_LENGTH = 10; // cells — reject bridges longer than this
const MAX_BANK_SEARCH = 50;   // cells
const LANDING_THRESHOLD = 3;  // cells — connect spur if bank > this from road
const LANDING_SEARCH_RADIUS = 15; // cells

/**
 * Place bridges where skeleton roads cross rivers.
 * Call after skeleton roads and extra edges are built.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @returns {{ placed: number, skipped: number }}
 */
export function placeBridges(map) {
  const crossings = findRoadWaterCrossings(map);
  if (crossings.length === 0) return { placed: 0, skipped: 0 };

  // Score and sort descending
  for (const c of crossings) {
    c.score = c.importance / Math.max(c.widthCells, 1);
  }
  crossings.sort((a, b) => b.score - a.score);

  // Global accepted bridge midpoints for spacing enforcement.
  // Uses global (not per-river) because duplicate river imports can give
  // the same physical river different indices, bypassing per-river checks.
  const acceptedMidpoints = []; // [{x, z}]
  const spacingWorld = MIN_BRIDGE_SPACING * map.cellSize;
  const maxLengthWorld = MAX_BRIDGE_LENGTH * map.cellSize;

  let placed = 0;
  let skipped = 0;

  for (const crossing of crossings) {
    const river = nearestRiverSegment(map, crossing.midX, crossing.midZ);
    if (!river || river.dist > crossing.widthCells * map.cellSize * 2) {
      skipped++;
      continue;
    }

    // Enforce minimum spacing globally
    let tooClose = false;
    for (const b of acceptedMidpoints) {
      const dx = crossing.midX - b.x;
      const dz = crossing.midZ - b.z;
      if (Math.sqrt(dx * dx + dz * dz) < spacingWorld) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) {
      skipped++;
      continue;
    }

    // Compute perpendicular to river tangent
    const perpX = -river.tangentZ;
    const perpZ = river.tangentX;

    // Find bank positions
    const banks = findBridgeBanks(map, crossing.midX, crossing.midZ, perpX, perpZ);
    if (!banks) {
      skipped++;
      continue;
    }

    // Reject bridges that are too long (spanning floodplains, not rivers)
    const bdx = banks.bankB.x - banks.bankA.x;
    const bdz = banks.bankB.z - banks.bankA.z;
    const bridgeLen = Math.sqrt(bdx * bdx + bdz * bdz);
    if (bridgeLen > maxLengthWorld) {
      skipped++;
      continue;
    }

    // Add bridge feature
    const importance = crossing.importance;
    const hierarchy = crossing.hierarchy;
    const width = 6 + importance * 10;

    map.addFeature('road', {
      polyline: [banks.bankA, banks.bankB],
      width,
      hierarchy,
      importance,
      source: 'bridge',
      bridge: true,
    });

    addRoadToGraph(map, [banks.bankA, banks.bankB], width, hierarchy);

    // Connect landing points to road network if needed
    connectLandingToRoads(map, banks.bankA, hierarchy);
    connectLandingToRoads(map, banks.bankB, hierarchy);

    acceptedMidpoints.push({ x: crossing.midX, z: crossing.midZ });
    placed++;
  }

  return { placed, skipped };
}

/**
 * Walk skeleton road polylines and find land→water→land transitions.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @returns {Array<{entryX: number, entryZ: number, exitX: number, exitZ: number,
 *   midX: number, midZ: number, widthCells: number, importance: number, hierarchy: string}>}
 */
export function findRoadWaterCrossings(map) {
  const crossings = [];
  const skeletonRoads = map.roads.filter(r => r.source === 'skeleton');

  for (const road of skeletonRoads) {
    const polyline = road.polyline;
    if (!polyline || polyline.length < 2) continue;

    const importance = road.importance || 0.45;
    const hierarchy = road.hierarchy || 'local';

    // Walk polyline at half-cell steps
    let inWater = false;
    let entryX = 0, entryZ = 0;
    let waterCells = 0;

    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x;
      const az = polyline[i].z;
      const bx = polyline[i + 1].x;
      const bz = polyline[i + 1].z;

      const dx = bx - ax;
      const dz = bz - az;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      const stepSize = map.cellSize * 0.5;
      const steps = Math.ceil(segLen / stepSize);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t;
        const pz = az + dz * t;

        const gx = Math.round((px - map.originX) / map.cellSize);
        const gz = Math.round((pz - map.originZ) / map.cellSize);

        if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) continue;

        const isWater = map.waterMask.get(gx, gz) > 0;

        if (isWater && !inWater) {
          // Land → water transition
          inWater = true;
          entryX = px;
          entryZ = pz;
          waterCells = 1;
        } else if (isWater && inWater) {
          waterCells++;
        } else if (!isWater && inWater) {
          // Water → land transition — record crossing
          inWater = false;
          const exitX = px;
          const exitZ = pz;
          crossings.push({
            entryX, entryZ,
            exitX, exitZ,
            midX: (entryX + exitX) / 2,
            midZ: (entryZ + exitZ) / 2,
            widthCells: waterCells,
            importance,
            hierarchy,
          });
        }
      }
    }
  }

  return crossings;
}

/**
 * Find the nearest river polyline segment to a world point.
 * Returns river index, tangent direction, interpolated width, and distance.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @param {number} wx - World X
 * @param {number} wz - World Z
 * @returns {{ riverIndex: number, tangentX: number, tangentZ: number, width: number, dist: number } | null}
 */
export function nearestRiverSegment(map, wx, wz) {
  let bestDist = Infinity;
  let bestResult = null;

  for (let ri = 0; ri < map.rivers.length; ri++) {
    const river = map.rivers[ri];
    const polyline = river.polyline;
    if (!polyline || polyline.length < 2) continue;

    for (let i = 0; i < polyline.length - 1; i++) {
      const a = polyline[i];
      const b = polyline[i + 1];

      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 0.01) continue;

      // Project point onto segment
      let t = ((wx - a.x) * dx + (wz - a.z) * dz) / lenSq;
      t = Math.max(0, Math.min(1, t));

      const projX = a.x + t * dx;
      const projZ = a.z + t * dz;
      const dist = Math.sqrt((wx - projX) ** 2 + (wz - projZ) ** 2);

      if (dist < bestDist) {
        bestDist = dist;
        const len = Math.sqrt(lenSq);
        const tangentX = dx / len;
        const tangentZ = dz / len;

        // Interpolate width
        const aWidth = a.width || 5;
        const bWidth = b.width || 5;
        const width = aWidth * (1 - t) + bWidth * t;

        bestResult = { riverIndex: ri, tangentX, tangentZ, width, dist };
      }
    }
  }

  return bestResult;
}

/**
 * Walk perpendicular to river from midpoint, find bank positions (first land cell + 1 cell onto land).
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @param {number} midX - World X of crossing midpoint
 * @param {number} midZ - World Z of crossing midpoint
 * @param {number} perpX - Perpendicular direction X (normalized)
 * @param {number} perpZ - Perpendicular direction Z (normalized)
 * @returns {{ bankA: {x: number, z: number}, bankB: {x: number, z: number} } | null}
 */
export function findBridgeBanks(map, midX, midZ, perpX, perpZ) {
  const cs = map.cellSize;

  const bankA = _findBank(map, midX, midZ, perpX, perpZ, cs);
  const bankB = _findBank(map, midX, midZ, -perpX, -perpZ, cs);

  if (!bankA || !bankB) return null;

  // Quantize to half-cell grid to avoid sub-pixel noise
  const half = cs * 0.5;
  bankA.x = Math.round(bankA.x / half) * half;
  bankA.z = Math.round(bankA.z / half) * half;
  bankB.x = Math.round(bankB.x / half) * half;
  bankB.z = Math.round(bankB.z / half) * half;

  return { bankA, bankB };
}

/**
 * Walk in one direction from midpoint until we exit water, then go 1 cell further onto land.
 */
function _findBank(map, startX, startZ, dirX, dirZ, cellSize) {
  let wasWater = false;

  for (let step = 0; step <= MAX_BANK_SEARCH; step++) {
    const wx = startX + dirX * step * cellSize;
    const wz = startZ + dirZ * step * cellSize;

    const gx = Math.round((wx - map.originX) / cellSize);
    const gz = Math.round((wz - map.originZ) / cellSize);

    if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) return null;

    const isWater = map.waterMask.get(gx, gz) > 0;

    if (isWater) {
      wasWater = true;
    } else if (wasWater) {
      // First land cell after water — go 1 more cell onto land
      const bankX = wx + dirX * cellSize;
      const bankZ = wz + dirZ * cellSize;
      return { x: bankX, z: bankZ };
    }
  }

  return null; // Didn't find a bank within search limit
}

/**
 * If a bridge bank landing is far from existing roads, pathfind a short spur to connect it.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @param {{ x: number, z: number }} landing - World-coord bank position
 * @param {string} hierarchy - Road hierarchy for the spur
 */
export function connectLandingToRoads(map, landing, hierarchy) {
  const cs = map.cellSize;
  const lgx = Math.round((landing.x - map.originX) / cs);
  const lgz = Math.round((landing.z - map.originZ) / cs);

  if (lgx < 0 || lgx >= map.width || lgz < 0 || lgz >= map.height) return;

  // Check if already near a road cell
  if (map.roadGrid.get(lgx, lgz) > 0) return;

  let nearRoad = false;
  for (let dz = -LANDING_THRESHOLD; dz <= LANDING_THRESHOLD; dz++) {
    for (let dx = -LANDING_THRESHOLD; dx <= LANDING_THRESHOLD; dx++) {
      const gx = lgx + dx, gz = lgz + dz;
      if (gx >= 0 && gx < map.width && gz >= 0 && gz < map.height) {
        if (map.roadGrid.get(gx, gz) > 0) { nearRoad = true; break; }
      }
    }
    if (nearRoad) break;
  }
  if (nearRoad) return;

  // Find nearest road cell within search radius
  let bestDist = Infinity, bestGx = -1, bestGz = -1;
  for (let dz = -LANDING_SEARCH_RADIUS; dz <= LANDING_SEARCH_RADIUS; dz++) {
    for (let dx = -LANDING_SEARCH_RADIUS; dx <= LANDING_SEARCH_RADIUS; dx++) {
      const gx = lgx + dx, gz = lgz + dz;
      if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) continue;
      if (map.roadGrid.get(gx, gz) === 0) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestDist) { bestDist = d; bestGx = gx; bestGz = gz; }
    }
  }

  if (bestGx < 0) return;

  const costFn = map.createPathCost('bridge');
  const result = findPath(lgx, lgz, bestGx, bestGz, map.width, map.height, costFn);
  if (!result || result.path.length < 2) return;

  // Stamp road grid
  for (const p of result.path) {
    map.roadGrid.set(p.gx, p.gz, 1);
  }

  // Simplify grid path → clean world-coord polyline
  const polyline = _gridPathToPolyline(result.path, cs, map.originX, map.originZ);
  if (polyline.length < 2) return;

  const importance = hierarchy === 'arterial' ? 0.9 :
                     hierarchy === 'collector' ? 0.6 : 0.45;
  const width = 6 + importance * 10;

  map.addFeature('road', {
    polyline,
    width,
    hierarchy,
    importance,
    source: 'bridge',
  });

  addRoadToGraph(map, polyline, width, hierarchy);
}

// ============================================================
// Polyline simplification
// ============================================================

/**
 * Convert A* grid path to a simplified world-coord polyline.
 * Quantizes to half-cell, deduplicates, then RDP-simplifies.
 */
function _gridPathToPolyline(path, cellSize, originX, originZ) {
  if (path.length < 2) return [];

  const half = cellSize * 0.5;

  // Quantize to half-cell grid and deduplicate
  const deduped = [];
  let prevQx = NaN, prevQz = NaN;
  for (const p of path) {
    const wx = originX + p.gx * cellSize;
    const wz = originZ + p.gz * cellSize;
    const qx = Math.round(wx / half) * half;
    const qz = Math.round(wz / half) * half;
    if (qx === prevQx && qz === prevQz) continue;
    deduped.push({ x: qx, z: qz });
    prevQx = qx;
    prevQz = qz;
  }

  if (deduped.length < 2) return deduped;

  // RDP simplification (epsilon = 1 cell)
  return _simplifyRDP(deduped, cellSize);
}

/** Ramer-Douglas-Peucker on world-coord polyline. */
function _simplifyRDP(pts, epsilon) {
  if (pts.length <= 2) return pts;

  const first = pts[0], last = pts[pts.length - 1];
  let maxDist = 0, maxIdx = 0;

  for (let i = 1; i < pts.length - 1; i++) {
    const d = _ptSegDistSq(pts[i].x, pts[i].z, first.x, first.z, last.x, last.z);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (Math.sqrt(maxDist) > epsilon) {
    const left = _simplifyRDP(pts.slice(0, maxIdx + 1), epsilon);
    const right = _simplifyRDP(pts.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function _ptSegDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return (px - ax - t * dx) ** 2 + (pz - az - t * dz) ** 2;
}
