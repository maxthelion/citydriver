import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { computeLandValue } from '../../../src/city/pipeline/computeLandValue.js';

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

  map.setLayer('elevation', new Grid2D(width, height, { ...opts, fill: 100 }));
  map.setLayer('slope', new Grid2D(width, height, { ...opts, fill: 0.02 }));
  map.setLayer('waterMask', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('terrainSuitability', new Grid2D(width, height, { ...opts, fill: 0.9 }));
  map.setLayer('waterDist', new Grid2D(width, height, { ...opts, fill: 100 }));

  return map;
}

describe('computeLandValue', () => {
  it('flat ground near nucleus has high value', () => {
    const map = makeTestMap();
    computeLandValue(map);
    expect(map.getLayer('landValue').get(30, 30)).toBeGreaterThan(0.7);
  });

  it('flat ground far from nucleus has lower value', () => {
    const map = makeTestMap();
    computeLandValue(map);
    const center = map.getLayer('landValue').get(30, 30);
    const far = map.getLayer('landValue').get(55, 55);
    expect(center).toBeGreaterThan(far);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    const result = computeLandValue(map);
    expect(result).toBe(map);
  });
});
