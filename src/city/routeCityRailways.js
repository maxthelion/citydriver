/**
 * City-scale railway routing.
 *
 * Polyline is the single source of truth:
 * - A* finds raw path on city grid
 * - Simplified to polyline (few waypoints)
 * - FeatureMap._stampRailway stamps railwayGrid from the polyline
 * - gradeRailwayCorridor walks the polyline to grade terrain
 * - prepareCityScene converts polyline to localPts for rendering
 *
 * No raw path or separate grid stored. Grid always derived from polyline.
 */

import { railwayCostFunction } from '../core/railwayCost.js';
import { findPath, simplifyPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';

const CONE_HALF_ANGLE = Math.PI / 3;
const ENTRY_MERGE_ANGLE = Math.PI / 6;

/**
 * Extract entry points where railways cross the city boundary.
 * Entry elevation sampled from first inland point (not boundary edge).
 */
export function extractEntryPoints(railways, bounds, elevation, cellSize, originX, originZ, seaLevel) {
  const entries = [];
  const margin = cellSize ? 20 * cellSize : 100;
  const sl = seaLevel || 0;

  for (const rail of railways) {
    const pts = rail.polyline;
    if (!pts || pts.length < 2) continue;

    for (const [pt, nextPt, inwardPts] of [
      [pts[0], pts[1], pts],
      [pts[pts.length - 1], pts[pts.length - 2], [...pts].reverse()],
    ]) {
      const nearEdge =
        Math.abs(pt.x - bounds.minX) < margin ||
        Math.abs(pt.x - bounds.maxX) < margin ||
        Math.abs(pt.z - bounds.minZ) < margin ||
        Math.abs(pt.z - bounds.maxZ) < margin;
      if (!nearEdge) continue;

      const dx = nextPt.x - pt.x, dz = nextPt.z - pt.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;

      // Sample elevation from first inland point above sea level
      let elev = sl + 10;
      if (elevation && cellSize) {
        for (const p of inwardPts) {
          const gx = Math.round((p.x - (originX || 0)) / cellSize);
          const gz = Math.round((p.z - (originZ || 0)) / cellSize);
          if (gx >= 0 && gx < elevation.width && gz >= 0 && gz < elevation.height) {
            const e = elevation.get(gx, gz);
            if (e > sl + 2) { elev = e; break; }
          }
        }
      }

      entries.push({ x: pt.x, z: pt.z, dirX: dx / len, dirZ: dz / len, elevation: elev });
    }
  }
  return _mergeNearbyEntries(entries);
}

function _mergeNearbyEntries(entries) {
  if (entries.length <= 1) return entries;
  const used = new Set();
  const merged = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const dot = entries[i].dirX * entries[j].dirX + entries[i].dirZ * entries[j].dirZ;
      if (Math.acos(Math.min(1, Math.max(-1, dot))) < ENTRY_MERGE_ANGLE) used.add(j);
    }
    merged.push(entries[i]);
  }
  return merged;
}

/**
 * Score station location using elevation, land value, slope, approach cones.
 */
export function scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cs, originX, originZ) {
  if (entries.length === 0) return null;
  const targetElev = entries.reduce((s, e) => s + e.elevation, 0) / entries.length;

  let bestScore = -1, best = null;
  for (let gz = 5; gz < h - 5; gz++) {
    for (let gx = 5; gx < w - 5; gx++) {
      if (waterMask.get(gx, gz) > 0) continue;

      const wx = originX + gx * cs, wz = originZ + gz * cs;

      let inCone = false;
      for (const e of entries) {
        const toX = wx - e.x, toZ = wz - e.z;
        const toLen = Math.sqrt(toX * toX + toZ * toZ) || 1;
        if ((toX / toLen) * e.dirX + (toZ / toLen) * e.dirZ > Math.cos(CONE_HALF_ANGLE)) {
          inCone = true; break;
        }
      }
      if (!inCone) continue;

      const elev = elevation.get(gx, gz);
      const elevMatch = 1 / (1 + Math.abs(elev - targetElev) / 10);
      const lv = landValue.get(gx, gz);
      const dex = (gx > 0 && gx < w - 1) ? elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz) : 0;
      const dez = (gz > 0 && gz < h - 1) ? elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1) : 0;
      const flatness = 1 - Math.min(1, Math.sqrt(dex * dex + dez * dez) / (2 * cs) / 0.1);

      const score = lv * elevMatch * flatness;
      if (score > bestScore) {
        bestScore = score;
        let be = entries[0], bd = Infinity;
        for (const e of entries) {
          const d = distance2D(wx, wz, e.x, e.z);
          if (d < bd) { bd = d; be = e; }
        }
        best = { gx, gz, x: wx, z: wz, elevation: elev, angle: Math.atan2(be.dirZ, be.dirX) };
      }
    }
  }
  return best;
}

