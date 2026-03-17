/**
 * Shared river geometry functions.
 * Single source of truth for river width, depth, cross-section profile,
 * path smoothing, and segment-to-vector-path conversion.
 */

// Regional-level stamp fractions (paintPathsOntoWaterMask is regional-only).
// Larger fraction than city to prevent gaps between coarse cells.
const REGIONAL_STAMP_FRACTION = 0.75;
const REGIONAL_STEP_FRACTION = 0.5;

/**
 * Chaikin corner-cutting: smooths a polyline of {x, z, accumulation} points.
 */
export function chaikinSmooth(points, iterations = 3) {
  let result = points;
  for (let iter = 0; iter < iterations; iter++) {
    const next = [result[0]];
    for (let i = 0; i < result.length - 1; i++) {
      const a = result[i];
      const b = result[i + 1];
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        z: a.z * 0.75 + b.z * 0.25,
        accumulation: a.accumulation * 0.75 + b.accumulation * 0.25,
        elevation: (a.elevation ?? 0) * 0.75 + (b.elevation ?? 0) * 0.25,
      });
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        z: a.z * 0.25 + b.z * 0.75,
        accumulation: a.accumulation * 0.25 + b.accumulation * 0.75,
        elevation: (a.elevation ?? 0) * 0.25 + (b.elevation ?? 0) * 0.75,
      });
    }
    next.push(result[result.length - 1]);
    result = next;
  }
  return result;
}

/**
 * Compute river half-width in world units from accumulation.
 */
export function riverHalfWidth(accumulation) {
  return Math.max(2, Math.min(40, Math.sqrt(accumulation) / 5));
}

/**
 * Max channel depth from half-width.
 */
export function riverMaxDepth(halfWidth) {
  return Math.min(4, 1.5 + halfWidth / 15);
}

/**
 * Cross-section profile: normalizedDist -> depthFraction (0..1).
 * nd < 0.6: deep channel (full depth)
 * nd 0.6-1.0: bank slope (ramps from 1.0 to 0.3)
 * nd 1.0-1.5: gentle bank (ramps from 0.3 to 0)
 * nd >= 1.5: no modification (returns 0)
 */
export function channelProfile(nd) {
  if (nd < 0.6) return 1.0;
  if (nd < 1.0) return 1.0 - (nd - 0.6) / 0.4 * 0.7;
  if (nd < 1.5) return 0.3 * (1.0 - (nd - 1.0) / 0.5);
  return 0;
}

/**
 * Valley half-width in meters from accumulation.
 * Much wider than the river itself — the carved valley around it.
 */
export function valleyHalfWidth(accumulation) {
  return Math.max(30, Math.min(500, Math.sqrt(accumulation) * 1.5));
}

/**
 * Valley depth in meters from accumulation.
 */
export function valleyDepth(accumulation) {
  return Math.max(1, Math.min(15, Math.sqrt(accumulation) / 20));
}

/**
 * Valley cross-section profile.
 * nd = normalised distance from centreline (0 = centre, 1 = edge)
 * Returns 0-1 depth fraction.
 */
export function valleyProfile(nd) {
  if (nd < 0.3) return 1.0;
  if (nd < 0.8) return 1.0 - 0.7 * ((nd - 0.3) / 0.5);
  if (nd < 1.0) return 0.3 - 0.3 * ((nd - 0.8) / 0.2);
  return 0;
}

/**
 * Gorge cross-section profile — narrow, steep walls.
 */
export function gorgeProfile(nd) {
  if (nd < 0.5) return 1.0;
  if (nd < 0.7) return 1.0 - ((nd - 0.5) / 0.2);
  return 0;
}

/**
 * Convert segment tree roots to vector paths with width.
 * Walks cells, converts to world coords, smooths, computes width.
 *
 * @param {Array} roots - River segment tree roots
 * @param {number} cellSize - Grid cell size in world units
 * @param {object} [options]
 * @param {number} [options.smoothIterations=2] - Chaikin iterations
 * @param {number} [options.seaLevel=0] - Sea level for clipping
 * @param {object} [options.elevation] - Elevation grid for sea-level clipping
 * @returns {Array<{points: Array<{x, z, width, accumulation}>, children: Array}>}
 */
