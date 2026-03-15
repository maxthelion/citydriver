import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { extractZones } from '../../../src/city/pipeline/extractZones.js';

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
    developmentZones: [],
  };

  map.setLayer('slope', new Grid2D(width, height, { ...opts, fill: 0.02 }));
  map.setLayer('waterMask', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('roadGrid', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('landValue', new Grid2D(width, height, { ...opts, fill: 0.6 }));
  map.setLayer('terrainSuitability', new Grid2D(width, height, { ...opts, fill: 0.8 }));
  map.setLayer('elevation', new Grid2D(width, height, { ...opts, fill: 100 }));

  return map;
}

describe('extractZones', () => {
  it('produces development zones for buildable land near nucleus', () => {
    const map = makeTestMap();
    extractZones(map);
    expect(map.developmentZones.length).toBeGreaterThan(0);
  });

  it('sets zoneGrid layer', () => {
    const map = makeTestMap();
    extractZones(map);
    expect(map.hasLayer('zoneGrid')).toBe(true);
    let zoneCells = 0;
    const grid = map.getLayer('zoneGrid');
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) > 0) zoneCells++;
    expect(zoneCells).toBeGreaterThan(0);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    expect(extractZones(map)).toBe(map);
  });
});
