// test/city/pipeline/allocate.test.js
import { describe, it, expect } from 'vitest';
import { allocateFromValueBitmap } from '../../../src/city/pipeline/allocate.js';
import { RESERVATION } from '../../../src/city/pipeline/growthAgents.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

// Helper: make a uint8 Grid2D
function makeGrid(w, h) {
  return new Grid2D(w, h, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
}

// Helper: make a uniform zoneGrid (all eligible)
function fullZone(w, h) {
  const g = makeGrid(w, h);
  for (let gz = 0; gz < h; gz++)
    for (let gx = 0; gx < w; gx++)
      g.set(gx, gz, 1);
  return g;
}

// Helper: build a flat Float32Array value layer from a fn(gx, gz)
function valueLayerFn(w, h, fn) {
  const arr = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++)
    for (let gx = 0; gx < w; gx++)
      arr[gz * w + gx] = fn(gx, gz);
  return arr;
}

// ─── basic operation ──────────────────────────────────────────────────────────

describe('allocateFromValueBitmap – basic', () => {
  it('returns an array of claimed cells', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    const valueLayer = new Float32Array(w * h).fill(0.5);

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, resType: RESERVATION.COMMERCIAL,
      budget: 5, w, h,
    });

    expect(Array.isArray(claimed)).toBe(true);
    expect(claimed.length).toBe(5);
  });

  it('writes resType into resGrid for every claimed cell', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    const valueLayer = new Float32Array(w * h).fill(0.5);

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, resType: RESERVATION.INDUSTRIAL,
      budget: 8, w, h,
    });

    for (const { gx, gz } of claimed) {
      expect(resGrid.get(gx, gz)).toBe(RESERVATION.INDUSTRIAL);
    }
  });

  it('returns empty array when budget is 0', () => {
    const w = 5, h = 5;
    const claimed = allocateFromValueBitmap({
      valueLayer: new Float32Array(25).fill(1),
      resGrid: makeGrid(w, h),
      zoneGrid: fullZone(w, h),
      resType: RESERVATION.CIVIC,
      budget: 0, w, h,
    });
    expect(claimed).toEqual([]);
  });

  it('returns empty array when zoneGrid has no eligible cells', () => {
    const w = 5, h = 5;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h); // all zeros = no zone
    const claimed = allocateFromValueBitmap({
      valueLayer: new Float32Array(25).fill(1),
      resGrid, zoneGrid,
      resType: RESERVATION.COMMERCIAL,
      budget: 10, w, h,
    });
    expect(claimed).toEqual([]);
  });

  it('returns fewer cells than budget when grid is nearly full', () => {
    const w = 3, h = 3;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    // Pre-fill all but 2 cells
    for (let gz = 0; gz < h; gz++)
      for (let gx = 0; gx < w; gx++)
        if (!(gx === 1 && gz === 1) && !(gx === 2 && gz === 2))
          resGrid.set(gx, gz, RESERVATION.COMMERCIAL);

    const claimed = allocateFromValueBitmap({
      valueLayer: new Float32Array(9).fill(0.5),
      resGrid, zoneGrid,
      resType: RESERVATION.INDUSTRIAL,
      budget: 10, w, h,
    });
    // Only 2 cells available, but they may not be contiguous so ≤ 2
    expect(claimed.length).toBeLessThanOrEqual(2);
  });
});

// ─── value-based ordering ─────────────────────────────────────────────────────

describe('allocateFromValueBitmap – value ordering', () => {
  it('seeds from the highest-value cell', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    // Only cell (7, 3) has score 1.0; all others 0.1
    const valueLayer = valueLayerFn(w, h, (gx, gz) =>
      gx === 7 && gz === 3 ? 1.0 : 0.1
    );

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, resType: RESERVATION.COMMERCIAL,
      budget: 1, w, h,
    });

    expect(claimed.length).toBe(1);
    expect(claimed[0]).toEqual({ gx: 7, gz: 3 });
  });

  it('prefers high-value cells among neighbours', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    // Gradient: cells with lower gx have higher value
    const valueLayer = valueLayerFn(w, h, (gx, gz) => 1.0 - gx / w);

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, resType: RESERVATION.COMMERCIAL,
      budget: 4, w, h,
    });

    // All claimed cells should be near the left edge (gx close to 0)
    for (const { gx } of claimed) {
      expect(gx).toBeLessThan(5);
    }
  });
});

// ─── existing reservations ────────────────────────────────────────────────────

