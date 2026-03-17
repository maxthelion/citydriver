/**
 * A2b. River profile carving.
 *
 * After terrain generation, compute authoritative elevation profiles
 * along corridor polylines and carve terrain to match.
 * Replaces the indirect corridor depression that caused river fragmentation.
 */

import { valleyHalfWidth, valleyProfile } from '../core/riverGeometry.js';

const SCAN_WINDOW = 5; // ±5 cells along edge
const ACC_MAX = 10000;
const ACC_MIN = 1500;
const SUBDIVISION_DEPTH = 6;

/**
 * Find the best entry point near the planned entry on a map edge.
 * Scans ±SCAN_WINDOW cells along the edge, picks the lowest above sea level.
 *
 * @param {{ gx: number, gz: number }} planned - Planned entry point
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {string} edge - 'north'|'south'|'east'|'west'
 * @param {number} seaLevel
 * @returns {{ gx: number, gz: number }}
 */
export function findEntryPoint(planned, elevation, edge, seaLevel) {
  const { width, height } = elevation;
  let bestGx = planned.gx, bestGz = planned.gz;
  let bestElev = Infinity;

  const isHorizontal = edge === 'north' || edge === 'south';
  const fixedCoord = edge === 'north' ? 0 : edge === 'south' ? height - 1
    : edge === 'west' ? 0 : width - 1;

  const scanMin = Math.max(0, (isHorizontal ? planned.gx : planned.gz) - SCAN_WINDOW);
  const scanMax = Math.min(
    (isHorizontal ? width : height) - 1,
    (isHorizontal ? planned.gx : planned.gz) + SCAN_WINDOW,
  );

  for (let i = scanMin; i <= scanMax; i++) {
    const gx = isHorizontal ? i : fixedCoord;
    const gz = isHorizontal ? fixedCoord : i;
    const h = elevation.get(gx, gz);
    if (h > seaLevel && h < bestElev) {
      bestElev = h;
      bestGx = gx;
      bestGz = gz;
    }
  }

  // Fallback: if all edge cells are below sea level, return the planned point.
  // The orchestrator (carveRiverProfiles) handles this case by walking
  // the polyline until it finds an above-sea-level cell.
  if (bestElev === Infinity) {
    bestGx = planned.gx;
    bestGz = planned.gz;
  }

  return { gx: bestGx, gz: bestGz };
}

/**
 * Compute entry accumulation from start elevation.
 * Low entry = large river (more catchment beyond map), high entry = mountain stream.
 *
 * @param {number} startElev - Elevation at entry point
 * @param {number} maxElev - Maximum terrain elevation on the map
 * @param {number} seaLevel
 * @param {number} importance - Corridor importance (1.0, 0.6, 0.3)
 * @returns {number}
 */
export function computeEntryAccumulation(startElev, maxElev, seaLevel, importance) {
  const elevRange = maxElev - seaLevel || 1;
  const elevFraction = Math.max(0, Math.min(1, (startElev - seaLevel) / elevRange));
  const baseAcc = ACC_MAX + (ACC_MIN - ACC_MAX) * elevFraction;
  return baseAcc * importance;
}

/**
 * Build an elevation profile along a corridor polyline using binary subdivision.
 * Erosion resistance modulates where drops occur: hard rock holds elevation,
 * soft rock allows it to fall.
 *
 * @param {Array<{gx: number, gz: number}>} polyline - Corridor path in grid coords
 * @param {number} startElev - Elevation at entry
 * @param {number} endElev - Elevation at exit (typically sea level)
 * @param {import('../core/Grid2D.js').Grid2D} erosionResistance
 * @returns {number[]} Per-polyline-point elevation values
 */
