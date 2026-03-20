/**
 * buildCityMap — async factory for city maps.
 *
 * Wraps setupCity + archetype resolution + pipeline execution into a single
 * call. Returns a fully-generated, ready-to-render FeatureMap.
 *
 * Spec: specs/v5/city-screen-refactor.md
 */

import { setupCity } from './setup.js';
import { LandFirstDevelopment } from './strategies/landFirstDevelopment.js';
import { ARCHETYPES } from './archetypes.js';
import { scoreSettlement } from './archetypeScoring.js';
import { SeededRandom } from '../core/rng.js';

/**
 * Map user-facing step names to the pipeline step ID to stop after.
 * 'connect' includes smooth-roads per spec (connect = same as null).
 *
 * 'zones' is a special case: the spec says "stop after zone extraction
 * (incl. refine)" but zones-refine is conditionally skipped. The loop
 * handles this by also breaking when it sees 'spatial' (meaning the
 * zone phase is over). This may execute one extra step (spatial) when
 * zones-refine is skipped — acceptable for debug inspection.
 */
const STEP_TARGETS = {
  skeleton:       'skeleton',
  zones:          'zones-refine',
  spatial:        'spatial',
  connect:        'smooth-roads',
  'smooth-roads': 'smooth-roads',
};

/**
 * Build a city map from declarative parameters.
 *
 * @param {object} options
 * @param {number}        options.seed       — region seed (for RNG)
 * @param {object}        options.layers     — regional layer bag from generateRegion
 * @param {object}        options.settlement — settlement record (gx, gz, …)
 * @param {string|object} [options.archetype='auto'] — archetype key, 'auto', or archetype object
 * @param {string|null}   [options.step=null]  — pipeline step to stop after (null = complete)
 * @param {number}        [options.growth=0]   — growth tick count (when step === 'growth')
 * @returns {Promise<{ map: FeatureMap, archetype: object }>}
 */
export async function buildCityMap({
  seed, layers, settlement, archetype = 'auto', step = null, growth = 0,
}) {
  if (!layers) throw new Error('buildCityMap: layers is required');
  if (!settlement) throw new Error('buildCityMap: settlement is required');

  const rng = new SeededRandom(seed ?? 42);
  const map = setupCity(layers, settlement, rng.fork('city'));

  // Stash regional data on the map so CityScreen can render the minimap
  // without needing separate layers/settlement parameters.
  map.regionalLayers = layers;
  map.settlement = settlement;

  // Resolve archetype
  let resolvedArchetype;
  if (archetype === 'auto' || archetype == null) {
    const scores = scoreSettlement(map);
    resolvedArchetype = scores[0].archetype;
    console.log(`City archetype: ${resolvedArchetype.name} (score ${scores[0].score.toFixed(2)})`);
    for (const s of scores) {
      console.log(`  ${s.archetype.name}: ${s.score.toFixed(2)} — ${s.factors.join(', ')}`);
    }
  } else if (typeof archetype === 'string') {
    resolvedArchetype = ARCHETYPES[archetype];
    if (!resolvedArchetype) {
      throw new Error(`Unknown archetype key: "${archetype}"`);
    }
  } else {
    resolvedArchetype = archetype;
  }

  const strategy = new LandFirstDevelopment(map, { archetype: resolvedArchetype });

  if (step) {
    // Resolve the target pipeline step ID
    let target;
    if (step === 'growth') {
      target = `growth-${growth}:roads`;
    } else {
      target = STEP_TARGETS[step] || step;
    }

    let ran = true;
    while (ran) {
      const result = strategy.tick();
      ran = (result instanceof Promise) ? await result : result;
      const current = strategy.runner.currentStep;
      if (current === target) break;
      // zones-refine is conditional — if skipped, 'spatial' means zone phase is over
      if (step === 'zones' && current === 'spatial') break;
    }
  } else {
    await strategy.runToCompletion();
  }

  return { map, archetype: resolvedArchetype };
}
