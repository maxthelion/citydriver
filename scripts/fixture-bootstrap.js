import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { buildCityMap } from '../src/city/buildCityMap.js';
import { loadMapFixture } from '../src/core/featureMapFixture.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';

export async function loadMapForStep({
  fixturePath = null,
  seed,
  gx = null,
  gz = null,
  step = 'spatial',
  archetype = 'marketTown',
}) {
  if (fixturePath) {
    const map = await loadMapFixture(fixturePath);
    return buildRunContext(map, {
      seed: finiteOrDefault(seed, map.fixtureMeta?.seed ?? 42),
      gx: finiteOrDefault(gx, map.fixtureMeta?.gx ?? null),
      gz: finiteOrDefault(gz, map.fixtureMeta?.gz ?? null),
      fromFixture: true,
      fixturePath,
      archetypeId: resolveArchetypeId(archetype, map.fixtureMeta),
    });
  }

  const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
  if (!settlement) {
    throw new Error(`No settlement for seed=${seed}${gx != null && gz != null ? ` near (${gx},${gz})` : ''}`);
  }

  const result = await buildCityMap({
    seed,
    layers,
    settlement,
    archetype,
    step,
  });
  return buildRunContext(result.map, {
    seed,
    gx: finiteOrDefault(gx, settlement.gx),
    gz: finiteOrDefault(gz, settlement.gz),
    fromFixture: false,
    fixturePath: null,
    archetypeId: result.archetype?.id ?? null,
    stepCount: result.stepCount ?? null,
    lastStepId: result.lastStepId ?? null,
    archetypeName: result.archetype?.name ?? null,
  });
}

export async function loadOrResumePipelineMap({
  fixturePath = null,
  seed,
  gx = null,
  gz = null,
  archetype = 'auto',
  step = null,
  growth = 0,
}) {
  if (!fixturePath) {
    const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
    if (!settlement) {
      throw new Error(`No settlement for seed=${seed}${gx != null && gz != null ? ` near (${gx},${gz})` : ''}`);
    }
    const result = await buildCityMap({
      seed,
      layers,
      settlement,
      archetype,
      step,
      growth,
    });
    return {
      ...buildRunContext(result.map, {
        seed,
        gx: finiteOrDefault(gx, settlement.gx),
        gz: finiteOrDefault(gz, settlement.gz),
        fromFixture: false,
        fixturePath: null,
        archetypeId: result.archetype?.id ?? null,
        stepCount: result.stepCount ?? null,
        lastStepId: result.lastStepId ?? null,
        archetypeName: result.archetype?.name ?? null,
      }),
      archetype: result.archetype,
      stepCount: result.stepCount ?? null,
      lastStepId: result.lastStepId ?? null,
    };
  }

  const map = await loadMapFixture(fixturePath);
  const fixtureMeta = map.fixtureMeta || {};
  const resolvedArchetypeId = resolveArchetypeId(archetype, fixtureMeta);
  const resolvedArchetype = resolveArchetypeObject(resolvedArchetypeId, fixtureMeta);
  const stepCount = fixtureMeta.stepCount ?? null;
  const lastStepId = fixtureMeta.lastStepId ?? fixtureMeta.afterStep ?? null;

  if (stepCount == null) {
    throw new Error(
      `Fixture ${fixturePath} does not include stepCount metadata; regenerate it with scripts/save-fixture.js before resuming pipeline steps.`,
    );
  }

  const strategy = new LandFirstDevelopment(map, { archetype: resolvedArchetype });
  strategy._tick = stepCount;

  if (step) {
    const target = resolvePipelineTarget(step, growth);
    const stepOrder = compareStepOrder(lastStepId, target);
    if (stepOrder > 0 && !isStepReached(lastStepId, target, step)) {
      throw new Error(
        `Fixture ${fixturePath} is already past requested step ${target} (fixture at ${lastStepId}); use an earlier fixture if you need to inspect that step.`,
      );
    }
    if (!isStepReached(lastStepId, target, step)) {
      let more = true;
      while (more) {
        const result = strategy.tick();
        more = result instanceof Promise ? await result : result;
        if (!more) break;
        if (strategy.runner.currentStep === target) break;
        if (step === 'zones' && strategy.runner.currentStep === 'spatial') break;
      }
    }
  } else {
    await strategy.runToCompletion();
  }

  return {
    ...buildRunContext(map, {
      seed: fixtureMeta.seed ?? finiteOrDefault(seed, 42),
      gx: fixtureMeta.gx ?? finiteOrDefault(gx, null),
      gz: fixtureMeta.gz ?? finiteOrDefault(gz, null),
      fromFixture: true,
      fixturePath,
      archetypeId: resolvedArchetype?.id ?? resolvedArchetypeId ?? null,
      stepCount: strategy._tick,
      lastStepId: strategy.runner.currentStep ?? lastStepId,
      archetypeName: resolvedArchetype?.name ?? fixtureMeta.archetype ?? null,
    }),
    archetype: resolvedArchetype,
    stepCount: strategy._tick,
    lastStepId: strategy.runner.currentStep ?? lastStepId,
  };
}

