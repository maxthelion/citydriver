import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../../src/core/rng.js';

describe('SeededRandom', () => {
  it('produces deterministic sequences', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    for (let i = 0; i < 10; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('next returns values in [0, 1)', () => {
    const rng = new SeededRandom(123);
    for (let i = 0; i < 100; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('range returns values in [min, max)', () => {
    const rng = new SeededRandom(7);
    for (let i = 0; i < 100; i++) {
      const v = rng.range(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
    }
  });

  it('int returns integers in [min, max]', () => {
    const rng = new SeededRandom(99);
    for (let i = 0; i < 100; i++) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('pick returns an element from the array', () => {
    const rng = new SeededRandom(1);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 20; i++) {
      expect(arr).toContain(rng.pick(arr));
    }
  });

  it('shuffle is deterministic and preserves elements', () => {
    const rng = new SeededRandom(42);
    const arr = [1, 2, 3, 4, 5];
    rng.shuffle(arr);
    expect(arr.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('fork produces independent sequences', () => {
    const rng = new SeededRandom(42);
    const child1 = rng.fork('terrain');
    const child2 = rng.fork('rivers');
    // Different labels should produce different sequences
    const v1 = child1.next();
    const v2 = child2.next();
    expect(v1).not.toBe(v2);
  });

  it('fork does not advance parent state', () => {
    const rng = new SeededRandom(42);
    const before = rng.next();
    const rng2 = new SeededRandom(42);
    rng2.fork('test');
    const after = rng2.next();
    expect(before).toBe(after);
  });

  it('gaussian returns roughly normal distribution', () => {
    const rng = new SeededRandom(42);
    let sum = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) sum += rng.gaussian();
    const mean = sum / n;
    expect(Math.abs(mean)).toBeLessThan(0.2);
  });
});
