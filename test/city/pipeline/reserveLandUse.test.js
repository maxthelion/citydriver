import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { reserveLandUse } from '../../../src/city/pipeline/reserveLandUse.js';

function makeTestMap() {
  const width = 60, height = 60, cellSize = 5;
  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    developmentZones: [],
  };
  map.setLayer('zoneGrid', new Grid2D(width, height, { type: 'uint8', cellSize }));
  return map;
}

describe('reserveLandUse', () => {
  it('sets reservationGrid layer', () => {
    const map = makeTestMap();
    reserveLandUse(map, null);
    expect(map.hasLayer('reservationGrid')).toBe(true);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    expect(reserveLandUse(map, null)).toBe(map);
  });

  it('produces empty grid when no archetype given', () => {
    const map = makeTestMap();
    reserveLandUse(map, null);
    const grid = map.getLayer('reservationGrid');
    let nonZero = 0;
    grid.forEach((gx, gz, v) => { if (v > 0) nonZero++; });
    expect(nonZero).toBe(0);
  });
});
