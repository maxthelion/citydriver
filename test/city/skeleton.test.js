import { describe, it, expect } from 'vitest';
import { setupCity } from '../../src/city/setup.js';
import { buildSkeleton } from '../../src/city/skeleton.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

function makeCity(seed = 42) {
  const rng = new SeededRandom(seed);
  const coastEdge = ['north', 'south', 'east', 'west', null][rng.int(0, 4)];
  const layers = generateRegion({
    width: 128, height: 128, cellSize: 50, seaLevel: 0, coastEdge,
  }, rng);
  const settlements = layers.getData('settlements');
  if (!settlements || settlements.length === 0) return null;

  const cityRng = rng.fork('city');
  const map = setupCity(layers, settlements[0], cityRng);
  return map;
}

describe('buildSkeleton', () => {
  it('places nuclei on the map', () => {
    const map = makeCity();
    if (!map) return;

    buildSkeleton(map);
    expect(map.nuclei.length).toBeGreaterThan(0);
  });

  it('creates road features', () => {
    const map = makeCity();
    if (!map) return;

    const roadsBefore = map.roads.length;
    buildSkeleton(map);
    expect(map.roads.length).toBeGreaterThan(roadsBefore);
  });

  it('populates the PlanarGraph', () => {
    const map = makeCity();
    if (!map) return;

    buildSkeleton(map);
    expect(map.graph.nodes.size).toBeGreaterThan(0);
    expect(map.graph.edges.size).toBeGreaterThan(0);
  });

  it('classifies nucleus types', () => {
    const map = makeCity();
    if (!map) return;

    buildSkeleton(map);
    const validTypes = ['waterfront', 'market', 'hilltop', 'valley', 'roadside', 'suburban'];
    for (const n of map.nuclei) {
      expect(validTypes).toContain(n.type);
    }
  });

  it('works across multiple seeds', () => {
    for (const seed of [1, 42, 100, 255, 999]) {
      const map = makeCity(seed);
      if (!map) continue;

      buildSkeleton(map);
      expect(map.nuclei.length).toBeGreaterThan(0);
      expect(map.roads.length).toBeGreaterThan(0);
    }
  });
});
