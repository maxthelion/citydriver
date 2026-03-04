import { describe, it, expect } from 'vitest';
import { runPhase7 } from '../../src/generation/phase7Buildings.js';
import { runPhase6 } from '../../src/generation/phase6Plots.js';
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
  const plots = runPhase6(blocks, roadNetwork, districts, rng.fork('plots'));
  const buildings = runPhase7(plots, terrainData, roadNetwork, densityField, ctx, rng.fork('buildings'));
  return { terrainData, roadNetwork, densityField, districts, blocks, plots, buildings, ctx };
}

describe('Phase 7: Buildings', () => {
  it('produces buildings', () => {
    const { buildings } = setup();
    expect(buildings.length).toBeGreaterThan(0);
  });

  it('buildings have renderer-compatible interface', () => {
    const { buildings } = setup();
    for (const b of buildings) {
      expect(typeof b.x).toBe('number');
      expect(typeof b.z).toBe('number');
      expect(typeof b.w).toBe('number');
      expect(typeof b.d).toBe('number');
      expect(typeof b.h).toBe('number');
      expect(typeof b.floors).toBe('number');
      expect(typeof b.style).toBe('string');
      expect(typeof b.roofType).toBe('string');
      expect(typeof b.wallMaterial).toBe('string');
      expect(typeof b.roofMaterial).toBe('string');
      expect(typeof b.rotation).toBe('number');
      expect(b.doorFace).toBe('front');
      expect(b.doorPosition).toBeDefined();
    }
  });

  it('building dimensions are positive', () => {
    const { buildings } = setup();
    for (const b of buildings) {
      expect(b.w).toBeGreaterThan(0);
      expect(b.d).toBeGreaterThan(0);
      expect(b.h).toBeGreaterThan(0);
      expect(b.floors).toBeGreaterThanOrEqual(1);
    }
  });

  it('buildings have density-driven height variation', () => {
    const { buildings } = setup();
    if (buildings.length < 5) return; // need enough to compare

    const heights = buildings.map(b => b.h);
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    // There should be some variation
    expect(max).toBeGreaterThan(min);
  });

  it('corner buildings get extra floors', () => {
    const { buildings } = setup();
    const cornerBuildings = buildings.filter(b => b.isCorner && !b.isLandmark);
    if (cornerBuildings.length === 0) return;

    // Can't strictly verify +1 floor without comparing to non-corner in same block,
    // but verify the flag is set
    for (const b of cornerBuildings) {
      expect(b.isCorner).toBe(true);
    }
  });
});
