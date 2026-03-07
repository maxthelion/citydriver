import { DesireLines } from './desireLines.js';

/**
 * Create a composite strategy class: desire lines first, then a secondary strategy.
 * The secondary strategy skips tick 1 (skeleton) since desire lines already built it.
 *
 * @param {Function} SecondaryClass - Strategy class with constructor(map) and tick()
 * @returns {Function} Composite strategy class
 */
export function desireLinesThen(SecondaryClass) {
  return class DesireLinesThen {
    constructor(map) {
      this.map = map;
      this._desireLines = new DesireLines(map);
      this._secondary = null;
      this._desireDone = false;
    }

    tick() {
      // Phase 1: desire lines (skeleton + 2 accumulation passes)
      if (!this._desireDone) {
        const more = this._desireLines.tick();
        if (!more) {
          this._desireDone = true;
          // Create secondary strategy — it will see the existing roads/graph
          this._secondary = new SecondaryClass(this.map);
          // Skip its tick 1 (skeleton) since we already have roads
          this._secondary._tick = 1;
        }
        return true;
      }

      // Phase 2: secondary strategy
      return this._secondary.tick();
    }
  };
}
