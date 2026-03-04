/**
 * Seeded 2D Perlin noise with fractional Brownian motion (fBm).
 */

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

for (const g of GRAD2) {
  const len = Math.sqrt(g.x * g.x + g.z * g.z);
  g.x /= len;
  g.z /= len;
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export class PerlinNoise {
  /**
   * @param {import('./rng.js').SeededRandom} rng
   */
  constructor(rng) {
    const perm = new Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    rng.shuffle(perm);

    this._perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this._perm[i] = perm[i & 255];
    }
  }

  /**
   * 2D Perlin noise. Returns a value in approximately [-1, 1].
   */
  noise2D(x, y) {
    const perm = this._perm;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;

    const g00 = GRAD2[perm[perm[X] + Y] % 12];
    const g10 = GRAD2[perm[perm[X + 1] + Y] % 12];
    const g01 = GRAD2[perm[perm[X] + Y + 1] % 12];
    const g11 = GRAD2[perm[perm[X + 1] + Y + 1] % 12];

    const n00 = g00.x * xf + g00.z * yf;
    const n10 = g10.x * (xf - 1) + g10.z * yf;
    const n01 = g01.x * xf + g01.z * (yf - 1);
    const n11 = g11.x * (xf - 1) + g11.z * (yf - 1);

    const u = fade(xf);
    const v = fade(yf);

    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return nx0 + v * (nx1 - nx0);
  }

  /**
   * Musgrave ridged multifractal noise.
   * Produces sharp ridges via signal squaring and octave feedback.
   */
  ridgedMultifractal(x, y, options = {}) {
    const {
      octaves = 5,
      lacunarity = 2.1,
      gain = 2.0,
      offset = 1.0,
      H = 0.9,
      frequency: initFrequency = 1,
      amplitude: initAmplitude = 1,
    } = options;

    // Precompute spectral weights: lacunarity^(-i*H) per octave
    // These must be independent of sampling frequency
    const weights = [];
    for (let i = 0; i < octaves; i++) {
      weights.push(Math.pow(lacunarity, -i * H));
    }

    let result = 0;
    let weight = 1;
    let freq = initFrequency;

    for (let i = 0; i < octaves; i++) {
      let signal = this.noise2D(x * freq, y * freq);
      signal = offset - Math.abs(signal);
      signal *= signal; // square for needle-sharp ridges
      signal *= weight;
      weight = Math.min(1, Math.max(0, signal * gain));
      result += signal * weights[i];
      freq *= lacunarity;
    }

    return result * initAmplitude;
  }

  /**
   * Fractional Brownian motion.
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
