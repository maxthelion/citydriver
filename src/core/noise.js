/**
 * Seeded 2D Perlin noise with fractional Brownian motion (fBm).
 */
import { SeededRandom } from './rng.js';

// Standard 2D Perlin gradient vectors (12 directions, evenly spaced)
const GRAD2 = [
  { x:  1, z:  0 },
  { x: -1, z:  0 },
  { x:  0, z:  1 },
  { x:  0, z: -1 },
  { x:  1, z:  1 },
  { x: -1, z:  1 },
  { x:  1, z: -1 },
  { x: -1, z: -1 },
  { x:  1, z:  0.5 },
  { x: -1, z:  0.5 },
  { x:  0.5, z:  1 },
  { x:  0.5, z: -1 },
];

// Normalize the gradient vectors
for (const g of GRAD2) {
  const len = Math.sqrt(g.x * g.x + g.z * g.z);
  g.x /= len;
  g.z /= len;
}

/**
 * Perlin fade function: 6t^5 - 15t^4 + 10t^3
 * @param {number} t
 * @returns {number}
 */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export class PerlinNoise {
  /**
   * @param {SeededRandom} rng - Seeded random number generator for building permutation table
   */
  constructor(rng) {
    // Build permutation table: 0-255 shuffled
    const perm = new Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    rng.shuffle(perm);

    // Double the table for wrapping (avoids modulo in hot path)
    this._perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this._perm[i] = perm[i & 255];
    }
  }

  /**
   * 2D Perlin noise. Returns a value in approximately [-1, 1].
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  noise2D(x, y) {
    const perm = this._perm;

    // Grid cell coordinates
    const xi = Math.floor(x);
    const yi = Math.floor(y);

    // Fractional position within cell
    const xf = x - xi;
    const yf = y - yi;

    // Wrap grid coordinates to 0-255
    const X = xi & 255;
    const Y = yi & 255;

    // Hash the 4 corners to gradient indices
    const g00 = GRAD2[perm[perm[X] + Y] % 12];
    const g10 = GRAD2[perm[perm[X + 1] + Y] % 12];
    const g01 = GRAD2[perm[perm[X] + Y + 1] % 12];
    const g11 = GRAD2[perm[perm[X + 1] + Y + 1] % 12];

    // Dot products of gradients with distance vectors
    const n00 = g00.x * xf + g00.z * yf;
    const n10 = g10.x * (xf - 1) + g10.z * yf;
    const n01 = g01.x * xf + g01.z * (yf - 1);
    const n11 = g11.x * (xf - 1) + g11.z * (yf - 1);

    // Fade curves
    const u = fade(xf);
    const v = fade(yf);

    // Bilinear interpolation
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return nx0 + v * (nx1 - nx0);
  }

  /**
   * Fractional Brownian motion: sum of multiple octaves of noise.
   * @param {number} x
   * @param {number} y
   * @param {object} [options]
   * @param {number} [options.octaves=6]
   * @param {number} [options.lacunarity=2] - Frequency multiplier per octave
   * @param {number} [options.persistence=0.5] - Amplitude multiplier per octave
   * @param {number} [options.amplitude=1] - Initial amplitude
   * @param {number} [options.frequency=1] - Initial frequency
   * @returns {number}
   */
  fbm(x, y, options = {}) {
    const {
      octaves = 6,
      lacunarity = 2,
      persistence = 0.5,
      amplitude: initAmplitude = 1,
      frequency: initFrequency = 1,
    } = options;

    let value = 0;
    let amplitude = initAmplitude;
    let frequency = initFrequency;

    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.noise2D(x * frequency, y * frequency);
      amplitude *= persistence;
      frequency *= lacunarity;
    }

    return value;
  }
}
