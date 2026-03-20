/**
 * Shared pipeline utilities for experiment render scripts.
 *
 * These run in Node.js (no WebGPU), so strategy.tick() always returns
 * a synchronous boolean — no await needed.
 */

/**
 * Advance a LandFirstDevelopment strategy until the named pipeline step
 * completes.  Stops immediately after the step whose id matches stepId.
 *
 * Common stop points:
 *   'skeleton'    — after skeleton roads only
 *   'zones'       — after all zone extraction (including zone-boundary + zones-refine)
 *   'spatial'     — after spatial layers (centrality, waterfrontness, edgeness, …)
 *   'connect'     — full pipeline complete
 *
 * The step id matches runner.currentStep which reflects the actual pipeline
 * step name — conditional steps (zone-boundary, zones-refine) are handled
 * automatically; no hardcoded tick counts needed.
 *
 * @param {import('../src/city/strategies/landFirstDevelopment.js').LandFirstDevelopment} strategy
 * @param {string} stepId
 */
export function runToStep(strategy, stepId) {
  while (!strategy.done) {
    strategy.tick();
    if (strategy.runner.currentStep === stepId) break;
  }
}

/**
 * Run the pipeline until it reaches any step matching a predicate.
 * @param {object} strategy
 * @param {(stepId: string) => boolean} pred
 */
export function runUntil(strategy, pred) {
  while (!strategy.done) {
    strategy.tick();
    if (pred(strategy.runner.currentStep)) break;
  }
}
