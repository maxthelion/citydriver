import { describe, it, expect } from 'vitest';
import { layoutIncrementalStreets, computeGradient } from '../../../src/city/incremental/index.js';
import { makeRectZone, makeMap } from './helpers.js';

describe('layoutIncrementalStreets', () => {
  const cs = 5;
  const W = 100, H = 100;

  it('returns all expected fields', () => {
    const zone = makeRectZone(5, 5, 60, 60, cs);
    const map = makeMap(W, H, cs);
    const result = layoutIncrementalStreets(zone, map);

    expect(result).toHaveProperty('constructionLines');
    expect(result).toHaveProperty('streets');
    expect(result).toHaveProperty('parcels');
    expect(result).toHaveProperty('plots');
    expect(result).toHaveProperty('wasteRatio');
    expect(result).toHaveProperty('gradDir');
    expect(result).toHaveProperty('contourDir');
  });

  it('produces construction lines, streets, and parcels for a well-shaped zone', () => {
    const zone = makeRectZone(5, 5, 60, 60, cs);
    const map = makeMap(W, H, cs);
    const result = layoutIncrementalStreets(zone, map);

    expect(result.constructionLines.length).toBeGreaterThan(0);
    expect(result.streets.length).toBeGreaterThan(0);
    expect(result.parcels.length).toBeGreaterThan(0);
  });

  it('waste ratio is between 0 and 1', () => {
    const zone = makeRectZone(5, 5, 60, 60, cs);
    const map = makeMap(W, H, cs);
    const result = layoutIncrementalStreets(zone, map);

    expect(result.wasteRatio).toBeGreaterThanOrEqual(0);
    expect(result.wasteRatio).toBeLessThanOrEqual(1);
  });

  it('produces plots from parcels', () => {
    const zone = makeRectZone(5, 5, 60, 60, cs);
    const map = makeMap(W, H, cs);
    const result = layoutIncrementalStreets(zone, map);

    if (result.parcels.length > 0) {
      expect(result.plots.length).toBeGreaterThan(0);
    }
  });

  it('handles empty zone gracefully', () => {
    const zone = { cells: [], centroidGx: 0, centroidGz: 0, slopeDir: { x: 1, z: 0 } };
    const map = makeMap(W, H, cs);
    const result = layoutIncrementalStreets(zone, map);

    expect(result.constructionLines).toEqual([]);
    expect(result.streets).toEqual([]);
    expect(result.parcels).toEqual([]);
    expect(result.wasteRatio).toBe(1);
  });

  it('params override defaults', () => {
    const zone = makeRectZone(5, 5, 60, 60, cs);
    const map = makeMap(W, H, cs);

    const tight = layoutIncrementalStreets(zone, map, { constructionSpacing: 40 });
    const wide = layoutIncrementalStreets(zone, map, { constructionSpacing: 150 });

    expect(tight.constructionLines.length).toBeGreaterThanOrEqual(wide.constructionLines.length);
  });
});

describe('computeGradient', () => {
  const cs = 5;
  const W = 50, H = 50;

  it('detects slope in +x direction', () => {
    const zone = makeRectZone(5, 5, 30, 30, cs);
    const map = makeMap(W, H, cs, { slopeX: 0.05 });
    const zoneSet = new Set();
    for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

    const { gradDir } = computeGradient(zone, map, zoneSet);
    // Gradient should point in +x direction (uphill)
    expect(gradDir.x).toBeGreaterThan(0.5);
    expect(Math.abs(gradDir.z)).toBeLessThan(0.5);
  });

  it('falls back to slopeDir for flat terrain', () => {
    const zone = makeRectZone(5, 5, 30, 30, cs);
    zone.slopeDir = { x: 0, z: 1 };
    const map = makeMap(W, H, cs, { slopeX: 0 });
    const zoneSet = new Set();
    for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

    const { gradDir } = computeGradient(zone, map, zoneSet);
    expect(gradDir.z).toBe(1);
  });

  it('contour is perpendicular to gradient', () => {
    const zone = makeRectZone(5, 5, 30, 30, cs);
    const map = makeMap(W, H, cs);
    const zoneSet = new Set();
    for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

    const { gradDir, contourDir } = computeGradient(zone, map, zoneSet);
    const dot = gradDir.x * contourDir.x + gradDir.z * contourDir.z;
    expect(Math.abs(dot)).toBeLessThan(0.01);
  });
});
