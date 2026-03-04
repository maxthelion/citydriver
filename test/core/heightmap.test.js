import { describe, it, expect } from 'vitest';
import { Heightmap } from '../../src/core/heightmap.js';

describe('Heightmap', () => {
  describe('constructor and properties', () => {
    it('reports correct dimensions', () => {
      const hm = new Heightmap(101, 201, 5);
      expect(hm.width).toBe(101);
      expect(hm.height).toBe(201);
      expect(hm.worldWidth).toBe(500);   // (101-1) * 5
      expect(hm.worldHeight).toBe(1000); // (201-1) * 5
    });

    it('initializes all values to 0', () => {
      const hm = new Heightmap(10, 10, 1);
      for (let z = 0; z < 10; z++) {
        for (let x = 0; x < 10; x++) {
          expect(hm.get(x, z)).toBe(0);
        }
      }
    });
  });

  describe('get/set', () => {
    it('stores and retrieves values', () => {
      const hm = new Heightmap(5, 5, 1);
      hm.set(2, 3, 42);
      expect(hm.get(2, 3)).toBe(42);
    });

    it('clamps get() to bounds', () => {
      const hm = new Heightmap(5, 5, 1);
      hm.set(0, 0, 10);
      hm.set(4, 4, 99);

      // Negative coords should clamp to 0
      expect(hm.get(-1, -1)).toBe(10);
      // Over-bounds should clamp to max
      expect(hm.get(10, 10)).toBe(99);
    });

    it('silently ignores out-of-bounds set()', () => {
      const hm = new Heightmap(5, 5, 1);
      // Should not throw
      hm.set(-1, 0, 100);
      hm.set(0, -1, 100);
      hm.set(5, 0, 100);
      hm.set(0, 5, 100);
    });
  });

  describe('bilinear interpolation (sample)', () => {
    it('at grid points, sample() === get()', () => {
      const hm = new Heightmap(5, 5, 10);
      hm.set(2, 3, 42);
      // Grid point (2, 3) => world (20, 30)
      expect(hm.sample(20, 30)).toBe(42);
    });

    it('interpolates midpoint correctly', () => {
      const hm = new Heightmap(3, 3, 10);
      // Set 4 corners of one cell
      hm.set(0, 0, 0);
      hm.set(1, 0, 10);
      hm.set(0, 1, 20);
      hm.set(1, 1, 30);

      // Center of this cell at world (5, 5)
      // Expected: lerp(lerp(0, 10, 0.5), lerp(20, 30, 0.5), 0.5) = lerp(5, 25, 0.5) = 15
      expect(hm.sample(5, 5)).toBeCloseTo(15, 10);
    });

    it('interpolates along edges', () => {
      const hm = new Heightmap(3, 3, 10);
      hm.set(0, 0, 0);
      hm.set(1, 0, 10);
      hm.set(0, 1, 0);
      hm.set(1, 1, 10);

      // Midpoint along x at z=0: world (5, 0)
      expect(hm.sample(5, 0)).toBeCloseTo(5, 10);
    });

    it('clamps to edge values outside bounds (does not throw)', () => {
      const hm = new Heightmap(3, 3, 10);
      hm.set(0, 0, 5);
      hm.set(2, 2, 99);

      // Negative coordinates should clamp
      expect(() => hm.sample(-10, -10)).not.toThrow();
      expect(hm.sample(-10, -10)).toBe(5);

      // Beyond bounds should clamp
      expect(() => hm.sample(100, 100)).not.toThrow();
      expect(hm.sample(100, 100)).toBe(99);
    });
  });

  describe('coordinate conversion', () => {
    it('worldToGrid and gridToWorld are inverses', () => {
      const hm = new Heightmap(101, 101, 5);

      const { gx, gz } = hm.worldToGrid(50, 75);
      expect(gx).toBeCloseTo(10, 10);
      expect(gz).toBeCloseTo(15, 10);

      const { x, z } = hm.gridToWorld(10, 15);
      expect(x).toBeCloseTo(50, 10);
      expect(z).toBeCloseTo(75, 10);
    });

    it('roundtrips grid -> world -> grid', () => {
      const hm = new Heightmap(101, 101, 3);
      const origGx = 42;
      const origGz = 73;

      const { x, z } = hm.gridToWorld(origGx, origGz);
      const { gx, gz } = hm.worldToGrid(x, z);

      expect(gx).toBeCloseTo(origGx, 10);
      expect(gz).toBeCloseTo(origGz, 10);
    });

    it('roundtrips world -> grid -> world', () => {
      const hm = new Heightmap(101, 101, 7);
      const origX = 123.4;
      const origZ = 567.8;

      const { gx, gz } = hm.worldToGrid(origX, origZ);
      const { x, z } = hm.gridToWorld(gx, gz);

      expect(x).toBeCloseTo(origX, 10);
      expect(z).toBeCloseTo(origZ, 10);
    });
  });

  describe('freeze', () => {
    it('is not frozen initially', () => {
      const hm = new Heightmap(5, 5, 1);
      expect(hm.isFrozen).toBe(false);
    });

    it('becomes frozen after freeze()', () => {
      const hm = new Heightmap(5, 5, 1);
      hm.freeze();
      expect(hm.isFrozen).toBe(true);
    });

    it('set() throws after freeze()', () => {
      const hm = new Heightmap(5, 5, 1);
      hm.set(0, 0, 10);
      hm.freeze();
      expect(() => hm.set(0, 0, 20)).toThrow('frozen');
    });

    it('get() still works after freeze()', () => {
      const hm = new Heightmap(5, 5, 1);
      hm.set(2, 2, 42);
      hm.freeze();
      expect(hm.get(2, 2)).toBe(42);
    });

    it('sample() still works after freeze()', () => {
      const hm = new Heightmap(5, 5, 1);
      hm.set(1, 1, 10);
      hm.freeze();
      expect(hm.sample(1, 1)).toBe(10);
    });
  });

  describe('sampleNormal', () => {
    it('flat heightmap returns normal pointing up', () => {
      const hm = new Heightmap(11, 11, 1);
      // All zeros (default) = flat
      const n = hm.sampleNormal(5, 5);
      expect(n.nx).toBeCloseTo(0, 5);
      expect(n.ny).toBeCloseTo(1, 5);
      expect(n.nz).toBeCloseTo(0, 5);
    });

    it('normal is a unit vector', () => {
      const hm = new Heightmap(11, 11, 1);
      // Create a slope
      for (let z = 0; z < 11; z++) {
        for (let x = 0; x < 11; x++) {
          hm.set(x, z, x * 2); // slope of 2 along x
        }
      }
      const n = hm.sampleNormal(5, 5);
      const len = Math.sqrt(n.nx * n.nx + n.ny * n.ny + n.nz * n.nz);
      expect(len).toBeCloseTo(1, 5);
    });

    it('tilted heightmap has tilted normal', () => {
      const hm = new Heightmap(21, 21, 1);
      // Create a slope in the x direction: height = x
      for (let z = 0; z < 21; z++) {
        for (let x = 0; x < 21; x++) {
          hm.set(x, z, x);
        }
      }

      const n = hm.sampleNormal(10, 10);
      // Normal should tilt away from the slope (negative x component)
      expect(n.nx).toBeLessThan(0);
      expect(n.ny).toBeGreaterThan(0);
      expect(n.nz).toBeCloseTo(0, 5);
    });

    it('slope in z direction tilts normal in z', () => {
      const hm = new Heightmap(21, 21, 1);
      // height = z
      for (let z = 0; z < 21; z++) {
        for (let x = 0; x < 21; x++) {
          hm.set(x, z, z);
        }
      }

      const n = hm.sampleNormal(10, 10);
      expect(n.nx).toBeCloseTo(0, 5);
      expect(n.ny).toBeGreaterThan(0);
      expect(n.nz).toBeLessThan(0);
    });
  });
});
