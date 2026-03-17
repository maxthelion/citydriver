// test/city/pipeline/growthTick.test.js
import { describe, it, expect } from 'vitest';
import { initGrowthState, runGrowthTick } from '../../../src/city/pipeline/growthTick.js';
import { RESERVATION } from '../../../src/city/pipeline/growthAgents.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

// Minimal map stub
function makeTestMap(w, h) {
  const cs = 5;
  const map = {
    width: w, height: h, cellSize: cs,
    originX: 0, originZ: 0,
    nuclei: [{ gx: Math.floor(w / 2), gz: Math.floor(h / 2) }],
    developmentZones: [],
    hasLayer: function(n) { return this._layers.has(n); },
    getLayer: function(n) { return this._layers.get(n); },
    setLayer: function(n, g) { this._layers.set(n, g); },
    _layers: new Map(),
  };

  // Create zone covering entire grid
  const cells = [];
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      cells.push({ gx: x, gz: z });
  map.developmentZones = [{ cells, nucleusIdx: 0 }];

  // Create zone grid
  const zoneGrid = new Grid2D(w, h, { type: 'uint8', cellSize: cs, originX: 0, originZ: 0 });
  for (const c of cells) zoneGrid.set(c.gx, c.gz, 1);
  map.setLayer('zoneGrid', zoneGrid);

  // Spatial layers (uniform for testing)
  for (const name of ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness']) {
    const g = new Grid2D(w, h, { type: 'float32', cellSize: cs, originX: 0, originZ: 0 });
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        g.set(x, z, 0.5);
    map.setLayer(name, g);
  }

  // Road grid with cross roads
  const roadGrid = new Grid2D(w, h, { type: 'uint8', cellSize: cs, originX: 0, originZ: 0 });
  for (let x = 0; x < w; x++) roadGrid.set(x, Math.floor(h / 2), 1);
  for (let z = 0; z < h; z++) roadGrid.set(Math.floor(w / 2), z, 1);
  map.setLayer('roadGrid', roadGrid);

  // Land value
  const lv = new Grid2D(w, h, { type: 'float32', cellSize: cs, originX: 0, originZ: 0 });
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      lv.set(x, z, 0.6);
  map.setLayer('landValue', lv);

  return map;
}

describe('initGrowthState', () => {
  it('creates state with tick 0 and claimed counts', () => {
    const map = makeTestMap(40, 40);
    const archetype = {
      growth: {
        maxGrowthTicks: 8,
        agentPriority: ['commercial'],
        valueComposition: {
          commercial: { centrality: 0.5 },
        },
        influenceRadii: {},
        agents: {
          commercial: { share: 0.1, budgetPerTick: 10, minFootprint: 1 },
        },
      },
    };
    const state = initGrowthState(map, archetype);
    expect(state.tick).toBe(0);
    expect(state.claimedCounts.get('commercial')).toBe(0);
    expect(state.totalZoneCells).toBeGreaterThan(0);
  });
});

describe('runGrowthTick', () => {
  it('claims cells and increments tick', () => {
    const map = makeTestMap(40, 40);
    const archetype = {
      growth: {
        maxGrowthTicks: 8,
        agentPriority: ['commercial'],
        valueComposition: {
          commercial: { centrality: 0.5 },
        },
        influenceRadii: {},
        agents: {
          commercial: { share: 0.5, budgetPerTick: 10, minFootprint: 1 },
        },
      },
    };
    const state = initGrowthState(map, archetype);
    const done = runGrowthTick(map, archetype, state);

    expect(state.tick).toBe(1);
    // Some cells should be claimed
    const resGrid = map.getLayer('reservationGrid');
    expect(resGrid).toBeTruthy();
    let claimed = 0;
    for (let z = 0; z < 40; z++)
      for (let x = 0; x < 40; x++)
        if (resGrid.get(x, z) > 0) claimed++;
    expect(claimed).toBeGreaterThan(0);
    expect(done).toBe(false); // not terminated yet
  });

  it('terminates when maxGrowthTicks reached', () => {
    const map = makeTestMap(20, 20);
    const archetype = {
      growth: {
        maxGrowthTicks: 2,
        agentPriority: ['commercial'],
        valueComposition: {
          commercial: { centrality: 0.5 },
        },
        influenceRadii: {},
        agents: {
          commercial: { share: 0.01, budgetPerTick: 1, minFootprint: 1 },
        },
      },
    };
    const state = initGrowthState(map, archetype);
    runGrowthTick(map, archetype, state);
    runGrowthTick(map, archetype, state);
    const done = runGrowthTick(map, archetype, state);
    expect(done).toBe(true); // hit max
  });
});