export function buildElevationProfile(polyline, startElev, endElev, erosionResistance) {
  // Compute cumulative distance along polyline for interpolation
  const dist = [0];
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].gx - polyline[i - 1].gx;
    const dz = polyline[i].gz - polyline[i - 1].gz;
    dist.push(dist[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const totalDist = dist[dist.length - 1] || 1;

  // Binary subdivision: build control points as (normalizedDist, elevation)
  const controls = new Map();
  controls.set(0, startElev);
  controls.set(1, endElev);

  function subdivide(tStart, elevStart, tEnd, elevEnd, depth) {
    if (depth <= 0) return;

    const tMid = (tStart + tEnd) / 2;

    // Find the polyline point closest to tMid and sample resistance
    const targetDist = tMid * totalDist;
    let closest = 0;
    for (let i = 1; i < dist.length; i++) {
      if (Math.abs(dist[i] - targetDist) < Math.abs(dist[closest] - targetDist)) {
        closest = i;
      }
    }
    const resist = erosionResistance.get(polyline[closest].gx, polyline[closest].gz);

    // splitRatio: how much of the elevation drop happens above the midpoint
    // High resistance -> low split -> midpoint stays high -> drop is below (knickpoint)
    // Low resistance -> high split -> midpoint drops -> flat section below
    const splitRatio = 1.0 - resist;
    const elevMid = elevStart - (elevStart - elevEnd) * splitRatio;

    controls.set(tMid, elevMid);
    subdivide(tStart, elevStart, tMid, elevMid, depth - 1);
    subdivide(tMid, elevMid, tEnd, elevEnd, depth - 1);
  }

  subdivide(0, startElev, 1, endElev, SUBDIVISION_DEPTH);

  // Sort control points by t
  const sorted = [...controls.entries()].sort((a, b) => a[0] - b[0]);

  // Interpolate: for each polyline point, find elevation from control points
  const profile = new Array(polyline.length);
  for (let i = 0; i < polyline.length; i++) {
    const t = dist[i] / totalDist;

    // Find bracketing control points
    let lo = 0, hi = sorted.length - 1;
    for (let j = 0; j < sorted.length - 1; j++) {
      if (sorted[j][0] <= t && sorted[j + 1][0] >= t) {
        lo = j; hi = j + 1; break;
      }
    }

    const [tLo, eLo] = sorted[lo];
    const [tHi, eHi] = sorted[hi];
    const frac = tHi > tLo ? (t - tLo) / (tHi - tLo) : 0;
    profile[i] = eLo + (eHi - eLo) * frac;
  }

  return profile;
}

/**
 * Carve terrain along a corridor to match an elevation profile.
 * Uses min(existing, target) so terrain is never raised.
 * Valley widens proportional to accumulation using valleyHalfWidth/valleyProfile.
 * Recomputes slope for modified cells.
 *
 * @param {Array<{gx: number, gz: number}>} polyline
 * @param {number[]} profile - Per-point target elevation
 * @param {number} accumulation - Entry accumulation (controls valley width)
 * @param {import('../core/Grid2D.js').Grid2D} elevation - Modified in place
 * @param {import('../core/Grid2D.js').Grid2D} slope - Recomputed for modified cells
 */
export function carveCorridorTerrain(polyline, profile, accumulation, elevation, slope) {
  const { width, height, cellSize } = elevation;
  const halfW = valleyHalfWidth(accumulation);
  const radiusCells = Math.ceil(halfW / cellSize);

  // Track modified cells for slope recomputation
  const modified = new Set();

  for (let i = 0; i < polyline.length; i++) {
    const { gx: cgx, gz: cgz } = polyline[i];
    const targetElev = profile[i];

    for (let dz = -radiusCells; dz <= radiusCells; dz++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const gx = cgx + dx, gz = cgz + dz;
        if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;

        const dist = Math.sqrt(dx * dx + dz * dz) * cellSize;
        const nd = dist / Math.max(halfW, 1);
        const p = valleyProfile(nd);
        if (p <= 0) continue;

        // Blend toward target elevation based on profile strength
        const existing = elevation.get(gx, gz);
        const blendedTarget = existing * (1 - p) + targetElev * p;
        const newElev = Math.min(existing, blendedTarget);
        if (newElev < existing) {
          elevation.set(gx, gz, newElev);
          modified.add(gz * width + gx);
        }
      }
    }
  }

  // Recompute slope for modified cells
  for (const idx of modified) {
    const gx = idx % width;
    const gz = (idx / width) | 0;
    if (gx < 1 || gx >= width - 1 || gz < 1 || gz >= height - 1) continue;
    const dhdx = (elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz)) / (2 * cellSize);
    const dhdz = (elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1)) / (2 * cellSize);
    slope.set(gx, gz, Math.sqrt(dhdx * dhdx + dhdz * dhdz));
  }
}

