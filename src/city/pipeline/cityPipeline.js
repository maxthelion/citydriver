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
import { RESERVATION } from './growthAgents.js';
import { GPUDevice } from '../../core/gpu/GPUDevice.js';
import { GPUValueSession } from './valueLayersGPU.js';
import { GPUInfluenceSession } from './influenceLayersGPU.js';

const DEV_PROXIMITY_THRESHOLD = 0.01;

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
 *   growth:gpu-init     → initialise GPU sessions (async in browser, sync no-op in Node.js)
 *   growth-N:influence  → computeInfluenceLayers + agriculture retreat
 *   growth-N:value      → composeAllValueLayers
 *   growth-N:ribbons    → throttled layoutRibbons (Phase 2.5)
 *   growth-N:allocate   → agent allocation loop
 *   growth-N:roads      → growRoads + agriculture fill
 *
 * GPU acceleration is transparent: when WebGPU is available the influence and value
 * step functions become async and PipelineRunner returns a Promise from advance().
 * In Node.js (no navigator.gpu / globalThis.gpu) GPUDevice.isDefinitelyUnavailable()
 * returns true → the gpu-init step is synchronous → all tick() calls remain boolean.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {object} archetype
 * @yields {import('./PipelineRunner.js').StepDescriptor}
 */
function* organicGrowthPipeline(map, archetype) {
  const state    = initGrowthState(map, archetype);
  const maxTicks = archetype.growth.maxGrowthTicks || 8;

  // Closed-over GPU session references — set during gpu-init step if WebGPU is available.
  let gpuValue    = null;
  let gpuInfluence = null;

  // ── GPU initialisation step ──────────────────────────────────────────────
  // Returns synchronously (undefined) in Node.js / non-GPU environments so that
  // PipelineRunner.advance() stays synchronous and existing callers are unchanged.
  // In a WebGPU-capable browser this returns a Promise → advance() returns a Promise.
  yield step('growth:gpu-init', () => {
    if (GPUDevice.isDefinitelyUnavailable()) return; // fast sync exit in Node.js
    return (async () => {
      try {
        const gpu = await GPUDevice.get();
        if (!gpu.available) return;
        gpuValue    = GPUValueSession.create(gpu.device, map, archetype);
        gpuInfluence = GPUInfluenceSession.create(gpu.device, map, archetype);
        console.log('[cityPipeline] GPU sessions ready (value + influence)');
      } catch (e) {
        console.warn('[cityPipeline] GPU session init failed, using CPU:', e?.message ?? e);
        gpuValue = null;
        gpuInfluence = null;
      }
    })();
  });

  // Upload static spatial layers to GPU once, immediately after gpu-init.
  // This runs synchronously when the generator resumes after gpu-init.
  // gpuValue is already set (or null) at this point.
  if (gpuValue) gpuValue.uploadStaticLayers(map);

  // ── Growth loop ────────────────────────────────────────────────────────────
  while (state.tick < maxTicks) {
    state.tick++;
    const t = state.tick;

    let influenceResult, valueResult, allocResult;

    // ── Influence phase (GPU or CPU) ─────────────────────────────────────
    yield step(`growth-${t}:influence`,
      gpuInfluence
        ? async () => {
            const resGrid = map.getLayer('reservationGrid');
            const influenceLayers = await gpuInfluence.compute(
              resGrid, map.width, map.height,
              archetype.growth.influenceRadii || {},
              map.nuclei || [],
            );
            const devProximity = influenceLayers.developmentProximity;

            // Agriculture retreat: cells near development revert to NONE (CPU, cheap)
            const n = map.width * map.height;
            for (let i = 0; i < n; i++) {
              if (resGrid.data[i] === RESERVATION.AGRICULTURE &&
                  devProximity[i] >= DEV_PROXIMITY_THRESHOLD) {
                resGrid.data[i] = RESERVATION.NONE;
              }
            }

            influenceResult = { influenceLayers, devProximity };
            map._influenceLayers = influenceLayers;
          }
        : () => {
            influenceResult = runInfluencePhase(map, archetype);
          },
    );

    // ── Value phase (GPU or CPU) ────────────────────────────────────────
    yield step(`growth-${t}:value`,
      gpuValue
        ? async () => {
            const valueLayers = await gpuValue.compose(influenceResult.influenceLayers);
            map._valueLayers = valueLayers;
            map._influenceLayers = influenceResult.influenceLayers;
            valueResult = { valueLayers };
          }
        : () => {
            valueResult = runValuePhase(map, archetype, influenceResult.influenceLayers);
          },
    );

    yield step(`growth-${t}:ribbons`, () => {
      runRibbonPhase(map, archetype, state, influenceResult.devProximity);
    });

    yield step(`growth-${t}:allocate`, () => {
      allocResult = runAllocatePhase(
        map, archetype, state, valueResult.valueLayers, influenceResult.devProximity,
      );
    });

    let isDone = false;
    yield step(`growth-${t}:roads`, () => {
      isDone = runRoadsPhase(map, archetype, state, allocResult);
    });

    if (isDone) break;
  }

  // Cleanup GPU resources when the growth loop exits
  gpuValue?.destroy();
  gpuInfluence?.destroy();
}
