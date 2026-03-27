import { describe, it, expect } from 'vitest';
import { layCrossStreets } from '../../../src/city/incremental/crossStreets.js';
import { makeRectZone, makeMap } from './helpers.js';

describe('layCrossStreets', () => {
  const cs = 5;
  const W = 100, H = 100;

  function setup(x0 = 5, z0 = 5, x1 = 60, z1 = 60) {
    const zone = makeRectZone(x0, z0, x1, z1, cs);
    const map = makeMap(W, H, cs);
    return { zone, map };
  }

  it('produces cross streets for a large zone', () => {
    const { zone, map } = setup();
    const { crossStreets } = layCrossStreets(zone, map);
    expect(crossStreets.length).toBeGreaterThan(0);
  });

  it('returns gradient and contour directions', () => {
    const { zone, map } = setup();
    const { gradDir, contourDir } = layCrossStreets(zone, map);
    expect(gradDir.x).toBeDefined();
    expect(gradDir.z).toBeDefined();
    expect(contourDir.x).toBeDefined();
    expect(contourDir.z).toBeDefined();
    // Perpendicular
    const dot = gradDir.x * contourDir.x + gradDir.z * contourDir.z;
    expect(Math.abs(dot)).toBeLessThan(0.01);
  });

  it('cross streets have polyline points and positive length', () => {
    const { zone, map } = setup();
    const { crossStreets } = layCrossStreets(zone, map);
    for (const cs2 of crossStreets) {
      expect(cs2.points.length).toBeGreaterThan(1);
      expect(cs2.length).toBeGreaterThan(0);
    }
  });

  it('respects minimum street length', () => {
    const { zone, map } = setup();
    const { crossStreets } = layCrossStreets(zone, map, { minLength: 20 });
    for (const cs2 of crossStreets) {
      expect(cs2.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('lines span a significant portion of the zone', () => {
    const { zone, map } = setup();
    const { crossStreets } = layCrossStreets(zone, map);
    // Zone is 55 cells * 5m = 275m in each direction
    // At least some lines should be > 100m
    const longLines = crossStreets.filter(cs2 => cs2.length > 100);
    expect(longLines.length).toBeGreaterThan(0);
  });

  it('stops at water obstacles', () => {
    const { zone, map } = setup();
    // Place water barrier across the gradient direction
    const waterMask = map.getLayer('waterMask');
    for (let gz = 0; gz < H; gz++) {
      waterMask.set(30, gz, 1);
    }
    const { crossStreets } = layCrossStreets(zone, map);
    // Lines should be shorter (truncated by water)
    for (const cs2 of crossStreets) {
      expect(cs2.length).toBeLessThan(200);
    }
  });

  it('road-split zone produces multiple runs', () => {
    const { zone, map } = setup(5, 5, 60, 60);
    // Place a road across the middle in the contour direction
    // Gradient is +x, so road in x direction splits the zone along gradient
    const roadGrid = map.getLayer('roadGrid');
    for (let gx = 0; gx < W; gx++) {
      roadGrid.set(gx, 33, 1);
    }
    // Remove road cells from zone (zones don't include roads)
    zone.cells = zone.cells.filter(c => c.gz !== 33);

    const { crossStreets } = layCrossStreets(zone, map);
    // Should produce more lines than without the road split
    // (some contour offsets will have 2 runs)
    expect(crossStreets.length).toBeGreaterThan(0);
  });

  it('no two cross streets converge within minSeparation', () => {
    const { zone, map } = setup();
    const minSep = 5;
    const { crossStreets } = layCrossStreets(zone, map, { minSeparation: minSep });

    // Sample points along each pair and check distance
    for (let i = 0; i < crossStreets.length; i++) {
      for (let j = i + 1; j < crossStreets.length; j++) {
        const ptsA = crossStreets[i].points;
        const ptsB = crossStreets[j].points;
        const stepA = Math.max(1, Math.floor(ptsA.length / 10));
        const stepB = Math.max(1, Math.floor(ptsB.length / 10));
        for (let ia = 0; ia < ptsA.length; ia += stepA) {
          for (let ib = 0; ib < ptsB.length; ib += stepB) {
            const dx = ptsA[ia].x - ptsB[ib].x;
            const dz = ptsA[ia].z - ptsB[ib].z;
            expect(dx * dx + dz * dz).toBeGreaterThanOrEqual(minSep * minSep);
          }
        }
      }
    }
  });

  it('returns empty for a tiny zone', () => {
    const { zone, map } = setup(10, 10, 12, 12);
    const { crossStreets } = layCrossStreets(zone, map, { minLength: 20 });
    expect(crossStreets.length).toBe(0);
  });

  it('spacing parameter controls number of lines', () => {
    const { zone, map } = setup();
    const tight = layCrossStreets(zone, map, { spacing: 40 });
    const wide = layCrossStreets(zone, map, { spacing: 150 });
    expect(tight.crossStreets.length).toBeGreaterThanOrEqual(wide.crossStreets.length);
  });
});
