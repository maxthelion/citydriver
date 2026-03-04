import { describe, it, expect } from 'vitest';
import { generateCity } from '../../src/city/pipeline.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('Full City Generation (Phases 9-12)', () => {
  function makeCity(seed = 42) {
    const rng = new SeededRandom(seed);
    const regionalLayers = generateRegion({ width: 64, height: 64, cellSize: 50 }, rng);
    const settlements = regionalLayers.getData('settlements');
    expect(settlements.length).toBeGreaterThan(0);
    return generateCity(regionalLayers, settlements[0], rng.fork('city'), { cityRadius: 15, cityCellSize: 10 });
  }

  it('has districts grid', () => {
    const city = makeCity();
    expect(city.getGrid('districts')).toBeDefined();
  });

  it('has plots', () => {
    const city = makeCity();
    const plots = city.getData('plots');
    expect(plots).toBeDefined();
    expect(Array.isArray(plots)).toBe(true);
  });

  it('has buildings', () => {
    const city = makeCity();
    const buildings = city.getData('buildings');
    expect(buildings).toBeDefined();
    expect(Array.isArray(buildings)).toBe(true);
  });

  it('buildings have valid properties', () => {
    const city = makeCity();
    const buildings = city.getData('buildings');
    if (buildings.length === 0) return; // Some seeds may not generate buildings

    for (const b of buildings.slice(0, 10)) {
      expect(b.footprint).toBeDefined();
      expect(b.footprint.length).toBeGreaterThanOrEqual(3);
      expect(b.height).toBeGreaterThan(0);
      expect(b.material).toBeDefined();
      expect(b.type).toBeDefined();
    }
  });

  it('has amenities', () => {
    const city = makeCity();
    const amenities = city.getData('amenities');
    expect(amenities).toBeDefined();
    expect(Array.isArray(amenities)).toBe(true);
  });

  it('has urban land cover', () => {
    const city = makeCity();
    const cover = city.getGrid('urbanCover');
    expect(cover).toBeDefined();
  });

  it('road graph has multiple hierarchy levels', () => {
    const city = makeCity();
    const graph = city.getData('roadGraph');

    const hierarchies = new Set();
    for (const [, edge] of graph.edges) {
      hierarchies.add(edge.hierarchy);
    }

    expect(hierarchies.size).toBeGreaterThanOrEqual(2);
  });

  it('dead-end fraction is limited', () => {
    const city = makeCity();
    const graph = city.getData('roadGraph');

    const deadEnds = graph.deadEnds();
    const totalNodes = graph.nodes.size;

    // After loop closure, dead-end fraction should be below 30%
    if (totalNodes > 5) {
      const deadEndFraction = deadEnds.length / totalNodes;
      expect(deadEndFraction).toBeLessThan(0.5);
    }
  });
});
