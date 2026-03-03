import { describe, it, expect, beforeAll } from 'vitest';
import { PerlinNoise } from '../src/noise.js';
import { generateHeightmap, sampleHeightmap, TERRAIN_SIZE } from '../src/heightmap.js';

const SEED = 12345;

describe('Car ground check', () => {
  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);
  });

  it('sampleHeightmap returns consistent values (same call twice = same result)', () => {
    for (let i = 0; i < 100; i++) {
      const x = (Math.random() - 0.5) * 800;
      const z = (Math.random() - 0.5) * 800;
      const h1 = sampleHeightmap(x, z);
      const h2 = sampleHeightmap(x, z);
      expect(h1).toBe(h2);
    }
  });

  it('sampleHeightmap values are within terrain bounds', () => {
    for (let i = 0; i < 100; i++) {
      const x = (Math.random() - 0.5) * 800;
      const z = (Math.random() - 0.5) * 800;
      const h = sampleHeightmap(x, z);
      expect(typeof h).toBe('number');
      expect(Number.isFinite(h)).toBe(true);
      // Height should be reasonable (not NaN, not infinite, within ~80 unit range)
      expect(h).toBeGreaterThan(-80);
      expect(h).toBeLessThan(80);
    }
  });

  it('sampleHeightmap is smooth (nearby points have similar heights)', () => {
    for (let i = 0; i < 50; i++) {
      const x = (Math.random() - 0.5) * 800;
      const z = (Math.random() - 0.5) * 800;
      const h1 = sampleHeightmap(x, z);
      const h2 = sampleHeightmap(x + 0.1, z);
      const h3 = sampleHeightmap(x, z + 0.1);
      // 0.1 unit apart should not differ by more than ~1 unit
      expect(Math.abs(h1 - h2)).toBeLessThan(2);
      expect(Math.abs(h1 - h3)).toBeLessThan(2);
    }
  });

  it('sampleHeightmap handles edge positions', () => {
    const half = TERRAIN_SIZE / 2;
    // Test corners
    for (const [x, z] of [[-half, -half], [half, half], [-half, half], [half, -half], [0, 0]]) {
      const h = sampleHeightmap(x, z);
      expect(typeof h).toBe('number');
      expect(Number.isFinite(h)).toBe(true);
    }
  });
});
