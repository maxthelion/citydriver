import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../../src/core/rng.js';

describe('SeededRandom', () => {
  describe('determinism', () => {
    it('same seed produces identical sequence', () => {
      const a = new SeededRandom(42);
      const b = new SeededRandom(42);
      for (let i = 0; i < 100; i++) {
        expect(a.next()).toBe(b.next());
      }
    });

    it('different seeds produce different sequences', () => {
      const a = new SeededRandom(42);
      const b = new SeededRandom(99);
      let same = 0;
      for (let i = 0; i < 100; i++) {
        if (a.next() === b.next()) same++;
      }
      expect(same).toBeLessThan(5); // extremely unlikely to have many collisions
    });
  });

  describe('next()', () => {
    it('returns values in [0, 1)', () => {
      const rng = new SeededRandom(123);
      for (let i = 0; i < 10000; i++) {
        const v = rng.next();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });
  });

  describe('range()', () => {
    it('returns values in [min, max)', () => {
      const rng = new SeededRandom(456);
      for (let i = 0; i < 10000; i++) {
        const v = rng.range(5, 10);
        expect(v).toBeGreaterThanOrEqual(5);
        expect(v).toBeLessThan(10);
      }
    });

    it('works with negative ranges', () => {
      const rng = new SeededRandom(789);
      for (let i = 0; i < 1000; i++) {
        const v = rng.range(-10, -5);
        expect(v).toBeGreaterThanOrEqual(-10);
        expect(v).toBeLessThan(-5);
      }
    });
  });

  describe('int()', () => {
    it('returns integers in [min, max] inclusive', () => {
      const rng = new SeededRandom(101);
      const seen = new Set();
      for (let i = 0; i < 10000; i++) {
        const v = rng.int(1, 6);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(6);
        seen.add(v);
      }
      // Should see all values 1-6
      for (let i = 1; i <= 6; i++) {
        expect(seen.has(i)).toBe(true);
      }
    });

    it('works when min === max', () => {
      const rng = new SeededRandom(202);
      for (let i = 0; i < 100; i++) {
        expect(rng.int(5, 5)).toBe(5);
      }
    });
  });

  describe('pick()', () => {
    it('returns an element from the array', () => {
      const rng = new SeededRandom(303);
      const items = ['a', 'b', 'c', 'd'];
      for (let i = 0; i < 100; i++) {
        expect(items).toContain(rng.pick(items));
      }
    });

    it('eventually picks all elements', () => {
      const rng = new SeededRandom(404);
      const items = [1, 2, 3];
      const seen = new Set();
      for (let i = 0; i < 1000; i++) {
        seen.add(rng.pick(items));
      }
      expect(seen.size).toBe(3);
    });
  });

  describe('shuffle()', () => {
    it('returns the same array reference', () => {
      const rng = new SeededRandom(505);
      const arr = [1, 2, 3, 4, 5];
      const result = rng.shuffle(arr);
      expect(result).toBe(arr);
    });

    it('contains all original elements', () => {
      const rng = new SeededRandom(606);
      const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      rng.shuffle(arr);
      expect(arr.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('is deterministic', () => {
      const a = new SeededRandom(707);
      const b = new SeededRandom(707);
      const arr1 = [1, 2, 3, 4, 5];
      const arr2 = [1, 2, 3, 4, 5];
      a.shuffle(arr1);
      b.shuffle(arr2);
      expect(arr1).toEqual(arr2);
    });
  });

  describe('fork()', () => {
    it('creates an independent RNG with different sequence', () => {
      const parent = new SeededRandom(808);
      const child = parent.fork('terrain');
      // Child should produce different values than parent
      const parentVals = [];
      const childVals = [];
      for (let i = 0; i < 20; i++) {
        parentVals.push(parent.next());
        childVals.push(child.next());
      }
      // Very unlikely to be identical
      expect(parentVals).not.toEqual(childVals);
    });

    it('does not advance the parent state', () => {
      const parent1 = new SeededRandom(909);
      const parent2 = new SeededRandom(909);

      // Parent1 forks a child and consumes child values
      const child = parent1.fork('buildings');
      for (let i = 0; i < 100; i++) {
        child.next(); // consume child values
      }

      // Parent1 and parent2 should still be in sync
      // since fork() does not advance parent state
      expect(parent1.next()).toBe(parent2.next());
      expect(parent1.next()).toBe(parent2.next());
      expect(parent1.next()).toBe(parent2.next());
    });

    it('different labels produce different sequences', () => {
      const rng = new SeededRandom(1010);
      const a = rng.fork('terrain');
      const b = rng.fork('buildings');
      let same = 0;
      for (let i = 0; i < 100; i++) {
        if (a.next() === b.next()) same++;
      }
      expect(same).toBeLessThan(5);
    });

    it('same label from same state produces identical sequence', () => {
      const rng1 = new SeededRandom(1111);
      const rng2 = new SeededRandom(1111);
      const a = rng1.fork('roads');
      const b = rng2.fork('roads');
      for (let i = 0; i < 50; i++) {
        expect(a.next()).toBe(b.next());
      }
    });
  });

  describe('distribution', () => {
    it('mean of 10000 samples is approximately 0.5', () => {
      const rng = new SeededRandom(1212);
      let sum = 0;
      const n = 10000;
      for (let i = 0; i < n; i++) {
        sum += rng.next();
      }
      const mean = sum / n;
      expect(mean).toBeGreaterThan(0.45);
      expect(mean).toBeLessThan(0.55);
    });
  });
});