export function segmentsToVectorPaths(roots, cellSize, options = {}) {
  const {
    smoothIterations = 2,
    seaLevel = 0,
    elevation,
  } = options;

  const paths = [];

  function processSegment(seg, parentConfluence) {
    if (!seg.cells || seg.cells.length < 2) {
      for (const child of (seg.children || [])) {
        processSegment(child, parentConfluence);
      }
      return null;
    }

    const worldPoints = [];
    for (const cell of seg.cells) {
      if (elevation) {
        const elev = elevation.get(cell.gx, cell.gz);
        if (elev < seaLevel) break;
      }
      worldPoints.push({
        x: cell.gx * cellSize,
        z: cell.gz * cellSize,
        accumulation: cell.accumulation,
        elevation: cell.elevation,
      });
    }

    if (parentConfluence && worldPoints.length > 0) {
      worldPoints.push(parentConfluence);
    }

    let path = null;
    if (worldPoints.length >= 2) {
      const smooth = chaikinSmooth(worldPoints, smoothIterations);
      const points = smooth.map(p => ({
        x: p.x,
        z: p.z,
        width: riverHalfWidth(p.accumulation) * 2,
        accumulation: p.accumulation,
        elevation: p.elevation,
      }));
      path = { points, children: [] };
      paths.push(path);
    }

    const firstCell = seg.cells[0];
    const joinPoint = {
      x: firstCell.gx * cellSize,
      z: firstCell.gz * cellSize,
      accumulation: firstCell.accumulation,
      elevation: firstCell.elevation,
    };
    for (const child of (seg.children || [])) {
      const childResult = processSegment(child, joinPoint);
      if (childResult && path) {
        path.children.push(childResult);
      }
    }

    return path;
  }

  for (const root of roots) processSegment(root, null);

  return paths;
}

/**
 * Paint smooth variable-width river paths onto a grid.
 * Stamps circles along each path segment at the river's width.
 *
 * @param {import('./Grid2D.js').Grid2D} waterMask - Grid to paint onto
 * @param {Array} riverPaths - Vector paths with per-vertex width
 * @param {number} cellSize - Grid cell size
 * @param {number} width - Grid width in cells
 * @param {number} height - Grid height in cells
 * @param {number} [offsetX=0] - World-coord offset to subtract from path X
 * @param {number} [offsetZ=0] - World-coord offset to subtract from path Z
 */
export function paintPathsOntoWaterMask(waterMask, riverPaths, cellSize, width, height, offsetX = 0, offsetZ = 0) {
  for (const path of riverPaths) {
    const pts = path.points;
    if (pts.length < 2) continue;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];

      const ax = a.x - offsetX;
      const az = a.z - offsetZ;
      const bx = b.x - offsetX;
      const bz = b.z - offsetZ;

      const dx = bx - ax;
      const dz = bz - az;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      const stepSize = cellSize * REGIONAL_STEP_FRACTION;
      const steps = Math.ceil(segLen / stepSize);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t;
        const pz = az + dz * t;
        const halfW = (a.width * (1 - t) + b.width * t) / 2;

        // Ensure at least the cell containing the point is painted,
        // even when halfW < cellSize (common at regional resolution)
        const effectiveRadius = Math.max(halfW, cellSize * REGIONAL_STAMP_FRACTION);
        const cellRadius = Math.ceil(effectiveRadius / cellSize);
        const cgx = Math.floor(px / cellSize);
        const cgz = Math.floor(pz / cellSize);

        for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
          for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
            const gx = cgx + ddx;
            const gz = cgz + ddz;
            if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;

            const cellCenterX = gx * cellSize + cellSize / 2;
            const cellCenterZ = gz * cellSize + cellSize / 2;
            const distSq = (cellCenterX - px) ** 2 + (cellCenterZ - pz) ** 2;
            if (distSq <= effectiveRadius * effectiveRadius) {
              waterMask.set(gx, gz, 1);
            }
          }
        }
      }
    }
  }
}
