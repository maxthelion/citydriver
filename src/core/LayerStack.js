/**
 * Named dictionary of Grid2Ds + structured data.
 * Container for all world state at a given scale (regional or city).
 */

export class LayerStack {
  constructor() {
    this._grids = new Map();
    this._data = new Map();
  }

  /**
   * Store a named Grid2D layer.
   */
  setGrid(name, grid) {
    this._grids.set(name, grid);
    return this;
  }

  /**
   * Retrieve a named Grid2D layer.
   * @returns {import('./Grid2D.js').Grid2D | undefined}
   */
  getGrid(name) {
    return this._grids.get(name);
  }

  /**
   * Check if a grid layer exists.
   */
  hasGrid(name) {
    return this._grids.has(name);
  }

  /**
   * Store arbitrary structured data (arrays, objects, etc.).
   */
  setData(name, value) {
    this._data.set(name, value);
    return this;
  }

  /**
   * Retrieve structured data.
   */
  getData(name) {
    return this._data.get(name);
  }

  /**
   * Check if a data entry exists.
   */
  hasData(name) {
    return this._data.has(name);
  }

  /**
   * List all grid layer names.
   */
  gridKeys() {
    return [...this._grids.keys()];
  }

  /**
   * List all data entry names.
   */
  dataKeys() {
    return [...this._data.keys()];
  }

  /**
   * All keys (grids + data).
   */
  keys() {
    return [...this._grids.keys(), ...this._data.keys()];
  }

  /**
   * Merge another LayerStack into this one. Overwrites on conflict.
   */
  merge(other) {
    for (const [k, v] of other._grids) this._grids.set(k, v);
    for (const [k, v] of other._data) this._data.set(k, v);
    return this;
  }
}
