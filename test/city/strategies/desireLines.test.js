import { describe, it, expect } from 'vitest';
import { DesireLines } from '../../../src/city/strategies/desireLines.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';

function makeStrategy(seed = 42) {
  const { layers, settlement } = generateRegionFromSeed(seed);
  const rng = new SeededRandom(seed);
  const map = setupCity(layers, settlement, rng.fork('city'));
  return { map, strategy: new DesireLines(map) };
}

describe('DesireLines', () => {
  it('builds skeleton roads on first tick', () => {
    const { map, strategy } = makeStrategy();
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);

    for (const road of map.roads) {
      expect(road.source).toBe('skeleton');
    }
  });

  it('adds desire-line roads on second tick', { timeout: 15000 }, () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    const roadsBefore = map.roads.length;
    const more = strategy.tick(); // primary desire lines

    expect(typeof more).toBe('boolean');

    if (more) {
      const desireRoads = map.roads.filter(r => r.source === 'desire');
      expect(desireRoads.length).toBeGreaterThan(0);
      expect(map.roads.length).toBeGreaterThan(roadsBefore);

      for (const road of desireRoads) {
        expect(road.width).toBe(6);
        expect(road.polyline.length).toBeGreaterThanOrEqual(2);
        expect(['collector', 'local']).toContain(road.hierarchy);
      }
    }
  });

  it('adds secondary roads on third tick', { timeout: 15000 }, () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton
    strategy.tick(); // primary

    const roadsBefore = map.roads.length;
    const more = strategy.tick(); // secondary

    expect(typeof more).toBe('boolean');

    if (more) {
      expect(map.roads.length).toBeGreaterThan(roadsBefore);
    }
  });

  it('stops growing after tick 3', { timeout: 15000 }, () => {
    const { strategy } = makeStrategy();
    strategy.tick(); // skeleton
    strategy.tick(); // primary
    strategy.tick(); // secondary

    const more = strategy.tick(); // should be false
    expect(more).toBe(false);
  });
});
