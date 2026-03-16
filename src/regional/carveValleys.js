/**
 * Valley carving and coastal floodplain flattening.
 *
 * Produces Grid2D layers that are applied to elevation compositionally
 * (consistent with city pipeline's layer-bag approach).
 *
 * valleyDepthField:  how much to lower elevation at each cell (meters)
 * floodplainField:   blend strength toward floodplain target (0-1)
 */

import { Grid2D } from '../core/Grid2D.js';
import {
  riverHalfWidth, valleyHalfWidth, valleyDepth, valleyProfile, gorgeProfile,
} from '../core/riverGeometry.js';

// Gorge detection: terrain rises this much above river on both sides
const GORGE_RISE_THRESHOLD = 10; // meters
const GORGE_CHECK_DIST = 4;     // cells (~200m at 50m resolution)

// Coastal floodplain range
const FLOODPLAIN_COAST_RANGE_M = 500;

// River mouth depth below sea level
const RIVER_MOUTH_DEPTH_MIN = 1;  // meters below sea level for small rivers
const RIVER_MOUTH_DEPTH_MAX = 5;  // meters below sea level for large rivers

// Maximum depth carving can reach below sea level (negative = below)
const SEA_FLOOR_CLAMP = -50;

/**
 * Compute a valley depth field from river vector paths.
 * Walk each river path, compute valley profile, write depth values.
 *
 * @param {Array} riverPaths - Vector paths with .points[{x, z, accumulation}]
 * @param {Grid2D} elevation - Current terrain elevation
 * @param {Grid2D} erosionResistance - Rock hardness (0-1)
 * @param {number} cellSize
 * @returns {Grid2D} valleyDepthField — meters to subtract from elevation
 */
export function computeValleyDepthField(riverPaths, elevation, erosionResistance, cellSize) {
  const { width, height } = elevation;
  const depthField = new Grid2D(width, height, { cellSize });

  walkPaths(riverPaths, (point, nextPoint) => {
    const acc = point.accumulation || 1;
    const halfW = valleyHalfWidth(acc);
    const depth = valleyDepth(acc);
    const resist = erosionResistance.get(
      Math.round(point.x / cellSize),
      Math.round(point.z / cellSize),
    );

    // Geology modulation
    let widthMod = 1.0, depthMod = 1.0;
    if (resist > 0.6) {
      widthMod = 0.5; depthMod = 1.3; // hard rock: narrow gorge
    } else if (resist < 0.3) {
      widthMod = 1.5; depthMod = 0.7; // soft rock: broad valley
    }

    const effectiveHalfW = halfW * widthMod;
    const effectiveDepth = depth * depthMod;
    const cellRadius = Math.ceil(effectiveHalfW / cellSize);
    const cgx = Math.round(point.x / cellSize);
    const cgz = Math.round(point.z / cellSize);

    // Check for gorge: terrain rises steeply on both sides
    const isGorge = detectGorge(elevation, cgx, cgz, point.x, point.z, nextPoint, cellSize);
    const profile = isGorge ? gorgeProfile : valleyProfile;
    const gorgeWidthMod = isGorge ? 0.3 : 1.0;
    const gorgeDepthMod = isGorge ? 2.0 : 1.0;

    const finalHalfW = effectiveHalfW * gorgeWidthMod;
    const finalDepth = effectiveDepth * gorgeDepthMod;
    const finalRadius = Math.ceil(finalHalfW / cellSize);

    for (let dz = -finalRadius; dz <= finalRadius; dz++) {
      for (let dx = -finalRadius; dx <= finalRadius; dx++) {
        const gx = cgx + dx, gz = cgz + dz;
        if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;

        const dist = Math.sqrt(dx * dx + dz * dz) * cellSize;
        const nd = dist / Math.max(finalHalfW, 1);
        const p = profile(nd);
        if (p <= 0) continue;

        const carveAmount = p * finalDepth;
        // Take max carve at each cell (overlapping valleys)
        if (carveAmount > depthField.get(gx, gz)) {
          depthField.set(gx, gz, carveAmount);
        }
      }
    }
  });

  return depthField;
}

/**
 * Compute a floodplain blending field for coastal river sections.
 * Near the coast, valleys widen dramatically and terrain flattens.
 *
 * @param {Array} riverPaths
 * @param {Grid2D} elevation
 * @param {Grid2D} waterMask
 * @param {Grid2D} erosionResistance
 * @param {number} cellSize
 * @param {number} seaLevel
 * @returns {{ floodplainField: Grid2D, floodplainTarget: Grid2D }}
 */
