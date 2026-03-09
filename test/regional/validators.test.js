import { describe, it, expect } from 'vitest';
import { runValidators } from '../../src/validators/framework.js';
import { getRegionalValidators } from '../../src/regional/validators.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('Regional Validators (Phase 3)', () => {
  it('all Phase 3 validators pass on generated region', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 64, height: 64, cellSize: 50 }, rng);
    const validators = getRegionalValidators(3);
    const results = runValidators(layers, validators);

    // Tier 1 must pass
    expect(results.valid).toBe(true);

    // Tier 2 scores should be reasonable
    expect(results.structural).toBeGreaterThan(0.3);
  });

  it('V_elevationFinite passes', () => {
    const rng = new SeededRandom(123);
    const layers = generateRegion({ width: 32, height: 32 }, rng);
    const validators = getRegionalValidators(3);
    const vFinite = validators.find(v => v.name === 'V_elevationFinite');
    expect(vFinite.fn(layers)).toBe(true);
  });

  it('S_rockElevationCorrelation scores positively', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 64, height: 64 }, rng);
    const validators = getRegionalValidators(3);
    const vCorr = validators.find(v => v.name === 'S_rockElevationCorrelation');
    const score = vCorr.fn(layers);
    expect(score).toBeGreaterThan(0.3);
  });

  it('S_terrainSmoothness scores well', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 64, height: 64, cellSize: 200 }, rng);
    const validators = getRegionalValidators(3);
    const vSmooth = validators.find(v => v.name === 'S_terrainSmoothness');
    const score = vSmooth.fn(layers);
    expect(score).toBeGreaterThan(0.15);
  });
});
