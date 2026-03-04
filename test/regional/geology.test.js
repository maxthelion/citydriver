import { describe, it, expect } from 'vitest';
import { generateGeology, ROCK_TYPES, getRockInfo } from '../../src/regional/generateGeology.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('generateGeology', () => {
  const rng = new SeededRandom(42);
  const params = { width: 32, height: 32, cellSize: 50, bandDirection: 0.5, bandCount: 4, intrusionCount: 1 };

  it('produces all required grids', () => {
    const result = generateGeology(params, rng);
    expect(result.rockType).toBeDefined();
    expect(result.erosionResistance).toBeDefined();
    expect(result.permeability).toBeDefined();
    expect(result.soilFertility).toBeDefined();
    expect(result.springLine).toBeDefined();
  });

  it('rockType contains valid IDs', () => {
    const result = generateGeology(params, new SeededRandom(42));
    const validIds = Object.values(ROCK_TYPES).map(r => r.id);
    result.rockType.forEach((gx, gz, val) => {
      expect(validIds).toContain(val);
    });
  });

  it('erosionResistance is in [0, 1]', () => {
    const result = generateGeology(params, new SeededRandom(42));
    result.erosionResistance.forEach((gx, gz, val) => {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    });
  });

  it('produces multiple rock types across the map', () => {
    const result = generateGeology({ ...params, width: 64, height: 64, bandCount: 5 }, new SeededRandom(42));
    const types = new Set();
    result.rockType.forEach((gx, gz, val) => types.add(val));
    expect(types.size).toBeGreaterThan(1);
  });

  it('getRockInfo returns correct info', () => {
    const info = getRockInfo(0);
    expect(info.name).toBe('limestone');
    expect(info.erosionResistance).toBe(0.6);
  });

  it('is deterministic', () => {
    const a = generateGeology(params, new SeededRandom(42));
    const b = generateGeology(params, new SeededRandom(42));
    for (let i = 0; i < a.rockType.data.length; i++) {
      expect(a.rockType.data[i]).toBe(b.rockType.data[i]);
    }
  });
});
