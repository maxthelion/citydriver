/**
 * Seeded pseudo-random number generator using the mulberry32 algorithm.
 * Provides deterministic random sequences for reproducible procedural generation.
 */
export class SeededRandom {
  /**
   * @param {number} seed - Integer seed value
   */
  constructor(seed) {
    this._state = seed | 0; // coerce to 32-bit integer
  }

  /**
   * Returns a float in [0, 1) using the mulberry32 algorithm.
   * @returns {number}
   */
  next() {
    this._state |= 0;
    this._state = (this._state + 0x6d2b79f5) | 0;
    let t = Math.imul(this._state ^ (this._state >>> 15), 1 | this._state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns a float in [min, max).
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /**
   * Returns an integer in [min, max] inclusive.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Returns a random element from the array.
   * @param {Array} array
   * @returns {*}
   */
  pick(array) {
    return array[this.int(0, array.length - 1)];
  }

  /**
   * In-place Fisher-Yates shuffle. Returns the array for chaining.
   * @param {Array} array
   * @returns {Array}
   */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  }

  /**
   * Creates a new independent SeededRandom derived from the current state
   * and a string label. The parent's state is NOT advanced.
   * @param {string} label
   * @returns {SeededRandom}
   */
  fork(label) {
    // Hash the label string into a 32-bit integer
    let labelHash = 0;
    for (let i = 0; i < label.length; i++) {
      labelHash = ((labelHash << 5) - labelHash + label.charCodeAt(i)) | 0;
    }
    // Combine current state with label hash to produce a new seed
    const newSeed = (this._state ^ labelHash) | 0;
    return new SeededRandom(newSeed);
  }
}
