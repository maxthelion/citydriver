import { describe, it, expect } from 'vitest';
import { runPhase1, ZONE, RIVER_CONSTANTS } from '../../src/generation/phase1Terrain.js';
import { Heightmap } from '../../src/core/heightmap.js';
import { SeededRandom } from '../../src/core/rng.js';

/**
 * Create a minimal CityContext for testing.
 * Produces a 64x64 heightmap with a gentle slope.
 */
function makeCityContext(overrides = {}) {
  const gridSize = 32;
  const cellSize = 10;
  const regionHm = new Heightmap(gridSize, gridSize, cellSize);

  // Gentle slope from NW (high) to SE (low)
  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      regionHm.set(gx, gz, 50 - gx * 0.3 - gz * 0.3);
    }
  }
  regionHm.freeze();

  return {
    center: { x: 150, z: 150 },
    settlement: { name: 'Test Town' },
    regionHeightmap: regionHm,
    cityBounds: { minX: 0, minZ: 0, maxX: 310, maxZ: 310 },
    seaLevel: 0,
    rivers: [],
    coastline: null,
    roadEntries: [],
    economicRole: 'market',
    rank: 'town',
    ...overrides,
  };
}

describe('Phase 1: Terrain Preparation', () => {
  const rng = new SeededRandom(42);
  const params = { gridSize: 64, cellSize: 5, detailAmplitude: 1 };

  describe('basic terrain refinement', () => {
    it('produces a heightmap of the correct size', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t1'), params);

      expect(result.heightmap.width).toBe(64);
      expect(result.heightmap.height).toBe(64);
      expect(result.heightmap.isFrozen).toBe(true);
    });

    it('heightmap values are finite numbers', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t2'), params);

      for (let gz = 0; gz < 64; gz += 10) {
        for (let gx = 0; gx < 64; gx += 10) {
          const h = result.heightmap.get(gx, gz);
          expect(Number.isFinite(h)).toBe(true);
        }
      }
    });
  });

  describe('slope map', () => {
    it('has correct dimensions', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t3'), params);

      expect(result.slopeMap.length).toBe(64 * 64);
    });

    it('contains non-negative values', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t4'), params);

      for (let i = 0; i < result.slopeMap.length; i++) {
        expect(result.slopeMap[i]).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('terrain zones', () => {
    it('has correct dimensions', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t5'), params);

      expect(result.terrainZones.length).toBe(64 * 64);
    });

    it('contains valid zone codes (0-4)', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t6'), params);

      for (let i = 0; i < result.terrainZones.length; i++) {
        expect(result.terrainZones[i]).toBeGreaterThanOrEqual(0);
        expect(result.terrainZones[i]).toBeLessThanOrEqual(4);
      }
    });

    it('flat terrain is classified as FLAT_ELEVATED or FLAT_LOW', () => {
      // Create a very flat heightmap
      const flatHm = new Heightmap(32, 32, 10);
      for (let gz = 0; gz < 32; gz++) {
        for (let gx = 0; gx < 32; gx++) {
          flatHm.set(gx, gz, 20); // flat at 20m
        }
      }
      flatHm.freeze();

      const ctx = makeCityContext({ regionHeightmap: flatHm });
      const result = runPhase1(ctx, rng.fork('t7'), params);

      // Most cells should be FLAT_ELEVATED (above sea level = 0)
      let flatElevatedCount = 0;
      for (let i = 0; i < result.terrainZones.length; i++) {
        if (result.terrainZones[i] === ZONE.FLAT_ELEVATED) flatElevatedCount++;
      }

      expect(flatElevatedCount).toBeGreaterThan(result.terrainZones.length * 0.5);
    });
  });

  describe('river handling', () => {
    it('returns empty rivers and waterCells when no rivers', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t8'), params);

      expect(result.rivers).toHaveLength(0);
      expect(result.waterCells.size).toBe(0);
    });

    it('carves rivers and produces water cells', () => {
      const ctx = makeCityContext({
        rivers: [{
          entryPoint: { x: 0, z: 155 },
          exitPoint: { x: 310, z: 155 },
          cells: [
            { gx: 5, gz: 15 },
            { gx: 10, gz: 15 },
            { gx: 15, gz: 15 },
            { gx: 20, gz: 15 },
            { gx: 25, gz: 15 },
          ],
          flowVolume: 5000,
          rank: 'river',
        }],
      });
      const result = runPhase1(ctx, rng.fork('t9'), params);

      expect(result.rivers.length).toBe(1);
      expect(result.rivers[0].centerline.length).toBeGreaterThan(2);
      expect(result.rivers[0].width).toBeGreaterThan(0);
      expect(result.waterCells.size).toBeGreaterThan(0);
    });
  });

  describe('coast handling', () => {
    it('returns null coast when no coastline', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t10'), params);

      expect(result.coast).toBeNull();
    });

    it('produces coast cells when coastline present', () => {
      const ctx = makeCityContext({
        coastline: { edge: 'west', seaLevel: 10 },
        seaLevel: 10,
      });
      const result = runPhase1(ctx, rng.fork('t11'), params);

      expect(result.coast).not.toBeNull();
      expect(result.coast.coastCells.size).toBeGreaterThan(0);
    });
  });

  describe('anchor points', () => {
    it('returns an array (possibly empty)', () => {
      const ctx = makeCityContext();
      const result = runPhase1(ctx, rng.fork('t12'), params);

      expect(Array.isArray(result.anchorPoints)).toBe(true);
    });

    it('detects river crossing anchors when river present', () => {
      const ctx = makeCityContext({
        rivers: [{
          entryPoint: { x: 0, z: 155 },
          exitPoint: { x: 310, z: 155 },
          cells: [
            { gx: 5, gz: 15 },
            { gx: 10, gz: 15 },
            { gx: 15, gz: 15 },
            { gx: 20, gz: 15 },
            { gx: 25, gz: 15 },
          ],
          flowVolume: 5000,
          rank: 'river',
        }],
      });
      const result = runPhase1(ctx, rng.fork('t13'), params);

      const crossings = result.anchorPoints.filter(a => a.type === 'river_crossing');
      expect(crossings.length).toBeGreaterThanOrEqual(1);
      expect(crossings[0].score).toBeGreaterThan(0);
    });
  });

  describe('water exclusion', () => {
    it('is a superset of waterCells', () => {
      const ctx = makeCityContext({
        rivers: [{
          entryPoint: { x: 0, z: 155 },
          exitPoint: { x: 310, z: 155 },
          cells: [
            { gx: 5, gz: 15 },
            { gx: 10, gz: 15 },
            { gx: 15, gz: 15 },
            { gx: 20, gz: 15 },
            { gx: 25, gz: 15 },
          ],
          flowVolume: 5000,
          rank: 'river',
        }],
      });
      const result = runPhase1(ctx, rng.fork('t14'), params);

      for (const cell of result.waterCells) {
        expect(result.waterExclusion.has(cell)).toBe(true);
      }
      // Exclusion zone should be larger than water cells
      expect(result.waterExclusion.size).toBeGreaterThan(result.waterCells.size);
    });
  });

  describe('determinism', () => {
    it('produces identical output with same seed', () => {
      const ctx = makeCityContext();
      const r1 = runPhase1(ctx, new SeededRandom(99).fork('t'), params);
      const r2 = runPhase1(ctx, new SeededRandom(99).fork('t'), params);

      // Compare a few heightmap values
      for (let gz = 0; gz < 64; gz += 16) {
        for (let gx = 0; gx < 64; gx += 16) {
          expect(r1.heightmap.get(gx, gz)).toBe(r2.heightmap.get(gx, gz));
        }
      }

      expect(r1.anchorPoints.length).toBe(r2.anchorPoints.length);
    });
  });
});
