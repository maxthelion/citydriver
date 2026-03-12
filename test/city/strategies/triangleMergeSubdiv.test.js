import { describe, it, expect } from 'vitest';
import { TriangleMergeSubdiv } from '../../../src/city/strategies/triangleMergeSubdiv.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';

function makeStrategy(seed = 42) {
  const { layers, settlement } = generateRegionFromSeed(seed);
  const rng = new SeededRandom(seed);
  const map = setupCity(layers, settlement, rng.fork('city'));
  return { map, strategy: new TriangleMergeSubdiv(map) };
}

describe('TriangleMergeSubdiv', { timeout: 30000 }, () => {
  it('builds skeleton on first tick', () => {
    const { map, strategy } = makeStrategy();
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);
  });

  it('subdivides on second tick', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    const roadsBefore = map.roads.length;
    const more = strategy.tick();

    expect(typeof more).toBe('boolean');

    if (more) {
      expect(map.roads.length).toBeGreaterThan(roadsBefore);
    }
  });

  it('eventually stops', { timeout: 15000 }, () => {
    const { strategy } = makeStrategy();
    strategy.tick(); // skeleton

    let ticks = 0;
    const maxTicks = 30;
    let more = true;

    while (more && ticks < maxTicks) {
      more = strategy.tick();
      ticks++;
    }

    expect(more).toBe(false);
    expect(ticks).toBeGreaterThanOrEqual(1);
  });
});
