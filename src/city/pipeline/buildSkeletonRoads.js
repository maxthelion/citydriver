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
  buildSkeleton(map);

  // Set layers to point to the RoadNetwork's grids so downstream
  // pipeline functions can read them via getLayer().
  map.setLayer('roadGrid', map.roadNetwork.roadGrid);
  map.setLayer('bridgeGrid', map.roadNetwork.bridgeGrid);

  return map;
}
