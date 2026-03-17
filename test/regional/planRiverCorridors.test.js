import { describe, it, expect } from 'vitest';
import { planRiverCorridors } from '../../src/regional/planRiverCorridors.js';
import { SeededRandom } from '../../src/core/rng.js';

const params = { width: 256, height: 256, cellSize: 50 };

describe('planRiverCorridors', () => {
  it('returns corridors, corridorDist, and corridorInfluence', () => {
    const tectonics = { coastEdges: ['south'], intensity: 0.5 };
    const rng = new SeededRandom(42);
    const result = planRiverCorridors(params, tectonics, rng);

    expect(result.corridors).toBeInstanceOf(Array);
    expect(result.corridorDist).toBeDefined();
    expect(result.corridorInfluence).toBeDefined();
  });

  it('produces 0 corridors when all edges are coast', () => {
    const tectonics = { coastEdges: ['north', 'south', 'east', 'west'], intensity: 0.5 };
    const rng = new SeededRandom(42);
    const result = planRiverCorridors(params, tectonics, rng);
    expect(result.corridors).toHaveLength(0);
  });

  it('corridor polylines go from inland edge to coast edge', () => {
    const tectonics = { coastEdges: ['south'], intensity: 0.8 };
    const rng = new SeededRandom(99);
    const result = planRiverCorridors(params, tectonics, rng);

    for (const c of result.corridors) {
      expect(c.polyline.length).toBeGreaterThan(2);
      const first = c.polyline[0];
      const last = c.polyline[c.polyline.length - 1];
      // Entry should NOT be on south edge (coast)
      expect(first.gz).not.toBe(255);
      // Exit should be on south edge (coast)
      expect(last.gz).toBe(255);
    }
  });

  it('corridorDist is 0 along corridor and increases away', () => {
    const tectonics = { coastEdges: ['south'], intensity: 0.8 };
    const rng = new SeededRandom(42);
    const result = planRiverCorridors(params, tectonics, rng);

    if (result.corridors.length > 0) {
      const midPt = result.corridors[0].polyline[Math.floor(result.corridors[0].polyline.length / 2)];
      expect(result.corridorDist.get(midPt.gx, midPt.gz)).toBe(0);
      // 50 cells away should be > 0
      const farX = Math.min(255, midPt.gx + 50);
      expect(result.corridorDist.get(farX, midPt.gz)).toBeGreaterThan(0);
    }
  });

  it('corridorInfluence is high near corridor and falls off', () => {
    const tectonics = { coastEdges: ['south'], intensity: 0.8 };
    const rng = new SeededRandom(42);
    const result = planRiverCorridors(params, tectonics, rng);

    if (result.corridors.length > 0) {
      const midPt = result.corridors[0].polyline[Math.floor(result.corridors[0].polyline.length / 2)];
      const nearInfluence = result.corridorInfluence.get(midPt.gx, midPt.gz);
      const farInfluence = result.corridorInfluence.get(
        Math.min(255, midPt.gx + 50), midPt.gz
      );
      expect(nearInfluence).toBeGreaterThan(0.5);
      expect(farInfluence).toBeLessThan(nearInfluence);
    }
  });

  it('each corridor has entryAccumulation and importance', () => {
    const tectonics = { coastEdges: ['south'], intensity: 0.8 };
    const rng = new SeededRandom(42);
    const result = planRiverCorridors(params, tectonics, rng);

    for (const c of result.corridors) {
      // entryAccumulation is 0 here; computed later by carveRiverProfiles
      expect(c.entryAccumulation).toBe(0);
      expect(c.importance).toBeGreaterThan(0);
      expect(c.importance).toBeLessThanOrEqual(1);
    }
  });
});
