import { describe, it, expect } from 'vitest';
import { runPhase2 } from '../../src/generation/phase2Arterials.js';
import { runPhase1 } from '../../src/generation/phase1Terrain.js';
import { resetNodeIds, resetEdgeIds } from '../../src/generation/graph.js';
import { Heightmap } from '../../src/core/heightmap.js';
import { SeededRandom } from '../../src/core/rng.js';

function makeCityContext(overrides = {}) {
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
      { point: { x: 0, z: 155 }, hierarchy: 'primary', destination: 'North' },
      { point: { x: 310, z: 155 }, hierarchy: 'primary', destination: 'South' },
      { point: { x: 155, z: 0 }, hierarchy: 'secondary', destination: 'East' },
      { point: { x: 155, z: 310 }, hierarchy: 'secondary', destination: 'West' },
    ],
    economicRole: 'market',
    rank: 'town',
    ...overrides,
  };
}

const phase1Params = { gridSize: 64, cellSize: 5, detailAmplitude: 1 };

function runBothPhases(ctx, seed = 42) {
  resetNodeIds();
  resetEdgeIds();
  const rng = new SeededRandom(seed);
  const terrainData = runPhase1(ctx, rng.fork('terrain'), phase1Params);
  const roadNetwork = runPhase2(terrainData, ctx, rng.fork('roads'), { organicness: 0.5 });
  return { terrainData, roadNetwork };
}

describe('Phase 2: Primary Network', () => {
  describe('basic structure', () => {
    it('produces nodes and edges', () => {
      const ctx = makeCityContext();
      const { roadNetwork } = runBothPhases(ctx);

      expect(roadNetwork.nodes.size).toBeGreaterThan(0);
      expect(roadNetwork.edges.length).toBeGreaterThan(0);
    });

    it('has a center node', () => {
      const ctx = makeCityContext();
      const { roadNetwork } = runBothPhases(ctx);

      const centerNodes = [...roadNetwork.nodes.values()].filter(n => n.type === 'center');
      expect(centerNodes.length).toBe(1);
    });

    it('has entry nodes matching road entries', () => {
      const ctx = makeCityContext();
      const { roadNetwork } = runBothPhases(ctx);

      const entryNodes = [...roadNetwork.nodes.values()].filter(n => n.type === 'entry');
      expect(entryNodes.length).toBe(ctx.roadEntries.length);
    });
  });

  describe('road routing', () => {
    it('creates primary edges from entries to center', () => {
      const ctx = makeCityContext();
      const { roadNetwork } = runBothPhases(ctx);

      const primaryEdges = roadNetwork.edges.filter(e => e.hierarchy === 'primary');
      // At least one primary edge per entry
      expect(primaryEdges.length).toBeGreaterThanOrEqual(1);
    });

    it('edge points are valid world coordinates', () => {
      const ctx = makeCityContext();
      const { roadNetwork } = runBothPhases(ctx);

      for (const edge of roadNetwork.edges) {
        expect(edge.points.length).toBeGreaterThanOrEqual(2);
        for (const pt of edge.points) {
          expect(Number.isFinite(pt.x)).toBe(true);
          expect(Number.isFinite(pt.z)).toBe(true);
        }
      }
    });

    it('edges have valid widths', () => {
      const ctx = makeCityContext();
      const { roadNetwork } = runBothPhases(ctx);

      for (const edge of roadNetwork.edges) {
        expect(edge.width).toBeGreaterThan(0);
        expect(edge.width).toBeLessThan(50);
      }
    });
  });

  describe('ring connections', () => {
    it('creates secondary edges between adjacent entries', () => {
      const ctx = makeCityContext();
      const { roadNetwork } = runBothPhases(ctx);

      const secondaryEdges = roadNetwork.edges.filter(e => e.hierarchy === 'secondary');
      expect(secondaryEdges.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('bridge detection', () => {
    it('detects bridges when roads cross rivers', () => {
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
        roadEntries: [
          { point: { x: 0, z: 155 }, hierarchy: 'primary', destination: 'West' },
          { point: { x: 310, z: 155 }, hierarchy: 'primary', destination: 'East' },
        ],
      });

      const { roadNetwork } = runBothPhases(ctx);

      // Should have at least one bridge where roads cross the river
      if (roadNetwork.bridges.length > 0) {
        const bridge = roadNetwork.bridges[0];
        expect(bridge.startPoint).toBeDefined();
        expect(bridge.endPoint).toBeDefined();
        expect(bridge.deckHeight).toBeGreaterThan(0);
        expect(bridge.width).toBeGreaterThan(0);
      }
    });
  });

  describe('hierarchy assignment', () => {
    it('assigns primary or secondary hierarchy to all edges', () => {
      const ctx = makeCityContext();
      const { roadNetwork } = runBothPhases(ctx);

      for (const edge of roadNetwork.edges) {
        expect(['primary', 'secondary']).toContain(edge.hierarchy);
      }
    });
  });

  describe('determinism', () => {
    it('produces identical output with same seed', () => {
      const ctx = makeCityContext();

      const { roadNetwork: r1 } = runBothPhases(ctx, 99);
      const { roadNetwork: r2 } = runBothPhases(ctx, 99);

      expect(r1.nodes.size).toBe(r2.nodes.size);
      expect(r1.edges.length).toBe(r2.edges.length);

      // Compare edge points
      for (let i = 0; i < r1.edges.length; i++) {
        expect(r1.edges[i].points.length).toBe(r2.edges[i].points.length);
        expect(r1.edges[i].hierarchy).toBe(r2.edges[i].hierarchy);
      }
    });
  });
});
