/**
 * Shared river inheritance: clip river paths from a parent map to child bounds,
 * apply extra Chaikin smoothing for higher resolution, compute widths.
 *
 * Used by city setup to import regional rivers. Could also be used by any
 * future sub-area extraction.
 */

import { chaikinSmooth, riverHalfWidth } from './riverGeometry.js';
import { clipPolylineToBounds } from './clipPolyline.js';

/**
 * Extract river polylines from a river segment tree, clipped to a bounding box.
 *
 * @param {Array} riverPaths - River segment tree (each has .points, .children)
 * @param {object} bounds - { minX, minZ, maxX, maxZ } in world coordinates
 * @param {object} [options]
 * @param {number} [options.chaikinPasses=1] - Extra Chaikin smoothing iterations
 * @param {number} [options.margin=0] - Extra margin around bounds for clipping
 * @returns {Array<{ polyline: Array<{x, z, accumulation, width}>, systemId: number }>}
 */
export function inheritRivers(riverPaths, bounds, options = {}) {
  const { chaikinPasses = 1, margin = 0 } = options;
  const expandedBounds = {
    minX: bounds.minX - margin,
    minZ: bounds.minZ - margin,
    maxX: bounds.maxX + margin,
    maxZ: bounds.maxZ + margin,
  };

  const result = [];
  for (let rootIdx = 0; rootIdx < riverPaths.length; rootIdx++) {
    _walkTree(riverPaths[rootIdx], expandedBounds, chaikinPasses, rootIdx, result);
  }
  return result;
}

function _walkTree(seg, bounds, chaikinPasses, systemId, result) {
  if (seg.points && seg.points.length >= 2) {
    const clipped = clipPolylineToBounds(seg.points, bounds);

    if (clipped && clipped.clipped.length >= 2) {
      const smoothed = chaikinSmooth(
        clipped.clipped.map(p => ({ x: p.x, z: p.z, accumulation: p.accumulation, elevation: p.elevation })),
        chaikinPasses,
      );

      result.push({
        polyline: smoothed.map(p => ({
          x: p.x,
          z: p.z,
          accumulation: p.accumulation,
          elevation: p.elevation,
          width: riverHalfWidth(p.accumulation) * 2,
        })),
        systemId,
      });
    }
  }

  if (seg.children) {
    for (const child of seg.children) {
      _walkTree(child, bounds, chaikinPasses, systemId, result);
    }
  }
}
