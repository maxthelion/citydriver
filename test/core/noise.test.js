import { describe, it, expect } from 'vitest';
import { PerlinNoise } from '../../src/core/noise.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('PerlinNoise', () => {
  it('produces deterministic values', () => {
    const a = new PerlinNoise(new SeededRandom(42));
    const b = new PerlinNoise(new SeededRandom(42));
    expect(a.noise2D(1.5, 2.5)).toBe(b.noise2D(1.5, 2.5));
  });

  it('noise2D returns values in approximately [-1, 1]', () => {
    const noise = new PerlinNoise(new SeededRandom(42));
    let min = Infinity, max = -Infinity;
    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 50; y++) {
        const v = noise.noise2D(x * 0.1, y * 0.1);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    expect(min).toBeGreaterThan(-1.5);
    expect(max).toBeLessThan(1.5);
  });

  it('noise2D is 0 at integer coordinates', () => {
    // Perlin noise at integer coords should be near 0 (dot product with zero vector)
    const noise = new PerlinNoise(new SeededRandom(42));
    expect(Math.abs(noise.noise2D(0, 0))).toBeLessThan(0.01);
    expect(Math.abs(noise.noise2D(1, 0))).toBeLessThan(0.01);
  });

  it('fbm produces smooth varying output', () => {
    const noise = new PerlinNoise(new SeededRandom(42));
    const v1 = noise.fbm(0.5, 0.5);
    const v2 = noise.fbm(0.51, 0.5);
    // Values at close points should be similar
    expect(Math.abs(v1 - v2)).toBeLessThan(0.1);
  });

  it('fbm respects octave and frequency parameters', () => {
    const noise = new PerlinNoise(new SeededRandom(42));
    const v1 = noise.fbm(5.3, 7.1, { octaves: 1 });
    const v2 = noise.fbm(5.3, 7.1, { octaves: 6 });
    // Different octave counts should generally produce different values
    // (not always, but almost certainly with these coords)
    expect(v1).not.toBe(v2);
  });
});
