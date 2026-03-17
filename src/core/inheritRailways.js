/**
 * Inherit regional railway lines into a city by clipping polylines to city bounds.
 */

import { clipPolylineToBounds } from './clipPolyline.js';
import { chaikinSmooth } from './math.js';

/**
 * @param {Array|null} railways - Regional railway data from LayerStack
 * @param {object} bounds - { minX, minZ, maxX, maxZ } in world coordinates
 * @param {object} [options]
 * @param {number} [options.chaikinPasses=2] - Smoothing iterations
 * @param {number} [options.margin=0] - Extra margin around bounds
 * @returns {Array<{ polyline: Array<{x, z}>, hierarchy: string, phase: number }>}
 */
export function inheritRailways(railways, bounds, options = {}) {
  if (!railways || railways.length === 0) return [];

  const { chaikinPasses = 2, margin = 0 } = options;
  const expandedBounds = {
    minX: bounds.minX - margin,
    minZ: bounds.minZ - margin,
    maxX: bounds.maxX + margin,
    maxZ: bounds.maxZ + margin,
  };

  const result = [];

  for (const rail of railways) {
    if (!rail.polyline || rail.polyline.length < 2) continue;

    const clipped = clipPolylineToBounds(rail.polyline, expandedBounds);
    if (!clipped || clipped.clipped.length < 2) continue;

    let smoothed = clipped.clipped.map(p => ({ x: p.x, z: p.z }));
    for (let i = 0; i < chaikinPasses; i++) {
      smoothed = chaikinSmooth(smoothed);
    }

    result.push({
      polyline: smoothed,
      hierarchy: rail.hierarchy || 'branch',
      phase: rail.phase || 1,
    });
  }

  return result;
}
