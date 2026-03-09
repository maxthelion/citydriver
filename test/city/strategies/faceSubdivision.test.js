import { describe, it, expect } from 'vitest';
import { FaceSubdivision } from '../../../src/city/strategies/faceSubdivision.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';

function makeStrategy(seed = 42) {
  const { layers, settlement } = generateRegionFromSeed(seed);
  const rng = new SeededRandom(seed);
  const map = setupCity(layers, settlement, rng.fork('city'));
  const strategy = new FaceSubdivision(map);
  return { map, strategy };
}

describe('FaceSubdivision', () => {
  it('builds skeleton roads on first tick', () => {
    const { map, strategy } = makeStrategy();
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);
  });

  it('subdivides large faces on second tick', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    const roadsBefore = map.roads.length;
    const more = strategy.tick(); // first subdivision pass

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

  it('adds subdivision roads when large faces exist', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    const facesBefore = map.extractFaces();
    const largeBefore = facesBefore.filter(f => f.area > 4000).length;
    const roadsBefore = map.roads.length;

    // Run several subdivision ticks
    for (let i = 0; i < 10; i++) {
      if (!strategy.tick()) break;
    }

    // If there were large faces, subdivision should have added roads
    if (largeBefore > 0) {
      const subdivRoads = map.roads.filter(r => r.source === 'subdivision');
      expect(subdivRoads.length).toBeGreaterThan(0);
      expect(map.roads.length).toBeGreaterThan(roadsBefore);
    }
  });
});
