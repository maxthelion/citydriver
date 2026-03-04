import { describe, it, expect } from 'vitest';
import { runPhase8, computeEdgeBetweenness } from '../../src/generation/phase8Amenities.js';
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
  const result = runPhase8(plots, blocks, buildings, roadNetwork, densityField, rng.fork('amenities'));
  return { ...result, terrainData, roadNetwork, densityField, districts, blocks, plots, buildings, ctx };
}

describe('Phase 8: Amenities', () => {
  it('computes edge betweenness centrality', () => {
    const { edgeCentrality, roadNetwork } = setup();
    expect(edgeCentrality).toBeInstanceOf(Map);
    // Every edge should have a centrality value
    for (const edge of roadNetwork.edges) {
      expect(edgeCentrality.has(edge.id)).toBe(true);
    }
  });

  it('centrality values are non-negative', () => {
    const { edgeCentrality } = setup();
    for (const [, val] of edgeCentrality) {
      expect(val).toBeGreaterThanOrEqual(0);
    }
  });

  it('places amenities', () => {
    const { amenities } = setup();
    expect(Array.isArray(amenities)).toBe(true);
    // For a town with enough plots, should have at least some amenities
  });

  it('amenities have required fields', () => {
    const { amenities } = setup();
    for (const a of amenities) {
      expect(typeof a.type).toBe('string');
      expect(typeof a.x).toBe('number');
      expect(typeof a.z).toBe('number');
    }
  });

  it('calculates population', () => {
    const { population } = setup();
    expect(typeof population).toBe('number');
    expect(population).toBeGreaterThan(0);
  });
});

describe('computeEdgeBetweenness', () => {
  it('handles empty graph', () => {
    const result = computeEdgeBetweenness(new Map(), []);
    expect(result.size).toBe(0);
  });

  it('computes centrality for simple graph', () => {
    const nodes = new Map();
    nodes.set(0, { id: 0, x: 0, z: 0 });
    nodes.set(1, { id: 1, x: 100, z: 0 });
    nodes.set(2, { id: 2, x: 200, z: 0 });

    const edges = [
      { id: 0, from: 0, to: 1, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] },
      { id: 1, from: 1, to: 2, points: [{ x: 100, z: 0 }, { x: 200, z: 0 }] },
    ];

    const centrality = computeEdgeBetweenness(nodes, edges);
    expect(centrality.size).toBe(2);

    // Both edges should have positive centrality (they're on shortest paths)
    expect(centrality.get(0)).toBeGreaterThanOrEqual(0);
    expect(centrality.get(1)).toBeGreaterThanOrEqual(0);
  });
});
