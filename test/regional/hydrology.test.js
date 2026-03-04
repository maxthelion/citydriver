import { describe, it, expect } from 'vitest';
import { generateRegion } from '../../src/regional/pipeline.js';
import { runValidators } from '../../src/validators/framework.js';
import { getRegionalValidators } from '../../src/regional/validators.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('Hydrology & Coastline (Phase 4)', () => {
  function makeRegion(seed = 42) {
    return generateRegion({ width: 64, height: 64, cellSize: 50, seaLevel: 0 }, new SeededRandom(seed));
  }

  it('generates rivers', () => {
    const layers = makeRegion();
    const rivers = layers.getData('rivers');
    expect(rivers).toBeDefined();
    expect(Array.isArray(rivers)).toBe(true);
  });

  it('generates confluences', () => {
    const layers = makeRegion();
    const confluences = layers.getData('confluences');
    expect(confluences).toBeDefined();
    expect(Array.isArray(confluences)).toBe(true);
  });

  it('generates water mask', () => {
    const layers = makeRegion();
    const waterMask = layers.getGrid('waterMask');
    expect(waterMask).toBeDefined();

    // Should have some water cells
    let waterCount = 0;
    waterMask.forEach((gx, gz, val) => { if (val > 0) waterCount++; });
    expect(waterCount).toBeGreaterThan(0);
  });

  it('river cells flow downhill', () => {
    const layers = makeRegion();
    const rivers = layers.getData('rivers');

    function checkSegment(seg) {
      for (let i = 1; i < seg.cells.length; i++) {
        expect(seg.cells[i].elevation).toBeLessThanOrEqual(seg.cells[i - 1].elevation + 0.1);
      }
      for (const child of (seg.children || [])) checkSegment(child);
    }

    for (const root of rivers) checkSegment(root);
  });

  it('Phase 4 validators pass', () => {
    const layers = makeRegion();
    const validators = getRegionalValidators(4);
    const results = runValidators(layers, validators);

    // All Tier 1 should pass
    expect(results.valid).toBe(true);

    // Structural score should be reasonable
    expect(results.structural).toBeGreaterThan(0.2);
  });
});
