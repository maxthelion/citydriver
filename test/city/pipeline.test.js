import { describe, it, expect } from 'vitest';
import { generateCity } from '../../src/city/pipeline.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('City Pipeline (V4)', () => {
  function makeCity(seed = 42) {
    const rng = new SeededRandom(seed);
    const regionalLayers = generateRegion({ width: 64, height: 64, cellSize: 50, coastEdges: ['west'] }, rng);
    const settlements = regionalLayers.getData('settlements');
    expect(settlements.length).toBeGreaterThan(0);
    const settlement = settlements[0];
    return generateCity(regionalLayers, settlement, rng.fork('city'), { cityRadius: 15, cityCellSize: 10 });
  }

  it('produces a LayerStack with city params', () => {
    const city = makeCity();
    const params = city.getData('params');
    expect(params).toBeDefined();
    expect(params.cellSize).toBe(10);
    expect(params.width).toBeGreaterThan(0);
    expect(params.height).toBeGreaterThan(0);
  });

  it('has refined elevation', () => {
    const city = makeCity();
    const elev = city.getGrid('elevation');
    expect(elev).toBeDefined();
    const { min, max } = elev.bounds();
    expect(isFinite(min)).toBe(true);
    expect(isFinite(max)).toBe(true);
  });

  it('has slope grid', () => {
    const city = makeCity();
    expect(city.getGrid('slope')).toBeDefined();
  });

  it('has road graph with nodes and edges', () => {
    const city = makeCity();
    const graph = city.getData('roadGraph');
    expect(graph).toBeDefined();
    expect(graph.nodes.size).toBeGreaterThan(0);
    expect(graph.edges.size).toBeGreaterThan(0);
  });

  it('has nuclei', () => {
    const city = makeCity();
    const nuclei = city.getData('nuclei');
    expect(nuclei).toBeDefined();
    expect(nuclei.length).toBeGreaterThan(0);
    // Primary nucleus should be oldTown
    expect(nuclei[0].type).toBe('oldTown');
  });

  it('has occupancy grid', () => {
    const city = makeCity();
    const occupancy = city.getData('occupancy');
    expect(occupancy).toBeDefined();
    expect(occupancy.data).toBeInstanceOf(Uint8Array);
    expect(occupancy.width).toBeGreaterThan(0);
  });

  it('road graph is connected', { timeout: 15000 }, () => {
    const city = makeCity();
    const graph = city.getData('roadGraph');
    expect(graph.isConnected()).toBe(true);
  });

  it('most road seeds not in water', { timeout: 15000 }, () => {
    const city = makeCity();
    const graph = city.getData('roadGraph');
    const waterMask = city.getGrid('waterMask');
    const params = city.getData('params');

    if (!waterMask) return;

    let seedsInWater = 0;
    let totalSeeds = 0;
    for (const [, node] of graph.nodes) {
      if (node.attrs?.type === 'seed') {
        totalSeeds++;
        const gx = Math.round(node.x / params.cellSize);
        const gz = Math.round(node.z / params.cellSize);
        if (waterMask.get(gx, gz) > 0) seedsInWater++;
      }
    }
    if (totalSeeds > 2) {
      expect(seedsInWater / totalSeeds).toBeLessThan(0.5);
    }
  });
});
