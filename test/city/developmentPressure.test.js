import { describe, it, expect } from 'vitest';
import {
  computePressure,
  typologyForPressure,
  plotWidthForPressure,
  ribbonSpacingForPressure,
} from '../../src/city/developmentPressure.js';

describe('computePressure', () => {
  it('returns high pressure for high land value near nucleus', () => {
    const p = computePressure(0.8, 50);
    expect(p).toBeGreaterThan(0.75);
  });

  it('returns low pressure far from nucleus with low land value', () => {
    const p = computePressure(0.35, 500);
    expect(p).toBeLessThan(0.35);
  });

  it('clamps to [0, 1]', () => {
    expect(computePressure(1.0, 0)).toBeLessThanOrEqual(1);
    expect(computePressure(0, 1000)).toBeGreaterThanOrEqual(0);
  });
});

describe('typologyForPressure', () => {
  it('returns dense-urban for pressure > 0.75', () => {
    const t = typologyForPressure(0.85);
    expect(t.name).toBe('dense-urban');
    expect(t.plotWidth[0]).toBeCloseTo(4.5);
    expect(t.plotWidth[1]).toBeCloseTo(6);
    expect(t.floors[0]).toBeGreaterThanOrEqual(3);
  });

  it('returns mid-density for pressure 0.5-0.75', () => {
    expect(typologyForPressure(0.6).name).toBe('mid-density');
  });

  it('returns suburban for pressure 0.25-0.5', () => {
    expect(typologyForPressure(0.35).name).toBe('suburban');
  });

  it('returns rural-edge for pressure < 0.25', () => {
    expect(typologyForPressure(0.1).name).toBe('rural-edge');
  });
});

describe('plotWidthForPressure', () => {
  it('returns narrower plots for higher pressure', () => {
    const highW = plotWidthForPressure(0.9, 0.5);
    const lowW = plotWidthForPressure(0.2, 0.5);
    expect(highW).toBeLessThan(lowW);
  });

  it('adds variation from rng parameter', () => {
    const w1 = plotWidthForPressure(0.5, 0.0);
    const w2 = plotWidthForPressure(0.5, 1.0);
    expect(w1).not.toBe(w2);
    const base = (w1 + w2) / 2;
    expect(Math.abs(w1 - w2)).toBeLessThan(base * 0.35);
  });
});

describe('ribbonSpacingForPressure', () => {
  it('returns tighter spacing for higher pressure', () => {
    expect(ribbonSpacingForPressure(0.9)).toBeLessThan(ribbonSpacingForPressure(0.1));
  });

  it('returns 25 for high pressure', () => {
    expect(ribbonSpacingForPressure(0.85)).toBe(25);
  });

  it('returns 55 for low pressure', () => {
    expect(ribbonSpacingForPressure(0.1)).toBe(55);
  });
});
