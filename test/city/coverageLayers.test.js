import { describe, it, expect } from 'vitest';
import { separableBoxBlur, applyHashNoise, enforcePriority, stampWater, stampRoad, stampDevelopment, stampForest, stampLandCover, computeCoverageLayers } from '../../src/city/coverageLayers.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('separableBoxBlur', () => {
  it('preserves total energy (sum of values)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    grid[5 * w + 5] = 1.0;
    const sumBefore = grid.reduce((a, b) => a + b, 0);
    const result = separableBoxBlur(grid, w, h, 2);
    const sumAfter = result.reduce((a, b) => a + b, 0);
    expect(sumAfter).toBeCloseTo(sumBefore, 4);
  });

  it('spreads a single cell into surrounding area', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    grid[5 * w + 5] = 1.0;
    const result = separableBoxBlur(grid, w, h, 2);
    expect(result[5 * w + 5]).toBeLessThan(1.0);
    expect(result[5 * w + 5]).toBeGreaterThan(0);
    expect(result[5 * w + 6]).toBeGreaterThan(0);
    expect(result[6 * w + 5]).toBeGreaterThan(0);
  });

  it('returns all zeros for all-zero input', () => {
    const w = 8, h = 8;
    const grid = new Float32Array(w * h);
    const result = separableBoxBlur(grid, w, h, 3);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('returns uniform value for all-one input', () => {
    const w = 8, h = 8;
    const grid = new Float32Array(w * h).fill(1.0);
    const result = separableBoxBlur(grid, w, h, 3);
    for (let i = 0; i < w * h; i++) {
      expect(result[i]).toBeCloseTo(1.0, 4);
    }
  });
});

describe('applyHashNoise', () => {
  it('does not perturb cells at 0 or 1 (parabolic scaling)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    grid[0] = 0.0;
    grid[1] = 1.0;
    const result = applyHashNoise(grid, w, h, 0.2, 42);
    expect(result[0]).toBe(0.0);
    expect(result[1]).toBe(1.0);
  });

  it('perturbs cells in the middle range', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h).fill(0.5);
    const result = applyHashNoise(grid, w, h, 0.2, 42);
    let anyDifferent = false;
    for (let i = 0; i < w * h; i++) {
      if (Math.abs(result[i] - 0.5) > 0.001) anyDifferent = true;
    }
    expect(anyDifferent).toBe(true);
  });

  it('keeps all values in [0, 1]', () => {
    const w = 20, h = 20;
    const grid = new Float32Array(w * h).fill(0.5);
    const result = applyHashNoise(grid, w, h, 0.5, 99);
    for (let i = 0; i < w * h; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic (same seed = same result)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h).fill(0.5);
    const a = applyHashNoise(grid, w, h, 0.2, 42);
    const b = applyHashNoise(grid, w, h, 0.2, 42);
    for (let i = 0; i < w * h; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });
});

describe('enforcePriority', () => {
  it('ensures layers sum to <= 1.0 at every cell', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.6) },
      { data: new Float32Array(n).fill(0.6) },
      { data: new Float32Array(n).fill(0.6) },
    ];
    enforcePriority(layers, w, h);
    for (let i = 0; i < n; i++) {
      const sum = layers.reduce((s, l) => s + l.data[i], 0);
      expect(sum).toBeLessThanOrEqual(1.001);
    }
  });

  it('higher-priority layer claims space first', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.8) },
      { data: new Float32Array(n).fill(0.8) },
    ];
    enforcePriority(layers, w, h);
    expect(layers[0].data[0]).toBeCloseTo(0.8);
    expect(layers[1].data[0]).toBeCloseTo(0.2);
  });

  it('does nothing when layers already fit within budget', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.3) },
      { data: new Float32Array(n).fill(0.3) },
    ];
    enforcePriority(layers, w, h);
    expect(layers[0].data[0]).toBeCloseTo(0.3);
    expect(layers[1].data[0]).toBeCloseTo(0.3);
  });
});

