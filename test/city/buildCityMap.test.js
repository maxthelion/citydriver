import { describe, it, expect, beforeAll } from 'vitest';
import { buildCityMap } from '../../src/city/buildCityMap.js';
import { generateRegionFromSeed } from '../../src/ui/regionHelper.js';

let sharedLayers, sharedSettlement;

beforeAll(() => {
  const { layers, settlement } = generateRegionFromSeed(42);
  sharedLayers = layers;
  sharedSettlement = settlement;
});

describe('buildCityMap', { timeout: 120000 }, () => {
  it('returns a map with roads when run to completion', async () => {
    const { map, archetype, stepCount, lastStepId } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
    });

    expect(map).toBeDefined();
    expect(map.ways.length).toBeGreaterThan(0);
    expect(archetype).toBeDefined();
    expect(archetype.name).toBeTruthy();
    expect(stepCount).toBeGreaterThan(0);
    expect(lastStepId).toBeTruthy();
  });

  it('auto-selects an archetype by default', async () => {
    const { archetype } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
    });

    expect(archetype.id).toBeTruthy();
  });

  it('accepts an explicit archetype key', async () => {
    const { archetype } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
      archetype: 'gridTown',
    });

    expect(archetype.id).toBe('gridTown');
  });

  it('accepts an archetype object directly', async () => {
    const custom = { id: 'custom', name: 'Custom', shares: {} };
    const { archetype } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
      archetype: custom,
      step: 'skeleton', // stop early — custom object lacks full archetype fields
    });

    expect(archetype.id).toBe('custom');
  });

  it('throws on unknown archetype key', async () => {
    await expect(buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
      archetype: 'noSuchArchetype',
    })).rejects.toThrow('Unknown archetype key');
  });

  it('stops at a named step when step is provided', async () => {
    const { map } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
      step: 'skeleton',
    });

    expect(map.ways.length).toBeGreaterThan(0);
    // Should NOT have development zones (those come later)
    expect(map.developmentZones?.length || 0).toBe(0);
  });

  it('stashes regional data on the map for minimap rendering', async () => {
    const { map } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
    });

    expect(map.regionalLayers).toBe(sharedLayers);
    expect(map.settlement).toBe(sharedSettlement);
  });
});
