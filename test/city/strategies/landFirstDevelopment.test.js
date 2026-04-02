import { describe, it, expect, beforeAll } from 'vitest';
import { LandFirstDevelopment } from '../../../src/city/strategies/landFirstDevelopment.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { SeededRandom } from '../../../src/core/rng.js';
import { ARCHETYPES } from '../../../src/city/archetypes.js';

// Shared map across tests to avoid repeated region generation
let sharedMap, sharedLayers, sharedSettlement;

describe('LandFirstDevelopment', { timeout: 120000 }, () => {
  beforeAll(() => {
    const seed = 42;
    const { layers, settlement } = generateRegionFromSeed(seed);
    sharedLayers = layers;
    sharedSettlement = settlement;
    const rng = new SeededRandom(seed);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map);
    while (strategy.tick()) {}
    sharedMap = map;
  });

  it('builds skeleton roads on first tick', () => {
    // Fresh city+strategy on the same region
    const rng = new SeededRandom(99);
    const map = setupCity(sharedLayers, sharedSettlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map);
    const more = strategy.tick();

    expect(more).toBe(true);
    expect(map.ways.length).toBeGreaterThan(0);
  });

  it('completes all ticks without error', () => {
    expect(sharedMap.ways.length).toBeGreaterThan(0);
  });

  it('smooths road polylines via smooth-roads step', () => {
    const longerRoads = sharedMap.ways.filter(r => r.polyline.length >= 3);
    expect(longerRoads.length).toBeGreaterThan(0);

    const smoothedRoads = sharedMap.ways.filter(r => r.polyline.length >= 9);
    expect(smoothedRoads.length).toBeGreaterThan(0);
  });

  it('produces development zones', () => {
    expect(sharedMap.developmentZones).toBeDefined();
    expect(sharedMap.developmentZones.length).toBeGreaterThan(0);
  });

  it('adds local roads from ribbon layout', () => {
    const localRoads = sharedMap.ways.filter(r => r.hierarchy === 'local');
    expect(localRoads.length).toBeGreaterThan(0);
  });
});

describe('LandFirstDevelopment with archetype', { timeout: 120000 }, () => {
  it('produces reservation zones when archetype is set', () => {
    if (!sharedLayers) {
      const { layers, settlement } = generateRegionFromSeed(42);
      sharedLayers = layers;
      sharedSettlement = settlement;
    }
    const rng = new SeededRandom(42);
    const map = setupCity(sharedLayers, sharedSettlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
    while (strategy.tick()) {}

    expect(map.hasLayer('reservationGrid')).toBe(true);
    const grid = map.getLayer('reservationGrid');
    let reserved = 0;
    for (let gz = 0; gz < map.height; gz++)
      for (let gx = 0; gx < map.width; gx++)
        if (grid.get(gx, gz) > 0) reserved++;

    expect(reserved).toBeGreaterThan(0);
    const localRoads = map.ways.filter(r => r.hierarchy === 'local');
    expect(localRoads.length).toBeGreaterThan(0);
  });
});
