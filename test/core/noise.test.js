import { describe, it, expect } from 'vitest';
import { PerlinNoise } from '../../src/core/noise.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('PerlinNoise', () => {
  describe('determinism', () => {
    it('same seed produces identical noise values', () => {
      const noise1 = new PerlinNoise(new SeededRandom(42));
      const noise2 = new PerlinNoise(new SeededRandom(42));

      for (let i = 0; i < 50; i++) {
        const x = i * 0.37;
        const y = i * 0.53;
        expect(noise1.noise2D(x, y)).toBe(noise2.noise2D(x, y));
      }
    });

    it('different seeds produce different noise values', () => {
      const noise1 = new PerlinNoise(new SeededRandom(42));
      const noise2 = new PerlinNoise(new SeededRandom(99));

      let same = 0;
      for (let i = 0; i < 50; i++) {
        const x = i * 0.37 + 0.1;
        const y = i * 0.53 + 0.2;
        if (noise1.noise2D(x, y) === noise2.noise2D(x, y)) same++;
      }
      expect(same).toBeLessThan(5);
    });
  });

  describe('noise2D range', () => {
    it('returns values in [-1, 1] over many samples', () => {
      const noise = new PerlinNoise(new SeededRandom(123));
      let min = Infinity;
      let max = -Infinity;

      for (let i = 0; i < 10000; i++) {
        const x = (i % 100) * 0.1 + 0.05;
        const y = Math.floor(i / 100) * 0.1 + 0.05;
        const v = noise.noise2D(x, y);
        if (v < min) min = v;
        if (v > max) max = v;
      }

      expect(min).toBeGreaterThanOrEqual(-1);
      expect(max).toBeLessThanOrEqual(1);
    });
  });

  describe('spatial coherence', () => {
    it('nearby points have similar values', () => {
      const noise = new PerlinNoise(new SeededRandom(456));
      const delta = 0.01;
      let maxDiff = 0;

      for (let i = 0; i < 100; i++) {
        const x = i * 0.7 + 0.3;
        const y = i * 0.3 + 0.7;
        const v1 = noise.noise2D(x, y);
        const v2 = noise.noise2D(x + delta, y);
        const v3 = noise.noise2D(x, y + delta);
        maxDiff = Math.max(maxDiff, Math.abs(v1 - v2), Math.abs(v1 - v3));
      }

      // Nearby points should differ by much less than the full range
      expect(maxDiff).toBeLessThan(0.1);
    });

    it('distant points can differ significantly', () => {
      const noise = new PerlinNoise(new SeededRandom(789));
      let maxDiff = 0;

      for (let i = 0; i < 100; i++) {
        const x = i * 5.7;
        const y = i * 3.3;
        const v1 = noise.noise2D(x, y);
        const v2 = noise.noise2D(x + 50, y + 50);
        maxDiff = Math.max(maxDiff, Math.abs(v1 - v2));
      }

      // Over many distant pairs, we should see significant differences
      expect(maxDiff).toBeGreaterThan(0.1);
    });
  });

  describe('noise at integer coordinates', () => {
    it('returns finite values at integer coordinates', () => {
      const noise = new PerlinNoise(new SeededRandom(321));
      for (let x = 0; x < 10; x++) {
        for (let y = 0; y < 10; y++) {
          const v = noise.noise2D(x, y);
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    });
  });

  describe('fbm', () => {
    it('returns deterministic values', () => {
      const noise1 = new PerlinNoise(new SeededRandom(654));
      const noise2 = new PerlinNoise(new SeededRandom(654));

      expect(noise1.fbm(1.5, 2.5)).toBe(noise2.fbm(1.5, 2.5));
      expect(noise1.fbm(3.7, 8.2, { octaves: 4 }))
        .toBe(noise2.fbm(3.7, 8.2, { octaves: 4 }));
    });

    it('more octaves increases detail (higher variance at small scales)', () => {
      const noise = new PerlinNoise(new SeededRandom(987));
      const delta = 0.05;

      // Measure small-scale variation with 1 octave vs 6 octaves
      let var1 = 0;
      let var6 = 0;
      const n = 200;

      for (let i = 0; i < n; i++) {
        const x = i * 0.3 + 0.15;
        const y = i * 0.2 + 0.1;
        const a1 = noise.fbm(x, y, { octaves: 1 });
        const b1 = noise.fbm(x + delta, y, { octaves: 1 });
        var1 += (a1 - b1) * (a1 - b1);

        const a6 = noise.fbm(x, y, { octaves: 6 });
        const b6 = noise.fbm(x + delta, y, { octaves: 6 });
        var6 += (a6 - b6) * (a6 - b6);
      }

      // 6-octave fBm should have more small-scale variation than 1-octave
      expect(var6).toBeGreaterThan(var1);
    });

    it('respects frequency option', () => {
      const noise = new PerlinNoise(new SeededRandom(111));
      // At higher frequency, noise varies more rapidly
      const delta = 0.1;
      let varLow = 0;
      let varHigh = 0;
      const n = 200;

      for (let i = 0; i < n; i++) {
        const x = i * 0.5 + 0.25;
        const y = i * 0.3 + 0.15;

        const aLow = noise.fbm(x, y, { octaves: 1, frequency: 1 });
        const bLow = noise.fbm(x + delta, y, { octaves: 1, frequency: 1 });
        varLow += (aLow - bLow) * (aLow - bLow);

        const aHigh = noise.fbm(x, y, { octaves: 1, frequency: 4 });
        const bHigh = noise.fbm(x + delta, y, { octaves: 1, frequency: 4 });
        varHigh += (aHigh - bHigh) * (aHigh - bHigh);
      }

      expect(varHigh).toBeGreaterThan(varLow);
    });

    it('uses default options when none provided', () => {
      const noise = new PerlinNoise(new SeededRandom(222));
      // Should not throw
      const v = noise.fbm(1.0, 1.0);
      expect(Number.isFinite(v)).toBe(true);
    });
  });
});
