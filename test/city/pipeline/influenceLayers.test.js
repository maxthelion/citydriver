// test/city/pipeline/influenceLayers.test.js
import { describe, it, expect } from 'vitest';
import { boxBlur, computeInfluenceLayers } from '../../../src/city/pipeline/influenceLayers.js';
import { RESERVATION } from '../../../src/city/pipeline/growthAgents.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

// ─── boxBlur ─────────────────────────────────────────────────────────────────

describe('boxBlur', () => {
  it('returns a Float32Array of the same length as w*h', () => {
    const src = new Float32Array(6 * 4);
    const out = boxBlur(src, 6, 4, 1);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(24);
  });

  it('all-zero input produces all-zero output', () => {
    const src = new Float32Array(10 * 10);
    const out = boxBlur(src, 10, 10, 2);
    expect(out.every(v => v === 0)).toBe(true);
  });

  it('all-ones input normalises so the interior peak is 1.0', () => {
    const src = new Float32Array(8 * 8).fill(1);
    const out = boxBlur(src, 8, 8, 2);
    // After blur+normalise the interior cell with the largest kernel sum = 1.0
    const max = Math.max(...out);
    expect(max).toBeCloseTo(1.0);
    // All values should be in (0, 1]
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeGreaterThan(0);
      expect(out[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('single hot pixel produces a gradient that peaks at 1 and fades', () => {
    const w = 20, h = 20;
    const src = new Float32Array(w * h);
    // Single hot pixel at the centre
    src[10 * w + 10] = 1.0;
    const out = boxBlur(src, w, h, 4);

    // Peak should be 1.0 after normalisation
    expect(out[10 * w + 10]).toBeCloseTo(1.0);

    // Cells far from the hot pixel should be lower
    expect(out[0 * w + 0]).toBeLessThan(out[10 * w + 10]);
  });

  it('blur spreads influence — neighbours of hot pixel are non-zero', () => {
    const w = 10, h = 10;
    const src = new Float32Array(w * h);
    src[5 * w + 5] = 1.0;
    const out = boxBlur(src, w, h, 3);

    // Immediate neighbours should be non-zero
    expect(out[5 * w + 6]).toBeGreaterThan(0);
    expect(out[5 * w + 4]).toBeGreaterThan(0);
    expect(out[4 * w + 5]).toBeGreaterThan(0);
    expect(out[6 * w + 5]).toBeGreaterThan(0);
  });

  it('radius 0 passes values through (then normalises)', () => {
    const w = 4, h = 4;
    const src = new Float32Array(w * h);
    src[0] = 0.5;
    src[1] = 1.0;
    const out = boxBlur(src, w, h, 0);
    // Max is 1.0 so values should be preserved proportionally
    expect(out[1]).toBeCloseTo(1.0);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(0.0);
  });

  it('output is always in [0, 1]', () => {
    const w = 15, h = 15;
    const src = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) src[i] = Math.random();
    const out = boxBlur(src, w, h, 3);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

// ─── computeInfluenceLayers ───────────────────────────────────────────────────

describe('computeInfluenceLayers', () => {
  function makeResGrid(w, h) {
    return new Grid2D(w, h, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
  }

  it('always produces a developmentProximity layer', () => {
    const w = 10, h = 10;
    const resGrid = makeResGrid(w, h);
    const layers = computeInfluenceLayers(resGrid, w, h, {});
    expect(layers.developmentProximity).toBeInstanceOf(Float32Array);
    expect(layers.developmentProximity.length).toBe(w * h);
  });

  it('developmentProximity is all-zero when resGrid is empty and no nuclei', () => {
    const w = 10, h = 10;
    const resGrid = makeResGrid(w, h);
    const layers = computeInfluenceLayers(resGrid, w, h, {});
    expect(layers.developmentProximity.every(v => v === 0)).toBe(true);
  });

  it('developmentProximity is non-zero near a nucleus even with empty resGrid', () => {
    const w = 20, h = 20;
    const resGrid = makeResGrid(w, h);
    const nuclei = [{ gx: 10, gz: 10 }];
    const layers = computeInfluenceLayers(resGrid, w, h, { industrial: { types: [RESERVATION.INDUSTRIAL], radius: 5 } }, nuclei);
    // Cell at nucleus should have max proximity
    expect(layers.developmentProximity[10 * w + 10]).toBeCloseTo(1.0);
    // Nearby cells also non-zero
    expect(layers.developmentProximity[10 * w + 12]).toBeGreaterThan(0);
  });

  it('developmentProximity excludes NONE and AGRICULTURE cells', () => {
    const w = 10, h = 10;
    const resGrid = makeResGrid(w, h);
    // Fill with AGRICULTURE — should not contribute to devProximity
    for (let i = 0; i < w * h; i++) resGrid.data[i] = RESERVATION.AGRICULTURE;
    const layers = computeInfluenceLayers(resGrid, w, h, {});
    expect(layers.developmentProximity.every(v => v === 0)).toBe(true);
  });

  it('developmentProximity is non-zero when commercial cells present', () => {
    const w = 20, h = 20;
    const resGrid = makeResGrid(w, h);
    resGrid.set(10, 10, RESERVATION.COMMERCIAL);
    const layers = computeInfluenceLayers(resGrid, w, h, {}, []);
    expect(layers.developmentProximity[10 * w + 10]).toBeGreaterThan(0);
  });

  it('produces named influence layers from influenceRadii', () => {
    const w = 20, h = 20;
    const resGrid = makeResGrid(w, h);
    resGrid.set(5, 5, RESERVATION.INDUSTRIAL);

    const layers = computeInfluenceLayers(resGrid, w, h, {
      industrialProximity: { types: [RESERVATION.INDUSTRIAL], radius: 4 },
    });

    expect(layers.industrialProximity).toBeInstanceOf(Float32Array);
    expect(layers.industrialProximity.length).toBe(w * h);
    // Industrial cell should be at max
    expect(layers.industrialProximity[5 * w + 5]).toBeCloseTo(1.0);
    // Distant cell should be lower
    expect(layers.industrialProximity[19 * w + 19]).toBeLessThan(1.0);
  });

  it('named layer is all-zero when no matching cells exist', () => {
    const w = 10, h = 10;
    const resGrid = makeResGrid(w, h);
    const layers = computeInfluenceLayers(resGrid, w, h, {
      commercialProximity: { types: [RESERVATION.COMMERCIAL], radius: 3 },
    });
    expect(layers.commercialProximity.every(v => v === 0)).toBe(true);
  });

  it('multiple types in a single layer mask are blurred together', () => {
    const w = 20, h = 20;
    const resGrid = makeResGrid(w, h);
    resGrid.set(2, 2, RESERVATION.RESIDENTIAL_FINE);
    resGrid.set(17, 17, RESERVATION.RESIDENTIAL_QUALITY);

    const layers = computeInfluenceLayers(resGrid, w, h, {
      residentialProximity: {
        types: [RESERVATION.RESIDENTIAL_FINE, RESERVATION.RESIDENTIAL_QUALITY],
        radius: 3,
      },
    });

    // Both source cells should have elevated proximity
    expect(layers.residentialProximity[2 * w + 2]).toBeGreaterThan(0);
    expect(layers.residentialProximity[17 * w + 17]).toBeGreaterThan(0);
  });
});
