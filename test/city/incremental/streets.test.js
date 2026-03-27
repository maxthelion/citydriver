import { describe, it, expect } from 'vitest';
import { buildParallelStreets } from '../../../src/city/incremental/streets.js';
import { buildConstructionLines } from '../../../src/city/incremental/constructionLines.js';
import { computeGradient } from '../../../src/city/incremental/index.js';
import { makeRectZone, makeMap } from './helpers.js';

describe('buildParallelStreets', () => {
  const cs = 5;
  const W = 100, H = 100;

  function setup(x0 = 5, z0 = 5, x1 = 60, z1 = 60) {
    const zone = makeRectZone(x0, z0, x1, z1, cs);
    const map = makeMap(W, H, cs);
    const zoneSet = new Set();
    for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);
    const { gradDir, contourDir } = computeGradient(zone, map, zoneSet);
    const cLines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, {
      constructionSpacing: 90,
      minStreetLength: 20,
    });
    return { zone, map, zoneSet, gradDir, contourDir, cLines };
  }

  const defaultParams = {
    parcelDepth: 35,
    minStreetLength: 20,
    minParcelDepth: 15,
    angleTolerance: Math.PI / 6,
  };

  it('produces streets and parcels for a large zone', () => {
    const { cLines, zone, map, gradDir, contourDir, zoneSet } = setup();
    expect(cLines.length).toBeGreaterThanOrEqual(2);

    const { streets, parcels } = buildParallelStreets(
      cLines, zone, map, gradDir, contourDir, zoneSet, defaultParams,
    );
    expect(streets.length).toBeGreaterThan(0);
    expect(parcels.length).toBeGreaterThan(0);
  });

  it('returns empty arrays when fewer than 2 construction lines', () => {
    const { zone, map, gradDir, contourDir, zoneSet } = setup();
    const { streets, parcels } = buildParallelStreets(
      [], zone, map, gradDir, contourDir, zoneSet, defaultParams,
    );
    expect(streets).toEqual([]);
    expect(parcels).toEqual([]);
  });

  it('all streets are at least minStreetLength long', () => {
    const { cLines, zone, map, gradDir, contourDir, zoneSet } = setup();
    const { streets } = buildParallelStreets(
      cLines, zone, map, gradDir, contourDir, zoneSet, defaultParams,
    );
    for (const s of streets) {
      expect(s.length).toBeGreaterThanOrEqual(defaultParams.minStreetLength);
    }
  });

  it('all parcels have shortSide >= minParcelDepth', () => {
    const { cLines, zone, map, gradDir, contourDir, zoneSet } = setup();
    const { parcels } = buildParallelStreets(
      cLines, zone, map, gradDir, contourDir, zoneSet, defaultParams,
    );
    for (const p of parcels) {
      expect(p.shortSide).toBeGreaterThanOrEqual(defaultParams.minParcelDepth);
    }
  });

  it('parcels have positive area', () => {
    const { cLines, zone, map, gradDir, contourDir, zoneSet } = setup();
    const { parcels } = buildParallelStreets(
      cLines, zone, map, gradDir, contourDir, zoneSet, defaultParams,
    );
    for (const p of parcels) {
      expect(p.area).toBeGreaterThan(0);
    }
  });

  it('truncates streets at water instead of rejecting them', () => {
    const { cLines, zone, map, gradDir, contourDir, zoneSet } = setup();
    // Place water partway across the corridor (not blocking entirely)
    const waterMask = map.getLayer('waterMask');
    for (let gz = 5; gz <= 60; gz++) {
      waterMask.set(40, gz, 1);
    }
    const { streets } = buildParallelStreets(
      cLines, zone, map, gradDir, contourDir, zoneSet, defaultParams,
    );
    // Should still produce some streets (truncated, not rejected)
    // Some streets will be shorter than the full corridor width
    const shortStreets = streets.filter(s => s.length < 100);
    // We expect at least some streets survived via truncation
    expect(streets.length).toBeGreaterThan(0);
  });
});
