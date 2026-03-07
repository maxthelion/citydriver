import { describe, it, expect } from 'vitest';
import { FaceSubdivision } from '../../../src/city/strategies/faceSubdivision.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';

describe('FaceSubdivision', () => {
  it('builds skeleton roads on first tick', () => {
    const { layers, settlement } = generateRegionFromSeed(42);
    const rng = new SeededRandom(42);
    const map = setupCity(layers, settlement, rng.fork('city'));

    const strategy = new FaceSubdivision(map);
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);
    expect(map.graph.edges.size).toBeGreaterThan(0);
  });

  it('returns false on second tick (no growth yet)', () => {
    const { layers, settlement } = generateRegionFromSeed(42);
    const rng = new SeededRandom(42);
    const map = setupCity(layers, settlement, rng.fork('city'));

    const strategy = new FaceSubdivision(map);
    strategy.tick();
    const more = strategy.tick();
    expect(more).toBe(false);
  });
});
