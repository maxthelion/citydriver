/**
 * City-scale railway routing.
 * Re-routes inherited railways on the 5m grid so tracks follow terrain
 * contours, and applies gentle grading to flatten the corridor.
 */

import { railwayCostFunction } from '../core/railwayCost.js';
import { findPath, simplifyPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';

const CONE_HALF_ANGLE = Math.PI / 3; // 60 degrees
const ENTRY_MERGE_ANGLE = Math.PI / 6; // 30 degrees

/**
 * Extract entry points where railway polylines cross the city boundary.
 */
export function extractEntryPoints(railways, bounds, elevation, cellSize, originX, originZ) {
  const entries = [];
  const margin = cellSize ? 20 * cellSize : 100;

  for (const rail of railways) {
    const pts = rail.polyline;
    if (!pts || pts.length < 2) continue;

    const first = pts[0];
    const last = pts[pts.length - 1];

    for (const [pt, nextPt] of [[first, pts[1]], [last, pts[pts.length - 2]]]) {
      const nearEdge =
        Math.abs(pt.x - bounds.minX) < margin ||
        Math.abs(pt.x - bounds.maxX) < margin ||
        Math.abs(pt.z - bounds.minZ) < margin ||
        Math.abs(pt.z - bounds.maxZ) < margin;

      if (!nearEdge) continue;

      const dx = nextPt.x - pt.x, dz = nextPt.z - pt.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;

      let elev = 0;
      if (elevation && cellSize) {
        const gx = Math.round((pt.x - (originX || 0)) / cellSize);
        const gz = Math.round((pt.z - (originZ || 0)) / cellSize);
        if (gx >= 0 && gx < elevation.width && gz >= 0 && gz < elevation.height) {
          elev = elevation.get(gx, gz);
        }
      }

      entries.push({
        x: pt.x, z: pt.z,
        dirX: dx / len, dirZ: dz / len,
        elevation: elev,
      });
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
    const a = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const b = entries[j];
      const dot = a.dirX * b.dirX + a.dirZ * b.dirZ;
      const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
      if (angle < ENTRY_MERGE_ANGLE) {
        used.add(j);
      }
    }
    merged.push(a);
  }
  return merged;
}

/**
 * Score candidate cells for station placement.
 * Returns { gx, gz, x, z, elevation, angle } or null.
 */
export function scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cs, originX, originZ) {
  if (entries.length === 0) return null;

  const targetElev = entries.reduce((s, e) => s + e.elevation, 0) / entries.length;

  let bestScore = -1;
  let best = null;

  for (let gz = 5; gz < h - 5; gz++) {
    for (let gx = 5; gx < w - 5; gx++) {
      if (waterMask.get(gx, gz) > 0) continue;

      const wx = originX + gx * cs;
      const wz = originZ + gz * cs;

      // Must be within at least one entry's approach cone
      let inCone = false;
      for (const entry of entries) {
        const toX = wx - entry.x, toZ = wz - entry.z;
        const toLen = Math.sqrt(toX * toX + toZ * toZ) || 1;
        const dot = (toX / toLen) * entry.dirX + (toZ / toLen) * entry.dirZ;
        if (dot > Math.cos(CONE_HALF_ANGLE)) { inCone = true; break; }
      }
      if (!inCone) continue;

      const elev = elevation.get(gx, gz);
      const elevMatch = 1 / (1 + Math.abs(elev - targetElev) / 10);
      const lv = landValue.get(gx, gz);

      // Compute local slope
      const dex = (gx > 0 && gx < w - 1) ? elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz) : 0;
      const dez = (gz > 0 && gz < h - 1) ? elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1) : 0;
      const slopeVal = Math.sqrt(dex * dex + dez * dez) / (2 * cs);
      const flatness = 1 - Math.min(1, slopeVal / 0.1);

      const score = lv * elevMatch * flatness;
      if (score > bestScore) {
        bestScore = score;
        let bestEntry = entries[0];
        let bestEntryDist = Infinity;
        for (const e of entries) {
          const d = distance2D(wx, wz, e.x, e.z);
          if (d < bestEntryDist) { bestEntryDist = d; bestEntry = e; }
        }
        best = {
          gx, gz,
          x: wx, z: wz,
          elevation: elev,
          angle: Math.atan2(bestEntry.dirZ, bestEntry.dirX),
        };
      }
    }
  }
  return best;
}

