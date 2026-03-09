import { describe, it, expect } from 'vitest';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('Regional Pipeline', () => {
  it('generates a LayerStack with elevation', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 32, height: 32, cellSize: 50 }, rng);

    expect(layers.hasGrid('elevation')).toBe(true);
    const elev = layers.getGrid('elevation');
    expect(elev.width).toBe(32);
    expect(elev.height).toBe(32);
  });

  it('elevation has finite values', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 32, height: 32 }, rng);
    const elev = layers.getGrid('elevation');

    elev.forEach((gx, gz, val) => {
      expect(isFinite(val)).toBe(true);
    });
  });

  it('elevation has reasonable range', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 64, height: 64 }, rng);
    const elev = layers.getGrid('elevation');
    const { min, max } = elev.bounds();

    // Should have some variation
    expect(max - min).toBeGreaterThan(5);
    // But not extreme
    expect(max).toBeLessThan(2500);
    expect(min).toBeGreaterThan(-500);
  });

  it('stores params in data', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 32, height: 32, cellSize: 100 }, rng);
    const params = layers.getData('params');
    expect(params.width).toBe(32);
    expect(params.cellSize).toBe(100);
  });

  it('is deterministic for same seed', () => {
    const a = generateRegion({ width: 16, height: 16 }, new SeededRandom(42));
    const b = generateRegion({ width: 16, height: 16 }, new SeededRandom(42));

    const elevA = a.getGrid('elevation');
    const elevB = b.getGrid('elevation');

    for (let i = 0; i < elevA.data.length; i++) {
      expect(elevA.data[i]).toBe(elevB.data[i]);
    }
  });
});
