/**
 * Heightmap backed by Float32Array with bilinear interpolation.
 * Uses world-space coordinates (x, z) with configurable cell size.
 */
import { lerp } from './math.js';

export class Heightmap {
  /**
   * @param {number} gridWidth - Number of vertices along x (e.g. 1001 for 1000 cells)
   * @param {number} gridHeight - Number of vertices along z
   * @param {number} cellSize - World units per cell
   */
  constructor(gridWidth, gridHeight, cellSize) {
    this._gridWidth = gridWidth;
    this._gridHeight = gridHeight;
    this._cellSize = cellSize;
    this._worldWidth = (gridWidth - 1) * cellSize;
    this._worldHeight = (gridHeight - 1) * cellSize;
    this._data = new Float32Array(gridWidth * gridHeight);
    this._frozen = false;
  }

  /** Number of grid vertices along x. */
  get width() {
    return this._gridWidth;
  }

  /** Number of grid vertices along z. */
  get height() {
    return this._gridHeight;
  }

  /** World extent along x. */
  get worldWidth() {
    return this._worldWidth;
  }

  /** World extent along z. */
  get worldHeight() {
    return this._worldHeight;
  }

  /** World units per grid cell. */
  get cellSize() {
    return this._cellSize;
  }

  /** Whether the heightmap has been frozen (read-only). */
  get isFrozen() {
    return this._frozen;
  }

  /**
   * Direct grid access. Coordinates are clamped to valid range.
   * @param {number} gx - Grid x index
   * @param {number} gz - Grid z index
   * @returns {number}
   */
  get(gx, gz) {
    gx = Math.max(0, Math.min(this._gridWidth - 1, gx | 0));
    gz = Math.max(0, Math.min(this._gridHeight - 1, gz | 0));
    return this._data[gz * this._gridWidth + gx];
  }

  /**
   * Direct grid write. Throws if frozen.
   * @param {number} gx - Grid x index
   * @param {number} gz - Grid z index
   * @param {number} value - Height value
   */
  set(gx, gz, value) {
    if (this._frozen) {
      throw new Error('Cannot set values on a frozen heightmap');
    }
    gx = gx | 0;
    gz = gz | 0;
    if (gx < 0 || gx >= this._gridWidth || gz < 0 || gz >= this._gridHeight) {
      return; // silently ignore out-of-bounds writes
    }
    this._data[gz * this._gridWidth + gx] = value;
  }

  /**
   * Interpolate height at world coordinates using the same triangle split
   * as the terrain mesh, so that sampled values exactly match the rendered
   * surface.  Each quad is split along the (0,1)→(1,0) diagonal:
   *   Triangle 1 (fx + fz ≤ 1): vertices (0,0), (1,0), (0,1)
   *   Triangle 2 (fx + fz > 1): vertices (1,0), (0,1), (1,1)
   *
   * @param {number} worldX
   * @param {number} worldZ
   * @returns {number}
   */
  sample(worldX, worldZ) {
    const { gx, gz } = this.worldToGrid(worldX, worldZ);

    // Integer and fractional parts
    const gxi = Math.floor(gx);
    const gzi = Math.floor(gz);
    const fx = gx - gxi;
    const fz = gz - gzi;

    // Clamp integer indices to valid range for sampling 4 corners
    const x0 = Math.max(0, Math.min(this._gridWidth - 1, gxi));
    const x1 = Math.max(0, Math.min(this._gridWidth - 1, gxi + 1));
    const z0 = Math.max(0, Math.min(this._gridHeight - 1, gzi));
    const z1 = Math.max(0, Math.min(this._gridHeight - 1, gzi + 1));

    const h00 = this._data[z0 * this._gridWidth + x0];
    const h10 = this._data[z0 * this._gridWidth + x1];
    const h01 = this._data[z1 * this._gridWidth + x0];
    const h11 = this._data[z1 * this._gridWidth + x1];

    // Barycentric interpolation matching terrain mesh triangle split
    if (fx + fz <= 1) {
      // Triangle 1: (0,0), (1,0), (0,1)
      return h00 + fx * (h10 - h00) + fz * (h01 - h00);
    } else {
      // Triangle 2: (1,0), (0,1), (1,1)
      return h10 + (1 - fx) * (h01 - h10) + (fx + fz - 1) * (h11 - h10);
    }
  }

  /**
   * Surface normal at world coordinates via central finite differences.
   * Returns a normalized vector {nx, ny, nz}.
   * @param {number} worldX
   * @param {number} worldZ
   * @returns {{nx: number, ny: number, nz: number}}
   */
  sampleNormal(worldX, worldZ) {
    const eps = this._cellSize;

    const hL = this.sample(worldX - eps, worldZ);
    const hR = this.sample(worldX + eps, worldZ);
    const hD = this.sample(worldX, worldZ - eps);
    const hU = this.sample(worldX, worldZ + eps);

    // Gradient: dh/dx and dh/dz
    const nx = hL - hR;  // points in -x when slope goes up in +x
    const ny = 2 * eps;   // scale factor from finite difference spacing
    const nz = hD - hU;  // points in -z when slope goes up in +z

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return {
      nx: nx / len,
      ny: ny / len,
      nz: nz / len,
    };
  }

  /**
   * Converts world coordinates to floating-point grid coordinates.
   * @param {number} worldX
   * @param {number} worldZ
   * @returns {{gx: number, gz: number}}
   */
  worldToGrid(worldX, worldZ) {
    return {
      gx: worldX / this._cellSize,
      gz: worldZ / this._cellSize,
    };
  }

  /**
   * Converts grid coordinates to world coordinates.
   * @param {number} gx
   * @param {number} gz
   * @returns {{x: number, z: number}}
   */
  gridToWorld(gx, gz) {
    return {
      x: gx * this._cellSize,
      z: gz * this._cellSize,
    };
  }

  /**
   * Freezes the heightmap, preventing further set() calls.
   */
  freeze() {
    this._frozen = true;
  }
}