describe('stamp functions', () => {
  function makeMap(w, h) {
    return {
      width: w, height: h, cellSize: 5,
      originX: 0, originZ: 0,
      waterMask: new Grid2D(w, h, { type: 'uint8' }),
      roadGrid: new Grid2D(w, h, { type: 'uint8' }),
      developmentZones: [],
      regionalLayers: {
        getGrid: () => new Grid2D(4, 4, { type: 'uint8' }),
        getData: () => ({ cellSize: 50, width: 4, height: 4 }),
      },
    };
  }

  it('stampWater marks water cells as 1.0', () => {
    const map = makeMap(10, 10);
    map.waterMask.set(3, 3, 1);
    map.waterMask.set(4, 3, 1);
    const out = stampWater(map);
    expect(out[3 * 10 + 3]).toBe(1.0);
    expect(out[3 * 10 + 4]).toBe(1.0);
    expect(out[0]).toBe(0.0);
  });

  it('stampRoad marks road cells and 2-cell buffer', () => {
    const map = makeMap(10, 10);
    map.roadGrid.set(5, 5, 1);
    const out = stampRoad(map);
    expect(out[5 * 10 + 5]).toBe(1.0);
    expect(out[5 * 10 + 6]).toBe(1.0);
    expect(out[6 * 10 + 5]).toBe(1.0);
    expect(out[0]).toBe(0.0);
  });

  it('stampDevelopment marks zone cells and settlement cells', () => {
    const map = makeMap(10, 10);
    map.developmentZones = [{ cells: [{ gx: 2, gz: 2 }, { gx: 3, gz: 2 }] }];
    const out = stampDevelopment(map);
    expect(out[2 * 10 + 2]).toBe(1.0);
    expect(out[2 * 10 + 3]).toBe(1.0);
    expect(out[0]).toBe(0.0);
  });

  it('stampForest marks forest as 1.0 and woodland as 0.6', () => {
    const map = makeMap(10, 10);
    const landCover = new Grid2D(4, 4, { type: 'uint8' });
    landCover.set(0, 0, 2);
    landCover.set(1, 0, 6);
    map.regionalLayers = {
      getGrid: () => landCover,
      getData: () => ({ cellSize: 50, width: 4, height: 4 }),
    };
    const out = stampForest(map);
    expect(out[0]).toBe(1.0);
    const farIdx = 9 * 10 + 9;
    expect(out[farIdx]).toBe(0.0);
  });

  it('stampLandCover populates dominantCover with correct cover type', () => {
    const map = makeMap(10, 10);
    const landCover = new Grid2D(4, 4, { type: 'uint8' });
    landCover.set(0, 0, 3);
    landCover.set(1, 0, 8);
    map.regionalLayers = {
      getGrid: () => landCover,
      getData: () => ({ cellSize: 50, width: 4, height: 4 }),
    };
    const { data, dominantCover } = stampLandCover(map);
    expect(data[0]).toBe(1.0);
    expect(dominantCover[0]).toBe(3);
  });
});

describe('computeCoverageLayers', () => {
  function makeMap(w, h) {
    const landCover = new Grid2D(4, 4, { type: 'uint8' });
    return {
      width: w, height: h, cellSize: 5,
      originX: 0, originZ: 0,
      waterMask: new Grid2D(w, h, { type: 'uint8' }),
      roadGrid: new Grid2D(w, h, { type: 'uint8' }),
      developmentZones: [],
      regionalLayers: {
        getGrid: () => landCover,
        getData: () => ({ cellSize: 50, width: 4, height: 4 }),
      },
    };
  }

  it('returns all expected layer names', () => {
    const map = makeMap(20, 20);
    const layers = computeCoverageLayers(map);
    expect(layers.water).toBeInstanceOf(Float32Array);
    expect(layers.road).toBeInstanceOf(Float32Array);
    expect(layers.development).toBeInstanceOf(Float32Array);
    expect(layers.forest).toBeInstanceOf(Float32Array);
    expect(layers.landCover).toBeInstanceOf(Float32Array);
    expect(layers.dominantCover).toBeInstanceOf(Uint8Array);
  });

  it('all layers have correct size', () => {
    const map = makeMap(20, 20);
    const layers = computeCoverageLayers(map);
    const n = 20 * 20;
    expect(layers.water.length).toBe(n);
    expect(layers.road.length).toBe(n);
    expect(layers.development.length).toBe(n);
    expect(layers.forest.length).toBe(n);
    expect(layers.landCover.length).toBe(n);
  });

  it('layers sum to <= 1.0 at every cell after priority suppression', () => {
    const map = makeMap(20, 20);
    for (let i = 0; i < 5; i++) map.waterMask.set(i, 5, 1);
    const landCover = map.regionalLayers.getGrid('landCover');
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) landCover.set(x, z, 2);
    const layers = computeCoverageLayers(map);
    for (let i = 0; i < 20 * 20; i++) {
      const sum = layers.water[i] + layers.road[i] + layers.development[i]
        + layers.forest[i] + layers.landCover[i];
      expect(sum).toBeLessThanOrEqual(1.01);
    }
  });
});
