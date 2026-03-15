/**
 * Pipeline step: build skeleton road network.
 * Reads: terrainSuitability, waterMask, elevation, slope, nuclei
 * Writes: roadGrid (layer), bridgeGrid (layer), roads (features), graph
 *
 * Internally stateful — pathfinds roads sequentially. From the pipeline's
 * perspective, this is a single function call.
 */

import { buildSkeletonRoads as buildSkeleton } from '../skeleton.js';

export function buildSkeletonRoads(map) {
  // skeleton.js currently reads map.buildability, map.waterMask, etc.
  // directly. It also calls map.addFeature which stamps roadGrid.
  // Delegate to existing function — will be cleaned up when FeatureMap
  // side effects are removed (Task 12-13).
  buildSkeleton(map);

  // Mirror the stamped grids into the layer bag so downstream pipeline
  // functions can find them via getLayer().
  if (map.roadGrid) map.setLayer('roadGrid', map.roadGrid);
  if (map.bridgeGrid) map.setLayer('bridgeGrid', map.bridgeGrid);

  return map;
}
