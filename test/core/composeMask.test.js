import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { composeBuildability, composeResidentialMask } from '../../src/core/composeMask.js';

function makeLayers(width = 10, height = 10) {
  const map = {
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    _layers: new Map(),
  };

  const terrain = new Grid2D(width, height, { type: 'float32', cellSize: 5, fill: 0.8 });
  const water = new Grid2D(width, height, { type: 'uint8', cellSize: 5 });
  const roads = new Grid2D(width, height, { type: 'uint8', cellSize: 5 });

  map._layers.set('terrainSuitability', terrain);
  map._layers.set('waterMask', water);
  map._layers.set('roadGrid', roads);

  return map;
}

describe('composeBuildability', () => {
  it('returns terrain value for clear cells', () => {
    const map = makeLayers();
    const result = composeBuildability(map);
    expect(result.get(5, 5)).toBeCloseTo(0.8);
  });

  it('returns 0 for water cells', () => {
    const map = makeLayers();
    map.getLayer('waterMask').set(5, 5, 1);
    const result = composeBuildability(map);
    expect(result.get(5, 5)).toBe(0);
  });

  it('returns 0 for road cells', () => {
    const map = makeLayers();
    map.getLayer('roadGrid').set(5, 5, 1);
    const result = composeBuildability(map);
    expect(result.get(5, 5)).toBe(0);
  });
});

describe('composeResidentialMask', () => {
  it('returns 0 for cells outside development zones', () => {
    const map = makeLayers();
    const zones = new Grid2D(10, 10, { type: 'uint8' });
    map._layers.set('zoneGrid', zones);
    const result = composeResidentialMask(map);
    expect(result.get(5, 5)).toBe(0);
  });

  it('returns terrain value for zoned unreserved cells', () => {
    const map = makeLayers();
    const zones = new Grid2D(10, 10, { type: 'uint8' });
    zones.set(5, 5, 1);
    map._layers.set('zoneGrid', zones);
    const result = composeResidentialMask(map);
    expect(result.get(5, 5)).toBeCloseTo(0.8);
  });

  it('returns 0 for reserved cells', () => {
    const map = makeLayers();
    const zones = new Grid2D(10, 10, { type: 'uint8' });
    zones.set(5, 5, 1);
    const reservations = new Grid2D(10, 10, { type: 'uint8' });
    reservations.set(5, 5, 1);
    map._layers.set('zoneGrid', zones);
    map._layers.set('reservationGrid', reservations);
    const result = composeResidentialMask(map);
    expect(result.get(5, 5)).toBe(0);
  });
});