describe('allocateFromValueBitmap – respects existing reservations', () => {
  it('does not overwrite cells already reserved', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    // Pre-reserve the highest-value cell
    resGrid.set(5, 5, RESERVATION.COMMERCIAL);
    const valueLayer = valueLayerFn(w, h, (gx, gz) =>
      gx === 5 && gz === 5 ? 1.0 : 0.5
    );

    allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, resType: RESERVATION.INDUSTRIAL,
      budget: 5, w, h,
    });

    // The commercial cell should remain commercial
    expect(resGrid.get(5, 5)).toBe(RESERVATION.COMMERCIAL);
  });

  it('skips already-reserved cells when counting the budget', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    // Fill 90 cells; only 10 free
    for (let gz = 0; gz < h; gz++)
      for (let gx = 0; gx < 9; gx++)
        resGrid.set(gx, gz, RESERVATION.COMMERCIAL);

    const claimed = allocateFromValueBitmap({
      valueLayer: new Float32Array(w * h).fill(0.5),
      resGrid, zoneGrid,
      resType: RESERVATION.INDUSTRIAL,
      budget: 20, w, h,
    });

    expect(claimed.length).toBeLessThanOrEqual(10);
    for (const { gx, gz } of claimed) {
      expect(resGrid.get(gx, gz)).toBe(RESERVATION.INDUSTRIAL);
    }
  });
});

// ─── zone eligibility ─────────────────────────────────────────────────────────

describe('allocateFromValueBitmap – zone eligibility', () => {
  it('does not claim cells outside the zone', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    // Only a 3x3 block at (4,4)–(6,6) is in zone
    const zoneGrid = makeGrid(w, h);
    for (let gz = 4; gz <= 6; gz++)
      for (let gx = 4; gx <= 6; gx++)
        zoneGrid.set(gx, gz, 1);

    const claimed = allocateFromValueBitmap({
      valueLayer: new Float32Array(w * h).fill(0.5),
      resGrid, zoneGrid,
      resType: RESERVATION.RESIDENTIAL_FINE,
      budget: 20, w, h,
    });

    // Should claim at most 9 cells (the zone)
    expect(claimed.length).toBeLessThanOrEqual(9);
    for (const { gx, gz } of claimed) {
      expect(gx).toBeGreaterThanOrEqual(4);
      expect(gx).toBeLessThanOrEqual(6);
      expect(gz).toBeGreaterThanOrEqual(4);
      expect(gz).toBeLessThanOrEqual(6);
    }
  });
});

// ─── devProximity filter ──────────────────────────────────────────────────────

describe('allocateFromValueBitmap – devProximity filter', () => {
  it('when devProximity provided, skips cells with proximity === 0', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    // devProximity: only the right half is non-zero
    const devProximity = new Float32Array(w * h);
    for (let gz = 0; gz < h; gz++)
      for (let gx = 5; gx < w; gx++)
        devProximity[gz * w + gx] = 1.0;

    const claimed = allocateFromValueBitmap({
      valueLayer: new Float32Array(w * h).fill(0.5),
      resGrid, zoneGrid, devProximity,
      resType: RESERVATION.COMMERCIAL,
      budget: 10, w, h,
    });

    for (const { gx } of claimed) {
      expect(gx).toBeGreaterThanOrEqual(5);
    }
  });

  it('when devProximity is null, all zone cells are eligible', () => {
    const w = 6, h = 6;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);

    const claimed = allocateFromValueBitmap({
      valueLayer: new Float32Array(w * h).fill(0.5),
      resGrid, zoneGrid,
      devProximity: null,
      resType: RESERVATION.COMMERCIAL,
      budget: 10, w, h,
    });

    expect(claimed.length).toBe(10);
    // Cells from any position are valid
    for (const { gx, gz } of claimed) {
      expect(gx).toBeGreaterThanOrEqual(0);
      expect(gz).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── contiguity ───────────────────────────────────────────────────────────────

describe('allocateFromValueBitmap – contiguity', () => {
  it('claimed cells form a connected region', () => {
    const w = 15, h = 15;
    const resGrid = makeGrid(w, h);
    const zoneGrid = fullZone(w, h);
    const valueLayer = valueLayerFn(w, h, (gx, gz) => 1.0 - (gx + gz) / (w + h));

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid,
      resType: RESERVATION.RESIDENTIAL_QUALITY,
      budget: 20, w, h,
    });

    expect(claimed.length).toBe(20);

    // Build a set of claimed positions for adjacency check
    const claimedSet = new Set(claimed.map(({ gx, gz }) => `${gx},${gz}`));
    // Every cell (except the first) should have at least one claimed neighbour
    for (let i = 1; i < claimed.length; i++) {
      const { gx, gz } = claimed[i];
      const hasNeighbour =
        claimedSet.has(`${gx + 1},${gz}`) ||
        claimedSet.has(`${gx - 1},${gz}`) ||
        claimedSet.has(`${gx},${gz + 1}`) ||
        claimedSet.has(`${gx},${gz - 1}`);
      expect(hasNeighbour).toBe(true);
    }
  });
});
