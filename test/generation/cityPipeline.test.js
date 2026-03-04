import { describe, it, expect } from 'vitest';
import { generateCity } from '../../src/generation/pipeline.js';
import { Heightmap } from '../../src/core/heightmap.js';

function makeCityContext(overrides = {}) {
  const gridSize = 32;
  const cellSize = 10;
  const regionHm = new Heightmap(gridSize, gridSize, cellSize);

  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      regionHm.set(gx, gz, 50 - gx * 0.2 - gz * 0.1);
    }
  }
  regionHm.freeze();

  return {
    center: { x: 155, z: 155 },
    settlement: { name: 'Test Town' },
    regionHeightmap: regionHm,
    cityBounds: { minX: 0, minZ: 0, maxX: 310, maxZ: 310 },
    seaLevel: 0,
    rivers: [],
    coastline: null,
    roadEntries: [
      { point: { x: 0, z: 155 }, hierarchy: 'primary', destination: 'North' },
      { point: { x: 310, z: 155 }, hierarchy: 'primary', destination: 'South' },
      { point: { x: 155, z: 0 }, hierarchy: 'secondary', destination: 'East' },
    ],
    economicRole: 'market',
    rank: 'town',
    ...overrides,
  };
}

describe('City Pipeline Integration', () => {
  it('generates a complete CityData object with all 8 phases', async () => {
    const ctx = makeCityContext();
    const cityData = await generateCity(ctx, {
      seed: 42,
      gridSize: 64,
      organicness: 0.5,
    });

    // Heightmap
    expect(cityData.heightmap).toBeDefined();
    expect(cityData.heightmap.width).toBe(64);
    expect(cityData.heightmap.isFrozen).toBe(true);

    // Network
    expect(cityData.network).toBeDefined();
    expect(cityData.network.nodes.size).toBeGreaterThan(0);
    expect(cityData.network.edges.length).toBeGreaterThan(0);
    expect(Array.isArray(cityData.network.blocks)).toBe(true);
    expect(Array.isArray(cityData.network.bridges)).toBe(true);

    // Road hierarchy variety
    const hierarchies = new Set(cityData.network.edges.map(e => e.hierarchy));
    expect(hierarchies.has('primary')).toBe(true);

    // Blocks from Phase 5
    expect(cityData.network.blocks.length).toBeGreaterThan(0);

    // Sea level
    expect(typeof cityData.seaLevel).toBe('number');

    // Rivers and coast
    expect(Array.isArray(cityData.rivers)).toBe(true);

    // Density field from Phase 3
    expect(cityData.densityField).toBeDefined();
    expect(cityData.densityField.gridWidth).toBeGreaterThan(0);

    // Districts from Phase 4
    expect(Array.isArray(cityData.districts)).toBe(true);
    expect(cityData.districts.length).toBeGreaterThan(0);

    // Plots from Phase 6
    expect(Array.isArray(cityData.plots)).toBe(true);
    expect(cityData.plots.length).toBeGreaterThan(0);

    // Buildings from Phase 7
    expect(Array.isArray(cityData.buildings)).toBe(true);
    expect(cityData.buildings.length).toBeGreaterThan(0);

    // Amenities from Phase 8
    expect(Array.isArray(cityData.amenities)).toBe(true);

    // Edge centrality from Phase 8
    expect(cityData.edgeCentrality).toBeInstanceOf(Map);

    // Population
    expect(typeof cityData.population).toBe('number');
    expect(cityData.population).toBeGreaterThan(0);

    // Context preserved
    expect(cityData.cityContext).toBe(ctx);

    // Params preserved
    expect(cityData.params.seed).toBe(42);
    expect(cityData.params.gridSize).toBe(64);
  });

  it('terrain data is exposed', async () => {
    const ctx = makeCityContext();
    const cityData = await generateCity(ctx, { seed: 42, gridSize: 64 });

    expect(cityData.terrainData).toBeDefined();
    expect(cityData.terrainData.slopeMap).toBeDefined();
    expect(cityData.terrainData.terrainZones).toBeDefined();
    expect(cityData.terrainData.anchorPoints).toBeDefined();
    expect(cityData.terrainData.waterExclusion).toBeDefined();
  });

  it('is deterministic', async () => {
    const ctx = makeCityContext();

    const d1 = await generateCity(ctx, { seed: 42, gridSize: 64 });
    const d2 = await generateCity(ctx, { seed: 42, gridSize: 64 });

    expect(d1.network.nodes.size).toBe(d2.network.nodes.size);
    expect(d1.network.edges.length).toBe(d2.network.edges.length);
    expect(d1.buildings.length).toBe(d2.buildings.length);
    expect(d1.plots.length).toBe(d2.plots.length);

    // Heightmap values match
    for (let gz = 0; gz < 64; gz += 16) {
      for (let gx = 0; gx < 64; gx += 16) {
        expect(d1.heightmap.get(gx, gz)).toBe(d2.heightmap.get(gx, gz));
      }
    }
  });

  it('different seeds produce different results', async () => {
    const ctx = makeCityContext();

    const d1 = await generateCity(ctx, { seed: 1, gridSize: 64 });
    const d2 = await generateCity(ctx, { seed: 2, gridSize: 64 });

    let diffs = 0;
    for (let gz = 0; gz < 64; gz += 8) {
      for (let gx = 0; gx < 64; gx += 8) {
        if (d1.heightmap.get(gx, gz) !== d2.heightmap.get(gx, gz)) diffs++;
      }
    }
    expect(diffs).toBeGreaterThan(0);
  });

  it('handles rivers correctly', async () => {
    const ctx = makeCityContext({
      rivers: [{
        entryPoint: { x: 155, z: 0 },
        exitPoint: { x: 155, z: 310 },
        cells: [
          { gx: 15, gz: 5 },
          { gx: 15, gz: 10 },
          { gx: 15, gz: 15 },
          { gx: 15, gz: 20 },
          { gx: 15, gz: 25 },
        ],
        flowVolume: 5000,
        rank: 'river',
      }],
    });

    const cityData = await generateCity(ctx, { seed: 42, gridSize: 64 });
    expect(cityData.rivers.length).toBe(1);
    expect(cityData.rivers[0].centerline.length).toBeGreaterThan(2);
  });

  it('calls onProgress for all phases', async () => {
    const ctx = makeCityContext();
    const phases = new Set();

    await generateCity(ctx, { seed: 42, gridSize: 64 }, (phase) => {
      phases.add(phase);
    });

    expect(phases.has('terrain')).toBe(true);
    expect(phases.has('arterials')).toBe(true);
    expect(phases.has('density')).toBe(true);
    expect(phases.has('districts')).toBe(true);
    expect(phases.has('streets')).toBe(true);
    expect(phases.has('plots')).toBe(true);
    expect(phases.has('buildings')).toBe(true);
    expect(phases.has('amenities')).toBe(true);
  });

  it('buildings match renderer interface', async () => {
    const ctx = makeCityContext();
    const cityData = await generateCity(ctx, { seed: 42, gridSize: 64 });

    for (const b of cityData.buildings) {
      expect(typeof b.x).toBe('number');
      expect(typeof b.z).toBe('number');
      expect(typeof b.w).toBe('number');
      expect(typeof b.d).toBe('number');
      expect(typeof b.h).toBe('number');
      expect(typeof b.floors).toBe('number');
      expect(typeof b.rotation).toBe('number');
      expect(typeof b.wallMaterial).toBe('string');
      expect(typeof b.roofType).toBe('string');
      expect(b.doorFace).toBe('front');
      expect(b.doorPosition).toBeDefined();
    }
  });
});