/**
 * A2b: Carve river profiles along corridor polylines.
 * For each corridor: find entry point, compute accumulation, build profile, carve terrain.
 *
 * @param {Array} corridors - Corridor objects from planRiverCorridors
 * @param {import('../core/Grid2D.js').Grid2D} elevation - Modified in place
 * @param {import('../core/Grid2D.js').Grid2D} slope - Recomputed for modified cells
 * @param {import('../core/Grid2D.js').Grid2D} erosionResistance
 * @param {number} seaLevel
 * @returns {Array} Enriched corridors with entryAccumulation and profile
 */
export function carveRiverProfiles(corridors, elevation, slope, erosionResistance, seaLevel) {
  // Find max elevation for accumulation scaling
  let maxElev = -Infinity;
  for (let i = 0; i < elevation.width * elevation.height; i++) {
    if (elevation.data[i] > maxElev) maxElev = elevation.data[i];
  }

  for (const corridor of corridors) {
    // 1. Find best entry point (may shift polyline[0] along the edge)
    const plannedEntry = corridor.polyline[0];
    const entry = findEntryPoint(plannedEntry, elevation, corridor.entryEdge, seaLevel);
    corridor.polyline[0] = entry;

    // Fallback: if entry is still below sea level, walk inward along polyline
    if (elevation.get(entry.gx, entry.gz) <= seaLevel) {
      for (let j = 1; j < corridor.polyline.length; j++) {
        const pt = corridor.polyline[j];
        if (elevation.get(pt.gx, pt.gz) > seaLevel) {
          corridor.polyline[0] = pt;
          break;
        }
      }
    }

    // Trim exit end: walk backward from the end, stop at first above-sea-level cell
    let trimEnd = corridor.polyline.length;
    for (let j = corridor.polyline.length - 1; j >= 0; j--) {
      const pt = corridor.polyline[j];
      if (elevation.get(pt.gx, pt.gz) > seaLevel) {
        trimEnd = j + 1;
        break;
      }
    }
    if (trimEnd < corridor.polyline.length) {
      corridor.polyline = corridor.polyline.slice(0, trimEnd);
    }

    // Need at least 2 points to build a meaningful profile
    if (corridor.polyline.length < 2) continue;

    // 2. Compute accumulation from entry elevation
    const startElev = elevation.get(corridor.polyline[0].gx, corridor.polyline[0].gz);
    corridor.entryAccumulation = computeEntryAccumulation(
      startElev, maxElev, seaLevel, corridor.importance,
    );

    // 3. Build elevation profile
    corridor.profile = buildElevationProfile(
      corridor.polyline, startElev, seaLevel, erosionResistance,
    );

    // 4. Carve terrain
    carveCorridorTerrain(
      corridor.polyline, corridor.profile, corridor.entryAccumulation, elevation, slope,
    );

    // 5. Enforce profile on centreline — raise any cells that are below the profile
    //    (e.g. cells that were below sea level from terrain generation)
    for (let i = 0; i < corridor.polyline.length; i++) {
      const pt = corridor.polyline[i];
      const current = elevation.get(pt.gx, pt.gz);
      if (current < corridor.profile[i]) {
        elevation.set(pt.gx, pt.gz, corridor.profile[i]);
      }
    }
  }

  return corridors;
}
