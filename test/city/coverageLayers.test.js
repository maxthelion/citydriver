import { describe, it, expect } from 'vitest';
import { separableBoxBlur, applyHashNoise, enforcePriority } from '../../src/city/coverageLayers.js';

describe('separableBoxBlur', () => {
  it('preserves total energy (sum of values)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    grid[5 * w + 5] = 1.0;
    const sumBefore = grid.reduce((a, b) => a + b, 0);
    const result = separableBoxBlur(grid, w, h, 2);
    const sumAfter = result.reduce((a, b) => a + b, 0);
    expect(sumAfter).toBeCloseTo(sumBefore, 4);
  });

  it('spreads a single cell into surrounding area', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    grid[5 * w + 5] = 1.0;
    const result = separableBoxBlur(grid, w, h, 2);
    expect(result[5 * w + 5]).toBeLessThan(1.0);
    expect(result[5 * w + 5]).toBeGreaterThan(0);
    expect(result[5 * w + 6]).toBeGreaterThan(0);
    expect(result[6 * w + 5]).toBeGreaterThan(0);
  });

  it('returns all zeros for all-zero input', () => {
    const w = 8, h = 8;
    const grid = new Float32Array(w * h);
    const result = separableBoxBlur(grid, w, h, 3);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('returns uniform value for all-one input', () => {
    const w = 8, h = 8;
    const grid = new Float32Array(w * h).fill(1.0);
    const result = separableBoxBlur(grid, w, h, 3);
    for (let i = 0; i < w * h; i++) {
      expect(result[i]).toBeCloseTo(1.0, 4);
    }
  });
});

describe('applyHashNoise', () => {
  it('does not perturb cells at 0 or 1 (parabolic scaling)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    grid[0] = 0.0;
    grid[1] = 1.0;
    const result = applyHashNoise(grid, w, h, 0.2, 42);
    expect(result[0]).toBe(0.0);
    expect(result[1]).toBe(1.0);
  });

  it('perturbs cells in the middle range', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h).fill(0.5);
    const result = applyHashNoise(grid, w, h, 0.2, 42);
    let anyDifferent = false;
    for (let i = 0; i < w * h; i++) {
      if (Math.abs(result[i] - 0.5) > 0.001) anyDifferent = true;
    }
    expect(anyDifferent).toBe(true);
  });

  it('keeps all values in [0, 1]', () => {
    const w = 20, h = 20;
    const grid = new Float32Array(w * h).fill(0.5);
    const result = applyHashNoise(grid, w, h, 0.5, 99);
    for (let i = 0; i < w * h; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic (same seed = same result)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h).fill(0.5);
    const a = applyHashNoise(grid, w, h, 0.2, 42);
    const b = applyHashNoise(grid, w, h, 0.2, 42);
    for (let i = 0; i < w * h; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });
});

describe('enforcePriority', () => {
  it('ensures layers sum to <= 1.0 at every cell', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.6) },
      { data: new Float32Array(n).fill(0.6) },
      { data: new Float32Array(n).fill(0.6) },
    ];
    enforcePriority(layers, w, h);
    for (let i = 0; i < n; i++) {
      const sum = layers.reduce((s, l) => s + l.data[i], 0);
      expect(sum).toBeLessThanOrEqual(1.001);
    }
  });

  it('higher-priority layer claims space first', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.8) },
      { data: new Float32Array(n).fill(0.8) },
    ];
    enforcePriority(layers, w, h);
    expect(layers[0].data[0]).toBeCloseTo(0.8);
    expect(layers[1].data[0]).toBeCloseTo(0.2);
  });

  it('does nothing when layers already fit within budget', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.3) },
      { data: new Float32Array(n).fill(0.3) },
    ];
    enforcePriority(layers, w, h);
    expect(layers[0].data[0]).toBeCloseTo(0.3);
    expect(layers[1].data[0]).toBeCloseTo(0.3);
  });
});
