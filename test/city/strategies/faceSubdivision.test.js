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
    expect(map.graph.edges.size).toBeGreaterThan(0);
  });

  it('subdivides large faces on second tick', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    const roadsBefore = map.roads.length;
    const edgesBefore = map.graph.edges.size;

    const more = strategy.tick(); // first subdivision pass

    // Should have added roads (if any large faces existed)
    // At minimum, tick should return a boolean
    expect(typeof more).toBe('boolean');

    if (more) {
      expect(map.roads.length).toBeGreaterThan(roadsBefore);
      expect(map.graph.edges.size).toBeGreaterThan(edgesBefore);
    }
  });

  it('eventually returns false when all faces are small enough', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    let ticks = 0;
    const maxTicks = 50;
    let more = true;

    while (more && ticks < maxTicks) {
      more = strategy.tick();
      ticks++;
    }

    expect(more).toBe(false);
    // Should have done at least one subdivision pass
    expect(ticks).toBeGreaterThanOrEqual(1);
  });

  it('produces smaller faces after subdivision', () => {
    const { map, strategy } = makeStrategy();
    strategy.tick(); // skeleton

    // Measure face areas before subdivision
    const facesBefore = map.graph.facesWithEdges();
    const areasBefore = facesBefore.map(f => computeSignedArea(f.nodeIds, map.graph));
    const largeAreasBefore = areasBefore.filter(a => a > 4000).length;

    // Run several subdivision ticks
    for (let i = 0; i < 10; i++) {
      if (!strategy.tick()) break;
    }

    const facesAfter = map.graph.facesWithEdges();
    const areasAfter = facesAfter.map(f => computeSignedArea(f.nodeIds, map.graph));
    const largeAreasAfter = areasAfter.filter(a => a > 4000).length;

    // If there were large faces, there should be fewer now
    if (largeAreasBefore > 0) {
      expect(largeAreasAfter).toBeLessThan(largeAreasBefore);
      // And there should be more total faces
      expect(facesAfter.length).toBeGreaterThan(facesBefore.length);
    }
  });
});

/** Compute signed area using shoelace formula. Positive = CCW (inner face). */
function computeSignedArea(nodeIds, graph) {
  let area = 0;
  for (let i = 0; i < nodeIds.length; i++) {
    const a = graph.getNode(nodeIds[i]);
    const b = graph.getNode(nodeIds[(i + 1) % nodeIds.length]);
    area += (a.x * b.z - b.x * a.z);
  }
  return area / 2;
}
