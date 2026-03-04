import { describe, it, expect } from 'vitest';
import { generateCity } from '../../src/city/pipeline.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('City Pipeline (Phases 7-8)', () => {
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

  it('has density field', { timeout: 15000 }, () => {
    const city = makeCity();
    const density = city.getGrid('density');
    expect(density).toBeDefined();

    // Density should have values in [0, 1]
    let hasPositive = false;
    density.forEach((gx, gz, val) => {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
      if (val > 0) hasPositive = true;
    });
    expect(hasPositive).toBe(true);
  });

  it('density is highest near center', () => {
    const city = makeCity();
    const density = city.getGrid('density');
    const params = city.getData('params');

    // Sample a ring near center and edges, compare averages
    const cx = Math.floor(params.width / 2);
    const cz = Math.floor(params.height / 2);
    let centerSum = 0, centerN = 0;
    let edgeSum = 0, edgeN = 0;
    const r = 3;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const v = density.get(cx + dx, cz + dz);
        if (v >= 0) { centerSum += v; centerN++; }
      }
    }
    // Sample all edge cells
    for (let i = 0; i < params.width; i++) {
      edgeSum += density.get(i, 0) + density.get(i, params.height - 1);
      edgeN += 2;
    }
    const centerAvg = centerN > 0 ? centerSum / centerN : 0;
    const edgeAvg = edgeN > 0 ? edgeSum / edgeN : 0;

    expect(centerAvg).toBeGreaterThanOrEqual(edgeAvg);
  });

  it('road graph is connected', () => {
    const city = makeCity();
    const graph = city.getData('roadGraph');
    expect(graph.isConnected()).toBe(true);
  });

  it('most road seeds not in water', () => {
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
    // Most seeds should be on land (allow tolerance for river crossings)
    if (totalSeeds > 2) {
      expect(seedsInWater / totalSeeds).toBeLessThan(0.5);
    }
  });
});
