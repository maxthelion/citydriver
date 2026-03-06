/**
 * Import rivers from regional data at city resolution.
 * Smooths paths with Chaikin subdivision, computes per-vertex width
 * from accumulation, and paints onto the city waterMask.
 */

import { Grid2D } from '../core/Grid2D.js';

/**
 * Chaikin corner-cutting: smooths a polyline of {x, z, accumulation} points.
 */
function chaikinSmooth(points, iterations = 3) {
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
      });
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        z: a.z * 0.25 + b.z * 0.75,
        accumulation: a.accumulation * 0.25 + b.accumulation * 0.75,
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
function riverHalfWidth(accumulation) {
  return Math.max(1.5, Math.min(25, Math.sqrt(accumulation) / 8));
}

/**
 * Import regional rivers into city-resolution data.
 *
 * Steps:
 * 1. Convert regional river paths to city world coords
 * 2. Smooth with Chaikin subdivision
 * 3. Compute per-vertex width from accumulation
 * 4. Store as cityLayers.getData('riverPaths')
 * 5. Paint smoothed rivers onto waterMask
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 */
export function importRivers(cityLayers) {
  const params = cityLayers.getData('params');
  const regionalLayers = cityLayers.getData('regionalLayers');
  if (!regionalLayers || !params) return;

  const rivers = regionalLayers.getData('rivers');
  if (!rivers || rivers.length === 0) return;

  const rcs = params.regionalCellSize || 50;
  const minGx = params.regionalMinGx || 0;
  const minGz = params.regionalMinGz || 0;
  const cs = params.cellSize;
  const cityWorldW = params.width * cs;
  const cityWorldH = params.height * cs;
  const maxRgx = minGx + cityWorldW / rcs;
  const maxRgz = minGz + cityWorldH / rcs;

  const cityRiverPaths = [];

  function processSegment(seg, parentConfluence) {
    if (!seg.cells || seg.cells.length < 2) {
      for (const child of (seg.children || [])) {
        processSegment(child, parentConfluence);
      }
      return;
    }

    // Filter cells to city bounds, convert to city world coords
    const worldPoints = [];
    for (const cell of seg.cells) {
      if (cell.gx >= minGx - 1 && cell.gx <= maxRgx + 1 &&
          cell.gz >= minGz - 1 && cell.gz <= maxRgz + 1) {
        worldPoints.push({
          x: (cell.gx - minGx) * rcs,
          z: (cell.gz - minGz) * rcs,
          accumulation: cell.accumulation,
        });
      }
    }

    // Extend to parent confluence to close gaps between segments
    if (parentConfluence && worldPoints.length > 0) {
      worldPoints.push(parentConfluence);
    }

    let cityPath = null;
    if (worldPoints.length >= 2) {
      const smooth = chaikinSmooth(worldPoints, 3);

      // Add per-vertex width
      const points = smooth.map(p => ({
        x: p.x,
        z: p.z,
        width: riverHalfWidth(p.accumulation) * 2,
        accumulation: p.accumulation,
      }));

      cityPath = { points, children: [] };
      cityRiverPaths.push(cityPath);
    }

    // Process children — they join at this segment's first cell
    const firstCell = seg.cells[0];
    const joinPoint = {
      x: (firstCell.gx - minGx) * rcs,
      z: (firstCell.gz - minGz) * rcs,
      accumulation: firstCell.accumulation,
    };
    for (const child of (seg.children || [])) {
      const childResult = processSegment(child, joinPoint);
      if (childResult && cityPath) {
        cityPath.children.push(childResult);
      }
    }

    return cityPath;
  }

  for (const root of rivers) processSegment(root, null);

  cityLayers.setData('riverPaths', cityRiverPaths);

  // Paint smoothed rivers onto waterMask
  paintRiversOntoWaterMask(cityLayers, cityRiverPaths);
}

/**
 * Paint smooth variable-width river paths onto the waterMask grid.
 * This replaces the bilinear-sampled river cells with precisely painted
 * paths that match the vector representation.
 */
function paintRiversOntoWaterMask(cityLayers, riverPaths) {
  const waterMask = cityLayers.getGrid('waterMask');
  if (!waterMask) return;

  const params = cityLayers.getData('params');
  const cs = params.cellSize;
  const w = params.width;
  const h = params.height;

  for (const path of riverPaths) {
    const pts = path.points;
    if (pts.length < 2) continue;

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];

      // Walk along the segment, painting cells within the river width
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      // Step size: half a cell for good coverage
      const stepSize = cs * 0.5;
      const steps = Math.ceil(segLen / stepSize);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const halfW = (a.width * (1 - t) + b.width * t) / 2;

        // Paint a circle of radius halfW at this point
        const cellRadius = Math.ceil(halfW / cs);
        const cgx = Math.floor(px / cs);
        const cgz = Math.floor(pz / cs);

        for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
          for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
            const gx = cgx + ddx;
            const gz = cgz + ddz;
            if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;

            // Distance from cell center to river centerline point
            const cellCenterX = gx * cs + cs / 2;
            const cellCenterZ = gz * cs + cs / 2;
            const distSq = (cellCenterX - px) ** 2 + (cellCenterZ - pz) ** 2;
            if (distSq <= halfW * halfW) {
              waterMask.set(gx, gz, 1);
            }
          }
        }
      }
    }
  }
}
