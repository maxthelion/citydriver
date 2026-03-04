import { describe, it, expect } from 'vitest';
import { generateTerrain } from '../../src/regional/generateTerrain.js';
import { generateGeology } from '../../src/regional/generateGeology.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('generateTerrain', () => {
  const rng = new SeededRandom(42);
  const params = { width: 32, height: 32, cellSize: 50, seaLevel: 0 };
  const geoParams = { width: 32, height: 32, cellSize: 50, bandDirection: 0.5, bandCount: 4, intrusionCount: 1 };

  function makeTerrain() {
    const geoRng = new SeededRandom(42);
    const geology = generateGeology(geoParams, geoRng);
    return generateTerrain(params, geology, new SeededRandom(42));
  }

  it('produces elevation and slope grids', () => {
    const result = makeTerrain();
    expect(result.elevation).toBeDefined();
    expect(result.slope).toBeDefined();
    expect(result.elevation.width).toBe(32);
    expect(result.slope.width).toBe(32);
  });

  it('elevation has no NaN or Infinity', () => {
    const result = makeTerrain();
    result.elevation.forEach((gx, gz, val) => {
      expect(isFinite(val)).toBe(true);
    });
  });

  it('slope is non-negative', () => {
    const result = makeTerrain();
    result.slope.forEach((gx, gz, val) => {
      expect(val).toBeGreaterThanOrEqual(0);
    });
  });

  it('elevation varies across the map', () => {
    const result = makeTerrain();
    const { min, max } = result.elevation.bounds();
    expect(max - min).toBeGreaterThan(5);
  });

  it('hard rock areas tend to be higher', () => {
    const geoRng = new SeededRandom(42);
    const geology = generateGeology({ ...geoParams, width: 64, height: 64 }, geoRng);
    const terrain = generateTerrain({ ...params, width: 64, height: 64 }, geology, new SeededRandom(42));

    let hardSum = 0, hardCount = 0;
    let softSum = 0, softCount = 0;

    for (let gz = 0; gz < 64; gz++) {
      for (let gx = 0; gx < 64; gx++) {
        const h = terrain.elevation.get(gx, gz);
        if (h < 0) continue;
        const r = geology.erosionResistance.get(gx, gz);
        if (r > 0.5) { hardSum += h; hardCount++; }
        else { softSum += h; softCount++; }
      }
    }

    if (hardCount > 0 && softCount > 0) {
      const hardMean = hardSum / hardCount;
      const softMean = softSum / softCount;
      expect(hardMean).toBeGreaterThan(softMean);
    }
  });
});
