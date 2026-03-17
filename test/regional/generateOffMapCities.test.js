import { describe, it, expect } from 'vitest';
import { generateOffMapCities } from '../../src/regional/generateOffMapCities.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('generateOffMapCities', () => {
  it('generates 3-5 off-map cities', () => {
    const rng = new SeededRandom(42);
    const cities = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, rng);
    expect(cities.length).toBeGreaterThanOrEqual(3);
    expect(cities.length).toBeLessThanOrEqual(5);
  });

  it('has exactly one capital', () => {
    const rng = new SeededRandom(42);
    const cities = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, rng);
    const capitals = cities.filter(c => c.role === 'capital');
    expect(capitals.length).toBe(1);
    expect(capitals[0].importance).toBe(1);
  });

  it('places cities on region edges', () => {
    const rng = new SeededRandom(42);
    const cities = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, rng);
    for (const c of cities) {
      const onEdge = c.gx === 0 || c.gx === 127 || c.gz === 0 || c.gz === 127;
      expect(onEdge).toBe(true);
    }
  });

  it('avoids coastal edges', () => {
    const rng = new SeededRandom(42);
    const cities = generateOffMapCities(
      { width: 128, height: 128, cellSize: 50 }, rng,
      { coastEdges: ['west', 'south'] },
    );
    for (const c of cities) {
      expect(c.edge).not.toBe('west');
      expect(c.edge).not.toBe('south');
    }
    expect(cities.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, new SeededRandom(99));
    const b = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, new SeededRandom(99));
    expect(a).toEqual(b);
  });
});
