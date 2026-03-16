import { describe, it, expect } from 'vitest';
import { LandFirstDevelopment } from '../../../src/city/strategies/landFirstDevelopment.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';
import { ARCHETYPES } from '../../../src/city/archetypes.js';

// Shared map across tests to avoid repeated region generation
let shared;
function getShared() {
  if (!shared) {
    const seed = 42;
    const { layers, settlement } = generateRegionFromSeed(seed);
    const rng = new SeededRandom(seed);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map);
    while (strategy.tick()) {}
    shared = { map, strategy, layers, settlement };
  }
  return shared;
}

describe('LandFirstDevelopment', { timeout: 60000 }, () => {
  it('builds skeleton roads on first tick', () => {
    // Use shared region but fresh city+strategy
    const { layers, settlement } = getShared();
    const rng = new SeededRandom(99);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map);
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);
  });

  it('completes all ticks without error', () => {
    const { map } = getShared();
    expect(map.roads.length).toBeGreaterThan(0);
  });

  it('produces development zones', () => {
    const { map } = getShared();
    expect(map.developmentZones).toBeDefined();
    expect(map.developmentZones.length).toBeGreaterThan(0);
  });

  it('adds local roads from ribbon layout', () => {
    const { map } = getShared();
    const localRoads = map.roads.filter(r => r.hierarchy === 'local');
    expect(localRoads.length).toBeGreaterThan(0);
  });
});

describe('LandFirstDevelopment with archetype', { timeout: 60000 }, () => {
  it('produces reservation zones when archetype is set', () => {
    const { layers, settlement } = getShared();
    const rng = new SeededRandom(42);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
    while (strategy.tick()) {}

    expect(map.hasLayer('reservationGrid')).toBe(true);
    const grid = map.getLayer('reservationGrid');
    let reserved = 0;
    for (let gz = 0; gz < map.height; gz++)
      for (let gx = 0; gx < map.width; gx++)
        if (grid.get(gx, gz) > 0) reserved++;

    expect(reserved).toBeGreaterThan(0);
    const localRoads = map.roads.filter(r => r.hierarchy === 'local');
    expect(localRoads.length).toBeGreaterThan(0);
  });
});
