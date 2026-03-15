import { describe, it, expect } from 'vitest';
import { LandFirstDevelopment } from '../../../src/city/strategies/landFirstDevelopment.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';
import { ARCHETYPES } from '../../../src/city/archetypes.js';

// Shared map across tests to avoid repeated 5m-grid region generation
let shared;
function getShared() {
  if (!shared) {
    const seed = 42;
    const { layers, settlement } = generateRegionFromSeed(seed);
    const rng = new SeededRandom(seed);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map);
    while (strategy.tick()) {}
    shared = { map, strategy };
  }
  return shared;
}

describe('LandFirstDevelopment', () => {
  it('builds skeleton roads on first tick', { timeout: 30000 }, () => {
    const seed = 99;
    const { layers, settlement } = generateRegionFromSeed(seed);
    const rng = new SeededRandom(seed);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map);
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.roads.length).toBeGreaterThan(0);
  });

  it('completes all ticks without error', { timeout: 60000 }, () => {
    const { map } = getShared();
    // If we got here without error, the strategy completed
    expect(map.roads.length).toBeGreaterThan(0);
  });

  it('produces development zones', { timeout: 60000 }, () => {
    const { map } = getShared();
    expect(map.developmentZones).toBeDefined();
    expect(map.developmentZones.length).toBeGreaterThan(0);
  });

  it('adds local roads from ribbon layout', { timeout: 60000 }, () => {
    const { map } = getShared();
    const localRoads = map.roads.filter(r => r.hierarchy === 'local');
    expect(localRoads.length).toBeGreaterThan(0);
  });
});

describe('LandFirstDevelopment with archetype', () => {
  it('produces reservation zones when archetype is set', { timeout: 30000 }, () => {
    const seed = 42;
    const { layers, settlement } = generateRegionFromSeed(seed);
    const rng = new SeededRandom(seed);
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