/**
 * Route railways at city scale. Returns polylines only — no grid.
 * Grid is stamped by FeatureMap._stampRailway when features are added.
 */
export function routeCityRailways(railways, elevation, waterMask, landValue, bounds, cellSize, originX, originZ, seaLevel) {
  const w = elevation.width, h = elevation.height;

  const entries = extractEntryPoints(railways, bounds, elevation, cellSize, originX, originZ, seaLevel);
  if (entries.length === 0) return { polylines: [], station: null, entries: [] };

  const station = scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cellSize, originX, originZ);
  if (!station) return { polylines: [], station: null, entries };

  const baseCostFn = railwayCostFunction(elevation, {
    slopePenalty: 150,
    // Don't pass waterGrid to base cost — we handle water explicitly below
    edgeMargin: 0,
    edgePenalty: 0,
  });

  // Temporary grid for track reuse discount between paths
  const Grid2D = Object.getPrototypeOf(elevation).constructor;
  const tempGrid = new Grid2D(w, h, { type: 'uint8', cellSize });

  const railCost = (fromGx, fromGz, toGx, toGz) => {
    // Water is impassable at city scale — no railway in water
    if (waterMask.get(toGx, toGz) > 0) return Infinity;

    const base = baseCostFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(base)) return base;
    if (tempGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.05;
    }
    return base;
  };

  const polylines = [];
  for (const entry of entries) {
    const egx = Math.max(0, Math.min(w - 1, Math.round((entry.x - originX) / cellSize)));
    const egz = Math.max(0, Math.min(h - 1, Math.round((entry.z - originZ) / cellSize)));

    const result = findPath(egx, egz, station.gx, station.gz, w, h, railCost);
    if (!result) continue;

    // Stamp temp grid so later paths share corridor
    for (const p of result.path) tempGrid.set(p.gx, p.gz, 1);

    // Simplify aggressively — this polyline IS the source of truth
    const simplified = simplifyPath(result.path, 40);
    const polyline = simplified.map(p => ({
      x: originX + p.gx * cellSize,
      z: originZ + p.gz * cellSize,
    }));

    polylines.push(polyline);
  }

  return { polylines, station, entries };
}

/**
 * Grade terrain along railway polylines.
 * Walks each polyline at cellSize intervals (same as _stampRailway),
 * interpolating elevation from entry to station.
 */
export function gradeRailwayCorridor(polylines, entries, station, elevation, cellSize, originX, originZ) {
  const BLEND_RADIUS = 3;
  const w = elevation.width, h = elevation.height;

  for (let pi = 0; pi < polylines.length; pi++) {
    const polyline = polylines[pi];
    if (polyline.length < 2) continue;

    const entryElev = entries[pi]?.elevation ?? station.elevation;
    const stationElev = station.elevation;

    // Total polyline length
    let totalLen = 0;
    for (let i = 1; i < polyline.length; i++) {
      totalLen += distance2D(polyline[i].x, polyline[i].z, polyline[i - 1].x, polyline[i - 1].z);
    }
    if (totalLen < 1) continue;

    // Walk polyline at cellSize intervals, grade terrain
    let cumLen = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x, az = polyline[i].z;
      const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
      const segLen = distance2D(ax, az, bx, bz);
      const steps = Math.max(1, Math.ceil(segLen / cellSize));

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const alongT = (cumLen + segLen * t) / totalLen;
        const desiredElev = entryElev + (stationElev - entryElev) * alongT;

        const cgx = Math.round((px - originX) / cellSize);
        const cgz = Math.round((pz - originZ) / cellSize);

        for (let ddz = -BLEND_RADIUS; ddz <= BLEND_RADIUS; ddz++) {
          for (let ddx = -BLEND_RADIUS; ddx <= BLEND_RADIUS; ddx++) {
            const gx = cgx + ddx, gz = cgz + ddz;
            if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
            const r = Math.sqrt(ddx * ddx + ddz * ddz);
            if (r > BLEND_RADIUS) continue;
            if (r <= 1) {
              elevation.set(gx, gz, desiredElev);
            } else {
              const blendT = (r - 1) / (BLEND_RADIUS - 1);
              const natural = elevation.get(gx, gz);
              elevation.set(gx, gz, desiredElev + (natural - desiredElev) * blendT);
            }
          }
        }
      }
      cumLen += segLen;
    }
  }
}