export function computeFloodplainField(riverPaths, elevation, waterMask, erosionResistance, cellSize, seaLevel) {
  const { width, height } = elevation;
  const field = new Grid2D(width, height, { cellSize });
  const target = new Grid2D(width, height, { cellSize });

  // Compute coast distance (BFS from water mask boundary cells)
  const coastDist = computeCoastDistance(waterMask, width, height, cellSize);
  const rangeInCells = FLOODPLAIN_COAST_RANGE_M / cellSize;

  walkPaths(riverPaths, (point) => {
    const cgx = Math.round(point.x / cellSize);
    const cgz = Math.round(point.z / cellSize);
    if (cgx < 0 || cgx >= width || cgz < 0 || cgz >= height) return;

    const cd = coastDist.get(cgx, cgz);
    if (cd > rangeInCells) return; // not near coast

    const coastProximity = 1 - cd / rangeInCells; // 0 = far, 1 = at coast
    const acc = point.accumulation || 1;
    const halfW = valleyHalfWidth(acc);

    const resist = erosionResistance.get(cgx, cgz);
    const resistMod = resist > 0.6 ? 0.5 : resist < 0.3 ? 1.5 : 1.0;

    const floodRadius = halfW * (1 + 2 * coastProximity) * resistMod;
    const floodRadiusCells = Math.ceil(floodRadius / cellSize);

    // River elevation (approximately at this point)
    const riverElev = elevation.get(cgx, cgz);
    // Near coast, river mouth should descend below sea level
    // Scale depth by accumulation: small rivers -1m, large rivers -5m
    const accNorm = Math.min(1, Math.max(0, (acc - 500) / 9500)); // 500..10000
    const mouthDepth = RIVER_MOUTH_DEPTH_MIN + accNorm * (RIVER_MOUTH_DEPTH_MAX - RIVER_MOUTH_DEPTH_MIN);
    const coastTarget = seaLevel - mouthDepth * coastProximity;
    const targetElev = Math.min(Math.max(seaLevel, riverElev), coastTarget);

    for (let dz = -floodRadiusCells; dz <= floodRadiusCells; dz++) {
      for (let dx = -floodRadiusCells; dx <= floodRadiusCells; dx++) {
        const gx = cgx + dx, gz = cgz + dz;
        if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;

        const dist = Math.sqrt(dx * dx + dz * dz) * cellSize;
        if (dist > floodRadius) continue;

        const strength = (1 - dist / floodRadius) * coastProximity * 0.8;
        const currentElev = elevation.get(gx, gz);

        // Only flatten terrain that's above target (don't raise valleys or plunged seabed)
        if (currentElev > targetElev && currentElev <= targetElev + 15) {
          if (strength > field.get(gx, gz)) {
            field.set(gx, gz, strength);
            target.set(gx, gz, targetElev);
          }
        }
      }
    }
  });

  return { floodplainField: field, floodplainTarget: target };
}

/**
 * Apply valley and floodplain fields to elevation.
 * elevation -= valleyDepthField
 * elevation = lerp(elevation, floodplainTarget, floodplainField)
 */
export function applyTerrainFields(elevation, valleyDepthField, floodplainField, floodplainTarget, seaLevel) {
  const { width, height } = elevation;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      let h = elevation.get(gx, gz);

      // Valley carving
      const carve = valleyDepthField.get(gx, gz);
      if (carve > 0) {
        h -= carve;
      }

      // Floodplain flattening
      const blend = floodplainField.get(gx, gz);
      if (blend > 0) {
        const tgt = floodplainTarget.get(gx, gz);
        h = h * (1 - blend) + tgt * blend;
      }

      // Never carve below sea floor
      h = Math.max(h, seaLevel + SEA_FLOOR_CLAMP);

      elevation.set(gx, gz, h);
    }
  }
}

// --- Helpers ---

/**
 * Walk all river path points, calling fn(point, nextPoint) for each.
 */
function walkPaths(paths, fn) {
  for (const path of paths) {
    const pts = path.points || path;
    for (let i = 0; i < pts.length; i++) {
      fn(pts[i], pts[i + 1] || pts[i]);
    }
    if (path.children) walkPaths(path.children, fn);
  }
}

/**
 * Detect gorge: terrain rises steeply on both sides of the river.
 */
function detectGorge(elevation, cgx, cgz, px, pz, nextPoint, cellSize) {
  if (!nextPoint) return false;

  // Flow direction
  const fdx = (nextPoint.x || nextPoint.gx * cellSize) - px;
  const fdz = (nextPoint.z || nextPoint.gz * cellSize) - pz;
  const flen = Math.sqrt(fdx * fdx + fdz * fdz) || 1;

  // Perpendicular direction
  const perpX = -fdz / flen;
  const perpZ = fdx / flen;

  const riverElev = elevation.get(cgx, cgz);
  let leftRise = 0, rightRise = 0;

  for (let d = 1; d <= GORGE_CHECK_DIST; d++) {
    const lgx = Math.round(cgx + perpX * d);
    const lgz = Math.round(cgz + perpZ * d);
    const rgx = Math.round(cgx - perpX * d);
    const rgz = Math.round(cgz - perpZ * d);

    if (lgx >= 0 && lgx < elevation.width && lgz >= 0 && lgz < elevation.height) {
      leftRise = Math.max(leftRise, elevation.get(lgx, lgz) - riverElev);
    }
    if (rgx >= 0 && rgx < elevation.width && rgz >= 0 && rgz < elevation.height) {
      rightRise = Math.max(rightRise, elevation.get(rgx, rgz) - riverElev);
    }
  }

  return leftRise > GORGE_RISE_THRESHOLD && rightRise > GORGE_RISE_THRESHOLD;
}

/**
 * BFS distance from coast (water mask cells adjacent to land).
 */
function computeCoastDistance(waterMask, width, height, cellSize) {
  const dist = new Grid2D(width, height, { cellSize, fill: width + height });
  const queue = [];

  // Seed with coastal cells (water cells with land neighbors)
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (waterMask.get(gx, gz) === 0) continue;
      let hasLand = false;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < width && nz >= 0 && nz < height && waterMask.get(nx, nz) === 0) {
          hasLand = true; break;
        }
      }
      if (hasLand) {
        dist.set(gx, gz, 0);
        queue.push(gx | (gz << 16));
      }
    }
  }

  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  let head = 0;
  const maxDist = Math.round(FLOODPLAIN_COAST_RANGE_M / cellSize) + 5;
  while (head < queue.length) {
    const packed = queue[head++];
    const cx = packed & 0xFFFF;
    const cz = packed >> 16;
    const cd = dist.get(cx, cz);
    if (cd >= maxDist) continue;
    for (const [dx, dz] of dirs) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      if (dist.get(nx, nz) > cd + 1) {
        dist.set(nx, nz, cd + 1);
        queue.push(nx | (nz << 16));
      }
    }
  }

  return dist;
}
