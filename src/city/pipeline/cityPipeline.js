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
import {
  initGrowthState,
  runInfluencePhase, runValuePhase, runRibbonPhase, runAllocatePhase, runRoadsPhase,
} from './growthTick.js';
import { createZoneBoundaryRoads } from './zoneBoundaryRoads.js';

/**
 * Main city pipeline generator.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {object|null} archetype
 * @yields {import('./PipelineRunner.js').StepDescriptor}
 */
export function* cityPipeline(map, archetype) {
  yield step('skeleton',      () => buildSkeletonRoads(map));
  yield step('land-value',    () => computeLandValue(map));
  // Step 3: Zone re-extraction feedback loop (specs/v5/next-steps.md § Step 3)
  // First extraction: coarse zones from skeleton faces only.
  // Then zone boundary roads split large faces into finer parcels.
  // Second extraction: re-run so graph faces reflect the new secondary roads.
  yield step('zones',         () => extractZones(map));
  let zoneBoundaryResult;
  yield step('zone-boundary', () => { zoneBoundaryResult = createZoneBoundaryRoads(map); });
  // Only re-extract if zone-boundary actually added roads (otherwise zones are unchanged)
  if (zoneBoundaryResult?.segmentsAdded > 0) {
    yield step('zones-refine', () => extractZones(map));
  }
  yield step('spatial',       () => computeSpatialLayers(map));

  if (archetype && archetype.growth) {
    yield* organicGrowthPipeline(map, archetype);
  } else {
    yield step('reserve', () => reserveLandUse(map, archetype));
    yield step('ribbons', () => layoutRibbons(map));
  }

  yield step('connect', () => connectToNetwork(map));
}

/**
 * Organic growth pipeline — exposes each phase as a named yield:
 *   growth-N:influence  → computeInfluenceLayers + agriculture retreat
 *   growth-N:value      → composeAllValueLayers
 *   growth-N:ribbons    → throttled layoutRibbons (Phase 2.5)
 *   growth-N:allocate   → agent allocation loop
 *   growth-N:roads      → growRoads + agriculture fill
 *
 * This enables stopping the pipeline at any sub-step to inspect intermediate state
 * (e.g. pause at growth-3:influence to see value layers before allocation runs).
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {object} archetype
 * @yields {import('./PipelineRunner.js').StepDescriptor}
 */
function* organicGrowthPipeline(map, archetype) {
  const state    = initGrowthState(map, archetype);
  const maxTicks = archetype.growth.maxGrowthTicks || 8;

  while (state.tick < maxTicks) {
    state.tick++;
    const t = state.tick;

    let influenceResult, valueResult, allocResult;

    yield step(`growth-${t}:influence`, () => {
      influenceResult = runInfluencePhase(map, archetype);
    });

    yield step(`growth-${t}:value`, () => {
      valueResult = runValuePhase(map, archetype, influenceResult.influenceLayers);
    });

    yield step(`growth-${t}:ribbons`, () => {
      runRibbonPhase(map, archetype, state, influenceResult.devProximity);
    });

    yield step(`growth-${t}:allocate`, () => {
      allocResult = runAllocatePhase(map, archetype, state, valueResult.valueLayers, influenceResult.devProximity);
    });

    let isDone = false;
    yield step(`growth-${t}:roads`, () => {
      isDone = runRoadsPhase(map, archetype, state, allocResult);
    });

    if (isDone) break;
  }
}
