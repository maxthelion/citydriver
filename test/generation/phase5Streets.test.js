import { describe, it, expect } from 'vitest';
import { runPhase5 } from '../../src/generation/phase5Streets.js';
import { runPhase4 } from '../../src/generation/phase4Districts.js';
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
  const { blocks } = runPhase5(terrainData, roadNetwork, densityField, districts, rng.fork('streets'));
  return { terrainData, roadNetwork, densityField, districts, blocks, ctx };
}

describe('Phase 5: Local Streets + Blocks', () => {
  it('adds local streets to the network', () => {
    const { roadNetwork } = setup();
    const locals = roadNetwork.edges.filter(e => e.hierarchy === 'local');
    expect(locals.length).toBeGreaterThan(0);
  });

  it('local streets have width ~10m', () => {
    const { roadNetwork } = setup();
    const locals = roadNetwork.edges.filter(e => e.hierarchy === 'local');
    for (const l of locals) {
      expect(l.width).toBe(6);
    }
  });

  it('produces city blocks', () => {
    const { blocks } = setup();
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('blocks have polygon, centroid, area, district info', () => {
    const { blocks } = setup();
    for (const b of blocks) {
      expect(b.polygon.length).toBeGreaterThanOrEqual(3);
      expect(typeof b.centroid.x).toBe('number');
      expect(typeof b.centroid.z).toBe('number');
      expect(b.area).toBeGreaterThan(0);
      expect(typeof b.districtCharacter).toBe('string');
    }
  });

  it('blocks have density values', () => {
    const { blocks } = setup();
    for (const b of blocks) {
      expect(typeof b.density).toBe('number');
    }
  });
});
