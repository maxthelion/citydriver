import { describe, it, expect } from 'vitest';
import { OffsetInfill } from '../../../src/city/strategies/offsetInfill.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';

function makeStrategy(seed = 42) {
  const { layers, settlement } = generateRegionFromSeed(seed);
  const rng = new SeededRandom(seed);
  const map = setupCity(layers, settlement, rng.fork('city'));
  return { map, strategy: new OffsetInfill(map) };
}

describe('OffsetInfill', { timeout: 30000 }, () => {
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

  it('adds offset curves on second tick', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    const roadsBefore = map.roads.length;
    const more = strategy.tick(); // offset curves

    expect(typeof more).toBe('boolean');

    // Should have added offset roads
    const offsetRoads = map.roads.filter(r => r.source === 'offset');
    if (more) {
      expect(offsetRoads.length).toBeGreaterThan(0);
      expect(map.roads.length).toBeGreaterThan(roadsBefore);

      // Offset roads should have expected properties
      for (const road of offsetRoads) {
        expect(road.width).toBe(6);
        expect(road.hierarchy).toBe('local');
        expect(road.importance).toBe(0.2);
        expect(road.polyline.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('adds cross streets on third tick', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton
    strategy.tick(); // offset curves

    const roadsBefore = map.roads.length;
    const more = strategy.tick(); // cross streets

    expect(typeof more).toBe('boolean');

    if (more) {
      const crossStreets = map.roads.filter(r => r.source === 'cross-street');
      expect(crossStreets.length).toBeGreaterThan(0);
      expect(map.roads.length).toBeGreaterThan(roadsBefore);
    }
  });

  it('eventually stops growing by tick 5', () => {
    const { map, strategy } = makeStrategy();

    let ticks = 0;
    let more = true;
    while (more && ticks < 10) {
      more = strategy.tick();
      ticks++;
    }

    expect(more).toBe(false);
    expect(ticks).toBeLessThanOrEqual(6); // tick 1-5, then false on 6
    expect(ticks).toBeGreaterThanOrEqual(2); // at least skeleton + one growth tick
  });
});
