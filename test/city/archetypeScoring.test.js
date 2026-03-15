import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { scoreSettlement, compareArchetypes } from '../../src/city/archetypeScoring.js';
import { computeSpatialLayers } from '../../src/city/pipeline/computeSpatialLayers.js';

function makeTestMap(opts = {}) {
  const width = 60, height = 60, cellSize = 5;
  const gridOpts = { cellSize, originX: 0, originZ: 0 };
  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    nuclei: opts.nuclei || [{ gx: 30, gz: 30, type: 'market' }],
    roads: opts.roads || [],
    rivers: opts.rivers || [],
    settlement: opts.settlement || { tier: 3 },
  };

  map.setLayer('terrainSuitability', new Grid2D(width, height, {
    ...gridOpts, fill: opts.flatness || 0.8,
  }));
  map.setLayer('waterMask', new Grid2D(width, height, { ...gridOpts, type: 'uint8' }));
  map.setLayer('waterDist', new Grid2D(width, height, { ...gridOpts, fill: opts.waterDist || 100 }));
  map.setLayer('roadGrid', new Grid2D(width, height, { ...gridOpts, type: 'uint8' }));

  return map;
}

describe('scoreSettlement', () => {
  it('returns scores for all 5 archetypes', () => {
    const map = makeTestMap();
    const results = scoreSettlement(map);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.archetype).toBeDefined();
      expect(typeof r.score).toBe('number');
      expect(r.factors).toBeInstanceOf(Array);
    }
  });

  it('market town is always viable', () => {
    const map = makeTestMap();
    const results = scoreSettlement(map);
    const mt = results.find(r => r.archetype.id === 'marketTown');
    expect(mt.score).toBeGreaterThan(0);
  });

  it('port city scores high with waterfront', () => {
    const map = makeTestMap();
    const wm = map.getLayer('waterMask');
    const wd = map.getLayer('waterDist');
    for (let gz = 0; gz < 60; gz++) {
      for (let gx = 0; gx < 10; gx++) wm.set(gx, gz, 1);
      for (let gx = 10; gx < 20; gx++) wd.set(gx, gz, gx - 10);
    }
    const results = scoreSettlement(map);
    const port = results.find(r => r.archetype.id === 'portCity');
    expect(port.score).toBeGreaterThan(0.3);
  });

  it('port city scores low without waterfront', () => {
    const map = makeTestMap({ waterDist: 200 });
    const results = scoreSettlement(map);
    const port = results.find(r => r.archetype.id === 'portCity');
    expect(port.score).toBeLessThan(0.2);
  });

  it('results are sorted by score descending', () => {
    const map = makeTestMap();
    const results = scoreSettlement(map);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

describe('compareArchetypes', () => {
  it('returns results for all 5 archetypes with reservation grids', () => {
    const map = makeTestMap();

    const zoneCells = [];
    const zoneGrid = new Grid2D(60, 60, { type: 'uint8', cellSize: 5 });
    for (let gz = 10; gz < 50; gz++) {
      for (let gx = 10; gx < 50; gx++) {
        zoneCells.push({ gx, gz });
        zoneGrid.set(gx, gz, 1);
      }
    }
    map.setLayer('zoneGrid', zoneGrid);
    map.developmentZones = [{ id: 1, cells: zoneCells, nucleusIdx: 0 }];
    computeSpatialLayers(map);

    const results = compareArchetypes(map);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.archetype).toBeDefined();
      expect(r.score).toBeDefined();
      expect(r.reservationGrid).toBeInstanceOf(Grid2D);
    }
  });
});
