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

// DesireLines is an archived strategy not used in the active pipeline.
// These tests are slow (100s+) and seed-dependent. Skipped by default.
describe.skip('DesireLines', { timeout: 180000 }, () => {
  it('builds skeleton roads on first tick', () => {
    const { map, strategy } = makeStrategy();
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);

    for (const road of map.roads) {
      expect(['skeleton', 'bridge']).toContain(road.source);
    }
  });

  it('adds desire-line roads by third tick', { timeout: 180000 }, () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton
    strategy.tick(); // primary desire lines
    strategy.tick(); // secondary desire lines

    // Primary or secondary pass should produce some desire roads
    const desireRoads = map.roads.filter(r => r.source === 'desire');
    expect(desireRoads.length).toBeGreaterThan(0);

    for (const road of desireRoads) {
      expect(road.width).toBe(6);
      expect(road.polyline.length).toBeGreaterThanOrEqual(2);
      expect(['collector', 'local']).toContain(road.hierarchy);
    }
  });

  it('adds secondary roads on third tick', { timeout: 180000 }, () => {
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

  it('stops growing after all ticks complete', { timeout: 180000 }, () => {
    const { strategy } = makeStrategy();
    let ticks = 0;
    let more = true;
    while (more && ticks < 10) {
      more = strategy.tick();
      ticks++;
    }
    // Should terminate within 7 ticks (1 skeleton + 2 desire + up to 3 dead-end + done)
    expect(ticks).toBeLessThanOrEqual(7);
    expect(more).toBe(false);
  });
});
