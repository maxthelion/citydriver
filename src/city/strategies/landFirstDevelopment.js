/**
 * Land-First Development strategy.
 *
 * Thin wrapper around PipelineRunner + cityPipeline. Each call to tick()
 * advances the pipeline by one named step.
 *
 * Step sequence (see cityPipeline.js):
 *   skeleton → land-value → zones → spatial
 *   → growth-1 … growth-N  (organic, archetype-driven)
 *   → connect
 *
 * Backward compat: CompareArchetypesScreen sets strategy._tick = N to fast-forward
 * past shared steps whose results already exist on the cloned map. This calls
 * runner.skipSteps(N) without re-executing the shared pipeline functions.
 *
 * Spec: specs/v5/next-steps.md § Step 1
 */

import { PipelineRunner } from '../pipeline/PipelineRunner.js';
import { cityPipeline } from '../pipeline/cityPipeline.js';

export class LandFirstDevelopment {
  /**
   * @param {import('../../core/FeatureMap.js').FeatureMap} map
   * @param {{ archetype?: object }} options
   */
  constructor(map, options = {}) {
    this.map = map;
    this.archetype = options.archetype || null;
    this._runner = new PipelineRunner(cityPipeline(map, this.archetype));
    this._stepsRun = 0;
  }

  /**
   * Advance the pipeline by one step.
   * @returns {boolean} true if a step was executed (more may remain), false when complete.
   */
  tick() {
    const ran = this._runner.advance();
    if (ran) this._stepsRun++;
    return ran;
  }

  /**
   * Backward-compat setter: CompareArchetypesScreen sets strategy._tick = sharedTicks
   * to skip past the shared early steps (skeleton, land-value, zones, spatial).
   * Advances the generator without executing step functions.
   */
  set _tick(n) {
    const toSkip = n - this._stepsRun;
    if (toSkip > 0) {
      this._runner.skipSteps(toSkip);
      this._stepsRun = n;
    }
  }

  get _tick() {
    return this._stepsRun;
  }

  /** True when all pipeline steps are complete. */
  get done() {
    return this._runner.done;
  }

  /** Expose the runner for hook attachment (timing, invariants, etc.). */
  get runner() {
    return this._runner;
  }
}
