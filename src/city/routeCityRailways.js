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
  const cx = w / 2, cz = h / 2;
  const maxDist = Math.sqrt(cx * cx + cz * cz);

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

      // Strongly prefer locations near the city centre
      const distFromCentre = Math.sqrt((gx - cx) ** 2 + (gz - cz) ** 2);
      const centrality = 1 - distFromCentre / maxDist;

      const score = lv * elevMatch * flatness * centrality * centrality;
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
    // Water is very expensive (bridge required) but not impassable —
    // river cities need railways to cross via bridges
    if (waterMask.get(toGx, toGz) > 0) return baseCostFn(fromGx, fromGz, toGx, toGz) + 500;

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
    let egx = Math.max(0, Math.min(w - 1, Math.round((entry.x - originX) / cellSize)));
    let egz = Math.max(0, Math.min(h - 1, Math.round((entry.z - originZ) / cellSize)));

    // Nudge entry to nearest dry land if on water or at grid edge
    if (waterMask.get(egx, egz) > 0 || egx <= 0 || egz <= 0 || egx >= w - 1 || egz >= h - 1) {
      let bestD = Infinity;
      const searchR = 30;
      for (let dz = -searchR; dz <= searchR; dz++) {
        for (let dx = -searchR; dx <= searchR; dx++) {
          const nx = egx + dx, nz = egz + dz;
          if (nx < 1 || nx >= w - 1 || nz < 1 || nz >= h - 1) continue;
          if (waterMask.get(nx, nz) > 0) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; egx = nx; egz = nz; }
        }
      }
      if (bestD === Infinity) continue; // no dry land found, skip this entry
    }

    const result = findPath(egx, egz, station.gx, station.gz, w, h, railCost);
    if (!result) continue;

    // Stamp temp grid so later paths share corridor
    for (const p of result.path) tempGrid.set(p.gx, p.gz, 1);

    // Simplify the A* path with water-aware check: never create a segment
    // that crosses water. Simplify aggressively first, then verify each segment.
    const simplified = _waterAwareSimplify(result.path, waterMask, w, h);
    const polyline = simplified.map(p => ({
      x: originX + p.gx * cellSize,
      z: originZ + p.gz * cellSize,
    }));

    polylines.push(polyline);
  }

  return { polylines, station, entries };
}

/**
 * Simplify a grid path while guaranteeing no segment crosses water.
 * Uses RDP but rejects any simplification that would create a water crossing.
 */
function _waterAwareSimplify(path, waterMask, w, h) {
  if (path.length <= 2) return path.slice();
  return _wrdp(path, 0, path.length - 1, 8, waterMask, w, h);
}

function _wrdp(points, start, end, epsilon, waterMask, w, h) {
  if (end - start < 1) return [points[start]];

  // Check if the straight line from start to end crosses water
  const a = points[start], b = points[end];
  if (_segmentCrossesWater(a.gx, a.gz, b.gx, b.gz, waterMask, w, h)) {
    // Can't simplify this range to a straight line — must keep a midpoint
    const mid = Math.floor((start + end) / 2);
    if (mid === start) return [points[start], points[end]];
    const left = _wrdp(points, start, mid, epsilon, waterMask, w, h);
    const right = _wrdp(points, mid, end, epsilon, waterMask, w, h);
    return left.concat(right.slice(1));
  }

  // Standard RDP: find point farthest from line
  let maxDist = 0, maxIdx = start;
  for (let i = start + 1; i < end; i++) {
    const d = _perpDist(points[i].gx, points[i].gz, a.gx, a.gz, b.gx, b.gz);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left = _wrdp(points, start, maxIdx, epsilon, waterMask, w, h);
    const right = _wrdp(points, maxIdx, end, epsilon, waterMask, w, h);
    return left.concat(right.slice(1));
  }

  // Safe to simplify — the straight line doesn't cross water
  return [a, b];
}

function _segmentCrossesWater(gx1, gz1, gx2, gz2, waterMask, w, h) {
  // Check every cell along the segment (Bresenham-style with fine sampling)
  const dx = gx2 - gx1, dz = gz2 - gz1;
  const steps = Math.max(1, Math.max(Math.abs(dx), Math.abs(dz)) * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const gx = Math.round(gx1 + dx * t);
    const gz = Math.round(gz1 + dz * t);
    if (gx >= 0 && gx < w && gz >= 0 && gz < h && waterMask.get(gx, gz) > 0) return true;
  }
  return false;
}

function _perpDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (pz - az) ** 2);
  return Math.abs((px - ax) * dz - (pz - az) * dx) / Math.sqrt(lenSq);
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
