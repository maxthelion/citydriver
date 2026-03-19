/**
 * Bridge placement system.
 *
 * Finds where skeleton roads cross rivers, scores and filters crossings,
 * then splices perpendicular bridge segments into the triggering road's polyline.
 *
 * Spec: specs/v5/observations.md "Bridge Placement System"
 */

const MIN_BRIDGE_SPACING = 25; // cells (~250m)
const MAX_BRIDGE_LENGTH = 10; // cells — reject bridges longer than this
const MAX_BANK_SEARCH = 50;   // cells

/**
 * Place bridges where skeleton roads cross rivers.
 * Call after skeleton roads and extra edges are built.
 *
 * Instead of creating separate bridge features, this splices the perpendicular
 * bridge banks directly into the triggering road's polyline.
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

    // Splice the bridge into the triggering road's polyline.
    // For roads crossing multiple rivers, later splices operate on the
    // already-mutated polyline — the entry/exit world coords from
    // findRoadWaterCrossings are still valid because _closestPointIndex
    // re-searches the current polyline.
    _spliceBridge(crossing.road, crossing.entryX, crossing.entryZ,
                  crossing.exitX, crossing.exitZ, banks.bankA, banks.bankB);

    // Stamp bridgeGrid for water cells between banks
    _stampBridgeGrid(map, banks.bankA, banks.bankB);

    acceptedMidpoints.push({ x: crossing.midX, z: crossing.midZ });
    placed++;
  }

  return { placed, skipped };
}

/**
 * Walk skeleton road polylines and find land→water→land transitions.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @returns {Array<{road: object, entryX: number, entryZ: number, exitX: number, exitZ: number,
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
            road,
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

// ============================================================
// Bridge splicing
// ============================================================

/**
 * Find the index of the polyline point closest to given world coordinates.
 *
 * @param {Array<{x: number, z: number}>} polyline
 * @param {number} wx - World X
 * @param {number} wz - World Z
 * @returns {number} index into polyline
 */
function _closestPointIndex(polyline, wx, wz) {
  let bestDist = Infinity;
  let bestIdx = 0;

  for (let i = 0; i < polyline.length; i++) {
    const dx = polyline[i].x - wx;
    const dz = polyline[i].z - wz;
    const dist = dx * dx + dz * dz;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Splice a bridge into a road's polyline in place.
 *
 * Replaces the water-crossing portion of the road with a two-point bridge
 * segment (nearBank → farBank) that is perpendicular to the river.
 *
 * @param {object} road - Road feature object (polyline modified in place)
 * @param {number} entryX - World X where road enters water
 * @param {number} entryZ - World Z where road enters water
 * @param {number} exitX - World X where road exits water
 * @param {number} exitZ - World Z where road exits water
 * @param {{ x: number, z: number }} bankA - One bank position
 * @param {{ x: number, z: number }} bankB - Other bank position
 */
function _spliceBridge(road, entryX, entryZ, exitX, exitZ, bankA, bankB) {
  const polyline = road.polyline;

  // Find polyline point indices closest to water entry and exit
  let entryIdx = _closestPointIndex(polyline, entryX, entryZ);
  let exitIdx = _closestPointIndex(polyline, exitX, exitZ);

  // Ensure entry index < exit index in the polyline
  if (entryIdx > exitIdx) {
    [entryIdx, exitIdx] = [exitIdx, entryIdx];
    // Also swap entry/exit coords to match
    [entryX, entryZ, exitX, exitZ] = [exitX, exitZ, entryX, entryZ];
  }

  // Guard: very narrow crossing where entry and exit resolve to same index
  if (entryIdx === exitIdx) {
    exitIdx = Math.min(entryIdx + 1, polyline.length - 1);
    if (entryIdx === exitIdx) return; // 2-point polyline, both resolve to same point
  }

  // Determine which bank is closer to the entry point
  const distAtoEntry = (bankA.x - entryX) ** 2 + (bankA.z - entryZ) ** 2;
  const distBtoEntry = (bankB.x - entryX) ** 2 + (bankB.z - entryZ) ** 2;

  let nearBank, farBank;
  if (distAtoEntry <= distBtoEntry) {
    nearBank = bankA;
    farBank = bankB;
  } else {
    nearBank = bankB;
    farBank = bankA;
  }

  // Build new polyline: [...before_entry, nearBank, farBank, ...after_exit]
  const before = polyline.slice(0, entryIdx + 1);
  const after = polyline.slice(exitIdx);

  const newPolyline = [...before, nearBank, farBank, ...after];
  if (typeof road._replacePolyline === 'function') {
    road._replacePolyline(newPolyline);
  } else {
    road.polyline = newPolyline;
  }
}

/**
 * Walk from bankA to bankB at cell steps, stamping bridgeGrid for water cells.
 */
function _stampBridgeGrid(map, bankA, bankB) {
  const cs = map.cellSize;
  const dx = bankB.x - bankA.x, dz = bankB.z - bankA.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) return;

  const steps = Math.ceil(len / cs);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const wx = bankA.x + dx * t;
    const wz = bankA.z + dz * t;
    const gx = Math.round((wx - map.originX) / cs);
    const gz = Math.round((wz - map.originZ) / cs);
    if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) continue;
    if (map.waterMask.get(gx, gz) > 0) {
      map.bridgeGrid.set(gx, gz, 1);
    }
  }
}