/**
 * Main entry: re-route inherited railways at city resolution.
 */
export function routeCityRailways(railways, elevation, waterMask, landValue, bounds, cellSize, originX, originZ) {
  const w = elevation.width, h = elevation.height;

  const entries = extractEntryPoints(railways, bounds, elevation, cellSize, originX, originZ);
  if (entries.length === 0) return { paths: [], station: null, railGrid: null, entries: [] };

  const station = scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cellSize, originX, originZ);
  if (!station) return { paths: [], station: null, railGrid: null, entries };

  const railGrid = new Grid2D(w, h, { type: 'uint8', cellSize });

  const costFn = railwayCostFunction(elevation, {
    slopePenalty: 150,
    waterGrid: waterMask,
    waterPenalty: 500,
    edgeMargin: 0,
    edgePenalty: 0,
  });

  const railCost = (fromGx, fromGz, toGx, toGz) => {
    const base = costFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(base)) return base;
    if (railGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.05;
    }
    return base;
  };

  const paths = [];
  for (const entry of entries) {
    const entryGx = Math.max(0, Math.min(w - 1, Math.round((entry.x - originX) / cellSize)));
    const entryGz = Math.max(0, Math.min(h - 1, Math.round((entry.z - originZ) / cellSize)));

    const result = findPath(entryGx, entryGz, station.gx, station.gz, w, h, railCost);
    if (!result) continue;

    for (const p of result.path) railGrid.set(p.gx, p.gz, 1);

    const simplified = simplifyPath(result.path, 4);
    const polyline = simplified.map(p => ({
      x: originX + p.gx * cellSize,
      z: originZ + p.gz * cellSize,
    }));

    paths.push({ path: simplified, polyline });
  }

  return { paths, station, railGrid, entries };
}

/**
 * Apply gentle grading to the railway corridor.
 */
export function gradeRailwayCorridor(paths, entries, station, elevation, railGrid, cellSize) {
  const CORRIDOR_RADIUS = 2;
  const BLEND_RADIUS = 3;

  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi].path;
    if (path.length < 2) continue;

    const entryElev = entries[pi]?.elevation ?? elevation.get(path[0].gx, path[0].gz);
    const stationElev = station.elevation;

    const dists = [0];
    for (let i = 1; i < path.length; i++) {
      const dx = (path[i].gx - path[i-1].gx) * cellSize;
      const dz = (path[i].gz - path[i-1].gz) * cellSize;
      dists.push(dists[i-1] + Math.sqrt(dx*dx + dz*dz));
    }
    const totalDist = dists[dists.length - 1] || 1;

    for (let i = 0; i < path.length; i++) {
      const t = dists[i] / totalDist;
      const desiredElev = entryElev + (stationElev - entryElev) * t;

      for (let ddz = -CORRIDOR_RADIUS; ddz <= CORRIDOR_RADIUS; ddz++) {
        for (let ddx = -CORRIDOR_RADIUS; ddx <= CORRIDOR_RADIUS; ddx++) {
          const gx = path[i].gx + ddx, gz = path[i].gz + ddz;
          if (gx < 0 || gx >= elevation.width || gz < 0 || gz >= elevation.height) continue;
          elevation.set(gx, gz, desiredElev);
        }
      }

      for (let ddz = -BLEND_RADIUS; ddz <= BLEND_RADIUS; ddz++) {
        for (let ddx = -BLEND_RADIUS; ddx <= BLEND_RADIUS; ddx++) {
          const r = Math.sqrt(ddx*ddx + ddz*ddz);
          if (r <= CORRIDOR_RADIUS || r > BLEND_RADIUS) continue;
          const gx = path[i].gx + ddx, gz = path[i].gz + ddz;
          if (gx < 0 || gx >= elevation.width || gz < 0 || gz >= elevation.height) continue;
          const blendT = (r - CORRIDOR_RADIUS) / (BLEND_RADIUS - CORRIDOR_RADIUS);
          const natural = elevation.get(gx, gz);
          elevation.set(gx, gz, desiredElev + (natural - desiredElev) * blendT);
        }
      }
    }
  }
}
