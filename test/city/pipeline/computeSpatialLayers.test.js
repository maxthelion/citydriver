import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { computeSpatialLayers } from '../../../src/city/pipeline/computeSpatialLayers.js';

function makeTestMap() {
  const width = 60, height = 60, cellSize = 5;
  const opts = { cellSize, originX: 0, originZ: 0 };
  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    nuclei: [{ gx: 30, gz: 30, type: 'market' }],
  };

  map.setLayer('terrainSuitability', new Grid2D(width, height, { ...opts, fill: 0.8 }));
  map.setLayer('waterMask', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('waterDist', new Grid2D(width, height, { ...opts, fill: 50 }));
  map.setLayer('roadGrid', new Grid2D(width, height, { ...opts, type: 'uint8' }));

  return map;
}

describe('computeSpatialLayers', () => {
  it('sets centrality layer', () => {
    const map = makeTestMap();
    computeSpatialLayers(map);
    expect(map.hasLayer('centrality')).toBe(true);
    expect(map.getLayer('centrality').get(30, 30)).toBeGreaterThan(0.5);
    // Corner cell is ~42 cells from nucleus; centrality lower than centre
    expect(map.getLayer('centrality').get(0, 0)).toBeLessThan(
      map.getLayer('centrality').get(30, 30)
    );
  });

  it('sets waterfrontness layer', () => {
    const map = makeTestMap();
    map.getLayer('waterMask').set(29, 30, 1);
    map.getLayer('waterDist').set(30, 30, 1);
    map.getLayer('waterDist').set(28, 30, 0);
    computeSpatialLayers(map);
    expect(map.hasLayer('waterfrontness')).toBe(true);
    expect(map.getLayer('waterfrontness').get(30, 30)).toBeGreaterThan(0.5);
    expect(map.getLayer('waterfrontness').get(0, 0)).toBeLessThan(0.1);
  });

  it('sets edgeness layer (inverse of centrality)', () => {
    const map = makeTestMap();
    computeSpatialLayers(map);
    expect(map.hasLayer('edgeness')).toBe(true);
    const centre = map.getLayer('edgeness').get(30, 30);
    const edge = map.getLayer('edgeness').get(55, 55);
    expect(edge).toBeGreaterThan(centre);
  });

  it('sets roadFrontage layer', () => {
    const map = makeTestMap();
    for (let gx = 0; gx < 60; gx++) map.getLayer('roadGrid').set(gx, 30, 1);
    computeSpatialLayers(map);
    expect(map.hasLayer('roadFrontage')).toBe(true);
    expect(map.getLayer('roadFrontage').get(20, 30)).toBeGreaterThan(0.3);
    expect(map.getLayer('roadFrontage').get(20, 0)).toBeLessThan(0.1);
  });

  it('sets downwindness layer', () => {
    const map = makeTestMap();
    map.prevailingWindAngle = 0; // wind blows in +x direction
    computeSpatialLayers(map);
    expect(map.hasLayer('downwindness')).toBe(true);
    const downwind = map.getLayer('downwindness').get(55, 30);
    const upwind = map.getLayer('downwindness').get(5, 30);
    expect(downwind).toBeGreaterThan(upwind);
  });

  it('downwindness defaults to seed-derived angle when not set', () => {
    const map = makeTestMap();
    computeSpatialLayers(map);
    expect(map.hasLayer('downwindness')).toBe(true);
    let hasNonZero = false;
    const grid = map.getLayer('downwindness');
    for (let gz = 0; gz < 60; gz += 10)
      for (let gx = 0; gx < 60; gx += 10)
        if (grid.get(gx, gz) > 0.01) hasNonZero = true;
    expect(hasNonZero).toBe(true);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    expect(computeSpatialLayers(map)).toBe(map);
  });
});
