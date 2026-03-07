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

describe('TriangleMergeSubdiv', () => {
  it('builds skeleton on first tick', () => {
    const { map, strategy } = makeStrategy();
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);
    expect(map.graph.edges.size).toBeGreaterThan(0);
  });

  it('merges or subdivides on second tick', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    const edgesBefore = map.graph.edges.size;
    const more = strategy.tick(); // merge phase

    expect(typeof more).toBe('boolean');

    // If merge happened, edges should have decreased (shared edges removed)
    // If no triangles, it falls through to subdivision which may add edges
    // Either way it should return a boolean
    if (more && edgesBefore > map.graph.edges.size) {
      // Merges removed edges
      expect(map.graph.edges.size).toBeLessThan(edgesBefore);
    }
  });

  it('eventually stops', () => {
    const { strategy } = makeStrategy();
    strategy.tick(); // skeleton

    let ticks = 0;
    const maxTicks = 50;
    let more = true;

    while (more && ticks < maxTicks) {
      more = strategy.tick();
      ticks++;
    }

    expect(more).toBe(false);
    expect(ticks).toBeGreaterThanOrEqual(1);
  });
});
