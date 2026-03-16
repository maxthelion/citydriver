import { describe, it, expect } from 'vitest';
import { FrontagePressure } from '../../../src/city/strategies/frontagePressure.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';

function makeStrategy(seed = 42) {
  const { layers, settlement } = generateRegionFromSeed(seed);
  const rng = new SeededRandom(seed);
  const map = setupCity(layers, settlement, rng.fork('city'));
  return { map, strategy: new FrontagePressure(map) };
}

// FrontagePressure is an archived strategy. Skipped by default.
describe.skip('FrontagePressure', { timeout: 30000 }, () => {
  it('builds skeleton roads on first tick', () => {
    const { map, strategy } = makeStrategy();
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);
    expect(map.graph.edges.size).toBeGreaterThan(0);

    // All roads from tick 1 should be skeleton or bridge roads
    for (const road of map.roads) {
      expect(['skeleton', 'bridge']).toContain(road.source);
    }
  });

  it('adds new roads on growth ticks', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    const roadsBefore = map.roads.length;

    // Run a few growth ticks
    let added = false;
    for (let i = 0; i < 3; i++) {
      const more = strategy.tick();
      if (map.roads.length > roadsBefore) {
        added = true;
        break;
      }
      if (!more) break;
    }

    expect(added).toBe(true);

    // Should have back-lane or cross-street roads
    const growthRoads = map.roads.filter(
      r => r.source === 'back-lane' || r.source === 'cross-street'
    );
    expect(growthRoads.length).toBeGreaterThan(0);

    // Growth roads should have expected properties
    for (const road of growthRoads) {
      expect(road.polyline.length).toBeGreaterThanOrEqual(2);
      expect(road.hierarchy).toBe('local');
      expect(typeof road.width).toBe('number');
    }
  });

  it('eventually stops growing', () => {
    const { map, strategy } = makeStrategy();

    let ticks = 0;
    let more = true;
    while (more && ticks < 15) {
      more = strategy.tick();
      ticks++;
    }

    expect(more).toBe(false);
    expect(ticks).toBeLessThanOrEqual(9); // 1 skeleton + up to 7 growth + 1 false
    expect(ticks).toBeGreaterThanOrEqual(2); // at least skeleton + one growth tick
  });
});
