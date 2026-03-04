import { describe, it, expect } from 'vitest';
import { runPhase4, CHARACTER } from '../../src/generation/phase4Districts.js';
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
      { point: { x: 155, z: 0 }, hierarchy: 'secondary', destination: 'E' },
      { point: { x: 155, z: 310 }, hierarchy: 'secondary', destination: 'W' },
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
  const { districts } = runPhase4(terrainData, roadNetwork, densityField, ctx, rng.fork('districts'));
  return { terrainData, roadNetwork, densityField, districts, ctx };
}

describe('Phase 4: Districts + Collectors', () => {
  it('produces at least one district', () => {
    const { districts } = setup();
    expect(districts.length).toBeGreaterThanOrEqual(1);
  });

  it('every district has a valid character', () => {
    const { districts } = setup();
    const validChars = Object.values(CHARACTER);
    for (const d of districts) {
      expect(validChars).toContain(d.character);
    }
  });

  it('districts have polygon, centroid, area', () => {
    const { districts } = setup();
    for (const d of districts) {
      expect(d.polygon.length).toBeGreaterThanOrEqual(3);
      expect(typeof d.centroid.x).toBe('number');
      expect(typeof d.centroid.z).toBe('number');
      expect(d.area).toBeGreaterThan(0);
    }
  });

  it('adds collector roads to the network', () => {
    const { roadNetwork } = setup();
    const collectors = roadNetwork.edges.filter(e => e.hierarchy === 'collector');
    expect(collectors.length).toBeGreaterThan(0);
  });

  it('collector roads have width ~12m', () => {
    const { roadNetwork } = setup();
    const collectors = roadNetwork.edges.filter(e => e.hierarchy === 'collector');
    for (const c of collectors) {
      expect(c.width).toBe(8);
    }
  });
});
