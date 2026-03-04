import { describe, it, expect } from 'vitest';
import { runPhase3 } from '../../src/generation/phase3Density.js';
import { runPhase1 } from '../../src/generation/phase1Terrain.js';
import { runPhase2 } from '../../src/generation/phase2Arterials.js';
import { resetNodeIds, resetEdgeIds } from '../../src/generation/graph.js';
import { Heightmap } from '../../src/core/heightmap.js';
import { SeededRandom } from '../../src/core/rng.js';

function makeCityContext() {
  const gridSize = 32;
  const cellSize = 10;
  const regionHm = new Heightmap(gridSize, gridSize, cellSize);
  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      regionHm.set(gx, gz, 50 - gx * 0.1 - gz * 0.1);
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
      { point: { x: 0, z: 155 }, hierarchy: 'primary', destination: 'N' },
      { point: { x: 310, z: 155 }, hierarchy: 'primary', destination: 'S' },
    ],
    economicRole: 'market',
    rank: 'town',
  };
}

const p1Params = { gridSize: 64, cellSize: 5, detailAmplitude: 1 };

function setup(seed = 42) {
  resetNodeIds();
  resetEdgeIds();
  const rng = new SeededRandom(seed);
  const ctx = makeCityContext();
  const terrainData = runPhase1(ctx, rng.fork('terrain'), p1Params);
  const roadNetwork = runPhase2(terrainData, ctx, rng.fork('roads'));
  const densityField = runPhase3(terrainData, roadNetwork, ctx, rng.fork('density'));
  return { terrainData, roadNetwork, densityField, ctx };
}

describe('Phase 3: Density Field', () => {
  it('produces a grid of correct dimensions', () => {
    const { densityField } = setup();
    expect(densityField.grid).toBeInstanceOf(Float32Array);
    expect(densityField.gridWidth).toBeGreaterThan(0);
    expect(densityField.gridHeight).toBeGreaterThan(0);
    expect(densityField.grid.length).toBe(densityField.gridWidth * densityField.gridHeight);
  });

  it('density values are in [0, 1]', () => {
    const { densityField } = setup();
    for (let i = 0; i < densityField.grid.length; i++) {
      expect(densityField.grid[i]).toBeGreaterThanOrEqual(0);
      expect(densityField.grid[i]).toBeLessThanOrEqual(1);
    }
  });

  it('has at least one district center', () => {
    const { densityField } = setup();
    expect(densityField.districtCenters.length).toBeGreaterThanOrEqual(1);
  });

  it('district centers have x, z, density, type', () => {
    const { densityField } = setup();
    for (const dc of densityField.districtCenters) {
      expect(typeof dc.x).toBe('number');
      expect(typeof dc.z).toBe('number');
      expect(typeof dc.density).toBe('number');
      expect(typeof dc.type).toBe('string');
    }
  });

  it('sampleDensity returns reasonable values', () => {
    const { densityField } = setup();
    const val = densityField.sampleDensity(150, 150);
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(1);
  });

  it('density is higher near city center than at edges', () => {
    const { densityField } = setup();
    const centerDensity = densityField.sampleDensity(155, 155);
    const edgeDensity = densityField.sampleDensity(10, 10);
    expect(centerDensity).toBeGreaterThan(edgeDensity);
  });

  it('has target population', () => {
    const { densityField } = setup();
    expect(densityField.targetPopulation).toBeGreaterThan(0);
  });
});
