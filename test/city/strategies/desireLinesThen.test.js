import { describe, it, expect } from 'vitest';
import { desireLinesThen } from '../../../src/city/strategies/desireLinesThen.js';
import { FaceSubdivision } from '../../../src/city/strategies/faceSubdivision.js';
import { OffsetInfill } from '../../../src/city/strategies/offsetInfill.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';

function makeStrategy(SecondaryClass, seed = 42) {
  const { layers, settlement } = generateRegionFromSeed(seed);
  const rng = new SeededRandom(seed);
  const map = setupCity(layers, settlement, rng.fork('city'));
  const Cls = desireLinesThen(SecondaryClass);
  return { map, strategy: new Cls(map) };
}

// desireLinesThen uses archived strategies. Slow (180s+) and seed-dependent. Skipped by default.
describe.skip('desireLinesThen', { timeout: 180000 }, () => {
  it('runs desire lines then face subdivision', { timeout: 180000 }, () => {
    const { map, strategy } = makeStrategy(FaceSubdivision);

    // Tick through desire lines phase (skeleton + 2 accumulation)
    let ticks = 0;
    let more = true;
    while (more && ticks < 15) {
      more = strategy.tick();
      ticks++;
    }

    // Should have both skeleton and desire roads
    const skeletonRoads = map.roads.filter(r => r.source === 'skeleton');
    const desireRoads = map.roads.filter(r => r.source === 'desire');
    expect(skeletonRoads.length).toBeGreaterThan(0);
    expect(desireRoads.length).toBeGreaterThan(0);

    // Should have graph edges from desire lines
    expect(map.graph.edges.size).toBeGreaterThan(0);
  });

  it('runs desire lines then offset infill', { timeout: 180000 }, () => {
    const { map, strategy } = makeStrategy(OffsetInfill);

    let ticks = 0;
    let more = true;
    while (more && ticks < 15) {
      more = strategy.tick();
      ticks++;
    }

    const desireRoads = map.roads.filter(r => r.source === 'desire');
    const offsetRoads = map.roads.filter(r => r.source === 'offset');
    expect(desireRoads.length).toBeGreaterThan(0);
    expect(offsetRoads.length).toBeGreaterThan(0);
  });
});
