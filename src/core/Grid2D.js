/**
 * Generic 2D grid backed by a typed array.
 * Supports world<->grid coordinate transforms, interpolation, and functional iteration.
 */

const ARRAY_TYPES = {
  float32: Float32Array,
  uint8: Uint8Array,
  int32: Int32Array,
  int8: Int8Array,
  uint16: Uint16Array,
  float64: Float64Array,
};

export class Grid2D {
  /**
   * @param {number} width - Number of columns
   * @param {number} height - Number of rows
   * @param {object} [options]
   * @param {string} [options.type='float32'] - Typed array type
   * @param {number} [options.cellSize=1] - World units per cell
   * @param {number} [options.originX=0] - World X of grid origin (cell 0,0)
   * @param {number} [options.originZ=0] - World Z of grid origin (cell 0,0)
   * @param {number} [options.fill=0] - Initial fill value
   */
  constructor(width, height, options = {}) {
    const {
      type = 'float32',
      cellSize = 1,
      originX = 0,
      originZ = 0,
      fill = 0,
    } = options;

    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;
    this._type = type;

    const ArrayType = ARRAY_TYPES[type];
    if (!ArrayType) throw new Error(`Unknown array type: ${type}`);

    this.data = new ArrayType(width * height);
    if (fill !== 0) this.data.fill(fill);

    this._frozen = false;
  }

  /**
   * Get value at grid coordinates. Returns 0 for out-of-bounds.
   */
  get(gx, gz) {
    if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.height) return 0;
    return this.data[gz * this.width + gx];
  }

  /**
   * Set value at grid coordinates.
   */
  set(gx, gz, value) {
    if (this._frozen) throw new Error('Grid2D is frozen');
    if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.height) return;
    this.data[gz * this.width + gx] = value;
  }

  /**
   * Convert world coordinates to grid coordinates (fractional).
   */
  worldToGrid(wx, wz) {
    return {
      gx: (wx - this.originX) / this.cellSize,
      gz: (wz - this.originZ) / this.cellSize,
    };
  }

  /**
   * Convert grid coordinates to world coordinates.
   */
  gridToWorld(gx, gz) {
    return {
      x: this.originX + gx * this.cellSize,
      z: this.originZ + gz * this.cellSize,
    };
  }

  /**
   * Bilinear interpolation at fractional grid coordinates.
   */
  sample(gx, gz) {
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = x0 + 1;
    const z1 = z0 + 1;
    const fx = gx - x0;
    const fz = gz - z0;

    const v00 = this.get(x0, z0);
    const v10 = this.get(x1, z0);
    const v01 = this.get(x0, z1);
    const v11 = this.get(x1, z1);

    const top = v00 + (v10 - v00) * fx;
    const bot = v01 + (v11 - v01) * fx;
    return top + (bot - top) * fz;
  }

  /**
   * Sample at world coordinates using bilinear interpolation.
   */
  sampleWorld(wx, wz) {
    const { gx, gz } = this.worldToGrid(wx, wz);
    return this.sample(gx, gz);
  }

  /**
   * Iterate over every cell. Callback receives (gx, gz, value, index).
   */
  forEach(fn) {
    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        const idx = gz * this.width + gx;
        fn(gx, gz, this.data[idx], idx);
      }
    }
  }

  /**
   * Create a new Grid2D by transforming each cell value.
   * Callback: (value, gx, gz) => newValue
   */
  map(fn) {
    const result = new Grid2D(this.width, this.height, {
      type: this._type,
      cellSize: this.cellSize,
      originX: this.originX,
      originZ: this.originZ,
    });
    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        const idx = gz * this.width + gx;
        result.data[idx] = fn(this.data[idx], gx, gz);
      }
    }
    return result;
  }

  /**
   * Deep clone this grid.
   */
  clone() {
    const copy = new Grid2D(this.width, this.height, {
      type: this._type,
      cellSize: this.cellSize,
      originX: this.originX,
      originZ: this.originZ,
    });
    copy.data.set(this.data);
    return copy;
  }

  /**
   * Freeze this grid (prevent further writes).
   */
  freeze() {
    this._frozen = true;
    return this;
  }

  /**
   * Compute min and max values in the grid.
   */
  bounds() {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  /**
   * Fill entire grid with a value.
   */
  fill(value) {
    if (this._frozen) throw new Error('Grid2D is frozen');
    this.data.fill(value);
    return this;
  }
}
