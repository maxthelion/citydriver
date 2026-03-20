/**
 * PipelineRunner — executes a generator-based pipeline with hook support.
 *
 * The generator yields step descriptors: { id, fn }
 * The runner executes fn(), fires hooks before/after, and advances on demand.
 *
 * Usage:
 *   const runner = new PipelineRunner(cityPipeline(map, archetype))
 *     .addHook({ onAfter(id, map, ms) { timingLog.push({ id, ms }); } })
 *     .addHook({ onAfter(id, map) { invariantChecker.check(id, map); } });
 *
 *   while (runner.advance()) {}   // run to completion
 *   // or: runner.advance()       // one step at a time (for UI tick-by-tick)
 */

export class PipelineRunner {
  /**
   * @param {Generator} gen - Generator that yields step descriptors
   */
  constructor(gen) {
    this._gen = gen;
    this._done = false;
    this._lastResult = null;
    this.hooks = [];
    /** @type {string|null} Current step ID (set during advance()) */
    this.currentStep = null;
  }

  /**
   * Advance by one step.
   *
   * Returns `true` (boolean) when the step function is synchronous, or a
   * `Promise<true>` when the step function is async.  In both cases a falsy
   * value (false) means the pipeline is complete.
   *
   * Callers that only run in non-GPU environments (Node.js, tests) always
   * receive a plain boolean and need no changes.  GPU-aware callers must
   * handle the Promise case:
   *
   *   const result = runner.advance();
   *   const more = (result instanceof Promise) ? await result : result;
   *
   * @returns {boolean | Promise<boolean>}
   */
  advance() {
    if (this._done) return false;

    const { value: descriptor, done } = this._gen.next(this._lastResult);
    if (done) { this._done = true; return false; }

    this.currentStep = descriptor.id;
    const t0 = performance.now();
    for (const h of this.hooks) h.onBefore?.(descriptor.id);

    const result = descriptor.fn();

    if (result instanceof Promise) {
      // Async step function (e.g. GPU compute) — return a Promise that resolves
      // to true once the step has finished, preserving the hook contract.
      return result.then(res => {
        this._lastResult = res;
        const ms = performance.now() - t0;
        for (const h of this.hooks) h.onAfter?.(descriptor.id, this._lastResult, ms);
        return true;
      });
    }

    // Synchronous path — unchanged behaviour.
    this._lastResult = result;
    const ms = performance.now() - t0;
    for (const h of this.hooks) h.onAfter?.(descriptor.id, this._lastResult, ms);
    return true;
  }

  /**
   * Run to completion. Async-aware: handles pipelines that contain GPU steps.
   * In the CPU-only case (no async steps), resolves synchronously via microtask.
   * @returns {Promise<void>}
   */
  async runToCompletion() {
    let more = true;
    while (more) {
      const result = this.advance();
      more = (result instanceof Promise) ? await result : result;
    }
  }

  /**
   * Skip N steps without executing their fn(). Used by CompareArchetypesScreen to
   * fast-forward past shared pipeline steps when the map already has their results
   * from a cloned shared strategy.
   * @param {number} n
   * @returns {this}
   */
  skipSteps(n) {
    for (let i = 0; i < n; i++) {
      if (this._done) break;
      const { value: descriptor, done } = this._gen.next(this._lastResult);
      if (done) { this._done = true; break; }
      this.currentStep = descriptor.id;
      // Don't call descriptor.fn() — map already has results from the shared strategy.
      this._lastResult = undefined;
    }
    return this;
  }

  /**
   * Add a hook. Hooks fire before/after every step.
   * @param {{ onBefore?: (id: string) => void, onAfter?: (id: string, result: any, ms: number) => void }} hook
   * @returns {this}
   */
  addHook(hook) {
    this.hooks.push(hook);
    return this;
  }

  get done() { return this._done; }
}

/**
 * Create a step descriptor.
 * @param {string} id - Step name (e.g. 'skeleton', 'growth-3:influence')
 * @param {() => any} fn - Function to execute
 */
export function step(id, fn) {
  return { id, fn };
}
