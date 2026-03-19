/**
 * cityPipeline — generator-based city generation pipeline.
 *
 * Yields step descriptors consumed by PipelineRunner. Each step has a stable
 * string id so hooks (timing, invariant checks, bitmap logging) can filter by name.
 *
 * Step sequence:
 *   skeleton   → land-value → zones → spatial
 *   → growth-1 … growth-N  (organic loop, archetype-driven)
 *   → connect
 *
 * For archetypes without growth config, falls back to:
 *   reserve → ribbons → connect
 *
 * Spec: specs/v5/next-steps.md § Step 1
 */

import { step } from './PipelineRunner.js';
import { buildSkeletonRoads } from './buildSkeletonRoads.js';
import { computeLandValue } from './computeLandValue.js';
import { extractZones } from './extractZones.js';
import { computeSpatialLayers } from './computeSpatialLayers.js';
import { reserveLandUse } from './reserveLandUse.js';
import { layoutRibbons } from './layoutRibbons.js';
import { connectToNetwork } from './connectToNetwork.js';
import { initGrowthState, runGrowthTick } from './growthTick.js';

/**
 * Main city pipeline generator.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {object|null} archetype
 * @yields {import('./PipelineRunner.js').StepDescriptor}
 */
export function* cityPipeline(map, archetype) {
  yield step('skeleton',   () => buildSkeletonRoads(map));
  yield step('land-value', () => computeLandValue(map));
  yield step('zones',      () => extractZones(map));
  yield step('spatial',    () => computeSpatialLayers(map));

  if (archetype && archetype.growth) {
    yield* organicGrowthPipeline(map, archetype);
  } else {
    yield step('reserve', () => reserveLandUse(map, archetype));
    yield step('ribbons', () => layoutRibbons(map));
  }

  yield step('connect', () => connectToNetwork(map));
}

/**
 * Organic growth pipeline — influence → value → allocate → roads, repeated per tick.
 * Terminates when runGrowthTick signals completion (all agent caps reached).
 *
 * Step ids: 'growth-1', 'growth-2', …
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {object} archetype
 * @yields {import('./PipelineRunner.js').StepDescriptor}
 */
function* organicGrowthPipeline(map, archetype) {
  const state = initGrowthState(map, archetype);
  let tick = 0;
  let isDone = false;

  while (!isDone) {
    tick++;
    // yield the step; the runner executes fn() and passes the result back via next().
    // runGrowthTick returns true when growth is complete.
    isDone = yield step(`growth-${tick}`, () => runGrowthTick(map, archetype, state));
  }
}
