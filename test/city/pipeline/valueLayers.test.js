// test/city/pipeline/valueLayers.test.js
import { describe, it, expect } from 'vitest';
import { composeValueLayer, composeAllValueLayers } from '../../../src/city/pipeline/valueLayers.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

// Helper: make a Grid2D filled with a constant value
function constGrid(w, h, value) {
  const g = new Grid2D(w, h, { type: 'float32', cellSize: 5, originX: 0, originZ: 0, fill: value });
  return g;
}

// Helper: make a Grid2D where every cell has value fn(gx, gz)
function fnGrid(w, h, fn) {
  const g = new Grid2D(w, h, { type: 'float32', cellSize: 5, originX: 0, originZ: 0 });
  for (let gz = 0; gz < h; gz++)
    for (let gx = 0; gx < w; gx++)
      g.set(gx, gz, fn(gx, gz));
  return g;
}

// ─── composeValueLayer ────────────────────────────────────────────────────────

describe('composeValueLayer', () => {
  it('returns a Float32Array of length w*h', () => {
    const w = 6, h = 4;
    const out = composeValueLayer({}, {}, w, h);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(24);
  });

  it('empty composition returns all-zero bitmap', () => {
    const layers = { centrality: constGrid(5, 5, 0.8) };
    const out = composeValueLayer({}, layers, 5, 5);
    expect(out.every(v => v === 0)).toBe(true);
  });

  it('single layer, weight 1.0 — output equals layer values', () => {
    const w = 4, h = 4;
    const layers = { centrality: constGrid(w, h, 0.6) };
    const out = composeValueLayer({ centrality: 1.0 }, layers, w, h);
    for (const v of out) expect(v).toBeCloseTo(0.6);
  });

  it('single layer, weight 0.5 — output is halved', () => {
    const w = 4, h = 4;
    const layers = { centrality: constGrid(w, h, 0.8) };
    const out = composeValueLayer({ centrality: 0.5 }, layers, w, h);
    for (const v of out) expect(v).toBeCloseTo(0.4);
  });

  it('two layers are summed correctly', () => {
    const w = 4, h = 4;
    const layers = {
      centrality: constGrid(w, h, 0.6),
      roadFrontage: constGrid(w, h, 0.4),
    };
    // 0.5*0.6 + 0.5*0.4 = 0.3 + 0.2 = 0.5
    const out = composeValueLayer({ centrality: 0.5, roadFrontage: 0.5 }, layers, w, h);
    for (const v of out) expect(v).toBeCloseTo(0.5);
  });

  it('missing layer is silently skipped', () => {
    const w = 4, h = 4;
    const layers = { centrality: constGrid(w, h, 0.8) };
    // waterfrontness not present → contribution is 0
    const out = composeValueLayer({ centrality: 0.5, waterfrontness: 0.5 }, layers, w, h);
    for (const v of out) expect(v).toBeCloseTo(0.4); // 0.5 * 0.8 only
  });

  it('output is clamped to [0, 1] even when weights sum > 1', () => {
    const w = 4, h = 4;
    const layers = {
      centrality: constGrid(w, h, 1.0),
      roadFrontage: constGrid(w, h, 1.0),
    };
    // 2.0 * 1.0 would be 2 — should be clamped to 1
    const out = composeValueLayer({ centrality: 1.0, roadFrontage: 1.0 }, layers, w, h);
    for (const v of out) expect(v).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('output is clamped to >= 0 even with negative weights', () => {
    const w = 4, h = 4;
    const layers = { centrality: constGrid(w, h, 0.5) };
    const out = composeValueLayer({ centrality: -2.0 }, layers, w, h);
    for (const v of out) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('accepts Float32Array layers (influence layers)', () => {
    const w = 3, h = 3;
    const flat = new Float32Array(w * h).fill(0.5);
    const out = composeValueLayer({ influence: 1.0 }, { influence: flat }, w, h);
    for (const v of out) expect(v).toBeCloseTo(0.5);
  });

  it('spatially varying layers preserve per-cell differences', () => {
    const w = 10, h = 10;
    // centrality: high in top-left, low elsewhere
    const layers = {
      centrality: fnGrid(w, h, (gx, gz) => gx === 0 && gz === 0 ? 1.0 : 0.1),
    };
    const out = composeValueLayer({ centrality: 1.0 }, layers, w, h);
    // Top-left cell should be highest
    expect(out[0]).toBeGreaterThan(out[1]);
    expect(out[0]).toBeGreaterThan(out[w]);
  });
});

// ─── composeAllValueLayers ────────────────────────────────────────────────────

describe('composeAllValueLayers', () => {
  it('returns a map with one key per zone in valueComposition', () => {
    const w = 5, h = 5;
    const layers = { centrality: constGrid(w, h, 0.5) };
    const result = composeAllValueLayers(
      { commercial: { centrality: 1.0 }, industrial: { centrality: 0.5 } },
      layers, w, h
    );
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['commercial', 'industrial']));
    expect(Object.keys(result).length).toBe(2);
  });

  it('each entry is a Float32Array of length w*h', () => {
    const w = 4, h = 6;
    const layers = { centrality: constGrid(w, h, 0.3) };
    const result = composeAllValueLayers(
      { commercial: { centrality: 1.0 } },
      layers, w, h
    );
    expect(result.commercial).toBeInstanceOf(Float32Array);
    expect(result.commercial.length).toBe(w * h);
  });

  it('empty composition object returns empty result', () => {
    const w = 5, h = 5;
    const result = composeAllValueLayers({}, {}, w, h);
    expect(Object.keys(result).length).toBe(0);
  });

  it('different zone compositions produce different bitmaps', () => {
    const w = 5, h = 5;
    const layers = {
      centrality: constGrid(w, h, 0.8),
      edgeness: constGrid(w, h, 0.2),
    };
    const result = composeAllValueLayers(
      {
        commercial: { centrality: 1.0 }, // high centrality weight
        industrial: { edgeness: 1.0 },   // high edgeness weight
      },
      layers, w, h
    );
    // commercial should score higher on centrality → 0.8
    // industrial should score lower on edgeness → 0.2
    expect(result.commercial[0]).toBeGreaterThan(result.industrial[0]);
  });

  it('zones sharing the same composition produce identical bitmaps', () => {
    const w = 4, h = 4;
    const layers = { centrality: constGrid(w, h, 0.5) };
    const comp = { centrality: 1.0 };
    const result = composeAllValueLayers(
      { zoneA: comp, zoneB: comp },
      layers, w, h
    );
    for (let i = 0; i < w * h; i++) {
      expect(result.zoneA[i]).toBeCloseTo(result.zoneB[i]);
    }
  });
});
