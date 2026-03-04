import { describe, it, expect } from 'vitest';
import { runPhase6, PLOT_DIMS } from '../../src/generation/phase6Plots.js';
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
  return { terrainData, roadNetwork, densityField, districts, blocks, plots, ctx };
}

describe('Phase 6: Plot Subdivision', () => {
  it('produces plots', () => {
    const { plots } = setup();
    expect(plots.length).toBeGreaterThan(0);
  });

  it('plots have required fields', () => {
    const { plots } = setup();
    for (const p of plots) {
      expect(p.polygon.length).toBe(4);
      expect(typeof p.frontage).toBe('number');
      expect(typeof p.depth).toBe('number');
      expect(p.frontEdge.length).toBe(2);
      expect(typeof p.style).toBe('string');
      expect(p.setbacks).toBeDefined();
      expect(p.flags).toBeInstanceOf(Set);
    }
  });

  it('plot frontage matches district dimensions (within tolerance)', () => {
    const { plots } = setup();
    for (const p of plots) {
      const dims = PLOT_DIMS[p.districtCharacter];
      if (!dims || dims.frontage[0] === 0) continue;

      // Allow VARIATION + rounding tolerance
      const minF = dims.frontage[0] * 0.7;
      const maxF = dims.frontage[1] * 2.5; // generous tolerance for merged/corner plots
      expect(p.frontage).toBeGreaterThan(minF);
      expect(p.frontage).toBeLessThan(maxF);
    }
  });

  it('some plots have corner flag', () => {
    const { plots } = setup();
    const corners = plots.filter(p => p.flags.has('corner'));
    expect(corners.length).toBeGreaterThan(0);
  });
});
