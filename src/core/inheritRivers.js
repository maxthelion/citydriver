/**
 * Shared river inheritance: clip river paths from a parent map to child bounds,
 * apply extra Chaikin smoothing for higher resolution, compute widths.
 *
 * Used by city setup to import regional rivers. Could also be used by any
 * future sub-area extraction.
 */

import { chaikinSmooth, riverHalfWidth } from './riverGeometry.js';

/**
 * Extract river polylines from a river segment tree, clipped to a bounding box.
 *
 * @param {Array} riverPaths - River segment tree (each has .points, .children)
 * @param {object} bounds - { minX, minZ, maxX, maxZ } in world coordinates
 * @param {object} [options]
 * @param {number} [options.chaikinPasses=1] - Extra Chaikin smoothing iterations
 * @param {number} [options.margin=0] - Extra margin around bounds for clipping
 * @returns {Array<{ polyline: Array<{x, z, accumulation, width}> }>}
 */
export function inheritRivers(riverPaths, bounds, options = {}) {
  const { chaikinPasses = 1, margin = 0 } = options;
  const minX = bounds.minX - margin;
  const minZ = bounds.minZ - margin;
  const maxX = bounds.maxX + margin;
  const maxZ = bounds.maxZ + margin;

  const result = [];
  _walkTree(riverPaths, minX, minZ, maxX, maxZ, chaikinPasses, result);
  return result;
}

function _walkTree(segments, minX, minZ, maxX, maxZ, chaikinPasses, result) {
  for (const seg of segments) {
    if (seg.points && seg.points.length >= 2) {
      // Clip to bounds, keeping one point outside to avoid gaps
      const clipped = [];
      for (const p of seg.points) {
        if (p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ) {
          clipped.push({
            x: p.x,
            z: p.z,
            accumulation: p.accumulation,
            width: p.width,
          });
        } else if (clipped.length > 0) {
          // One point outside to close the gap
          clipped.push({ x: p.x, z: p.z, accumulation: p.accumulation, width: p.width });
          break;
        }
      }

      if (clipped.length >= 2) {
        // Chaikin smooth for higher resolution
        const smoothed = chaikinSmooth(
          clipped.map(p => ({ x: p.x, z: p.z, accumulation: p.accumulation })),
          chaikinPasses,
        );

        result.push({
          polyline: smoothed.map(p => ({
            x: p.x,
            z: p.z,
            accumulation: p.accumulation,
            width: riverHalfWidth(p.accumulation) * 2,
          })),
        });
      }
    }

    // Recurse into children
    if (seg.children) {
      _walkTree(seg.children, minX, minZ, maxX, maxZ, chaikinPasses, result);
    }
  }
}
