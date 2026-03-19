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
   * Advance by one step. Returns true if more steps remain.
   * @returns {boolean}
   */
  advance() {
    if (this._done) return false;

    const { value: descriptor, done } = this._gen.next(this._lastResult);
    if (done) { this._done = true; return false; }

    this.currentStep = descriptor.id;

    const t0 = performance.now();
    for (const h of this.hooks) h.onBefore?.(descriptor.id);

    this._lastResult = descriptor.fn();

    const ms = performance.now() - t0;
    for (const h of this.hooks) h.onAfter?.(descriptor.id, this._lastResult, ms);

    return true;
  }

  /** Run to completion. */
  runToCompletion() {
    while (this.advance()) {}
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