export function resolveArchetypeId(requestedArchetype, fixtureMeta = {}) {
  if (requestedArchetype && requestedArchetype !== 'auto') {
    if (!ARCHETYPES[requestedArchetype]) {
      throw new Error(`Unknown archetype: ${requestedArchetype}`);
    }
    return requestedArchetype;
  }
  if (fixtureMeta.archetypeId) return fixtureMeta.archetypeId;
  if (fixtureMeta.archetype) {
    const match = Object.entries(ARCHETYPES).find(([, value]) => value.name === fixtureMeta.archetype);
    if (match) return match[0];
  }
  return 'marketTown';
}

export function resolvePipelineTarget(step, growth = 0) {
  if (!step) return null;
  if (step === 'growth') {
    return `growth-${growth}:roads`;
  }
  return STEP_TARGETS[step] || step;
}

export function isStepReached(currentStepId, targetStepId, requestedStep = null) {
  if (!targetStepId || !currentStepId) return false;
  if (currentStepId === targetStepId) return true;
  return requestedStep === 'zones' && currentStepId === 'spatial';
}

export function compareStepOrder(leftStepId, rightStepId) {
  const left = stepRank(leftStepId);
  const right = stepRank(rightStepId);
  if (left == null || right == null) return 0;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function resolveArchetypeObject(resolvedArchetypeId, fixtureMeta = {}) {
  if (resolvedArchetypeId && ARCHETYPES[resolvedArchetypeId]) {
    return ARCHETYPES[resolvedArchetypeId];
  }
  if (fixtureMeta.archetypeId && ARCHETYPES[fixtureMeta.archetypeId]) {
    return ARCHETYPES[fixtureMeta.archetypeId];
  }
  if (fixtureMeta.archetype) {
    const match = Object.values(ARCHETYPES).find(value => value.name === fixtureMeta.archetype);
    if (match) return match;
  }
  return ARCHETYPES.marketTown;
}

function buildRunContext(map, options) {
  const fixtureMeta = map.fixtureMeta || null;
  return {
    map,
    runSeed: options.seed ?? fixtureMeta?.seed ?? 42,
    runGx: options.gx ?? fixtureMeta?.gx ?? null,
    runGz: options.gz ?? fixtureMeta?.gz ?? null,
    fromFixture: Boolean(options.fromFixture),
    fixturePath: options.fixturePath ?? null,
    fixtureMeta,
    archetypeId: options.archetypeId ?? fixtureMeta?.archetypeId ?? null,
    archetypeName: options.archetypeName ?? fixtureMeta?.archetype ?? null,
    stepCount: options.stepCount ?? fixtureMeta?.stepCount ?? null,
    lastStepId: options.lastStepId ?? fixtureMeta?.lastStepId ?? null,
  };
}

function finiteOrDefault(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

const STEP_TARGETS = {
  skeleton: 'skeleton',
  zones: 'zones-refine',
  spatial: 'spatial',
  connect: 'smooth-roads',
  'smooth-roads': 'smooth-roads',
};

const BASE_STEP_ORDER = [
  'skeleton',
  'boundaries',
  'land-value',
  'zones',
  'zone-boundary',
  'zones-refine',
  'spatial',
  'growth:gpu-init',
  'parcels',
  'plots',
  'edge-lookups',
  'connect',
  'smooth-roads',
];

function stepRank(stepId) {
  if (!stepId) return null;
  const growthMatch = stepId.match(/^growth-(\d+):(influence|value|ribbons|allocate|roads)$/);
  if (growthMatch) {
    const phaseOrder = {
      influence: 0,
      value: 1,
      ribbons: 2,
      allocate: 3,
      roads: 4,
    };
    const tick = Number(growthMatch[1]);
    return 1000 + tick * 10 + phaseOrder[growthMatch[2]];
  }
  const baseIndex = BASE_STEP_ORDER.indexOf(stepId);
  return baseIndex >= 0 ? baseIndex : null;
}
