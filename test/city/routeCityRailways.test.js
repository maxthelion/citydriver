import { describe, it, expect } from 'vitest';
import { extractEntryPoints, scoreStationLocation, routeCityRailways, gradeRailwayCorridor } from '../../src/city/routeCityRailways.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('extractEntryPoints', () => {
  it('extracts entry points from clipped polylines at city boundary', () => {
    const bounds = { minX: 100, minZ: 100, maxX: 500, maxZ: 500 };
    const railways = [
      { polyline: [{ x: 100, z: 300 }, { x: 200, z: 300 }, { x: 400, z: 300 }] },
    ];
    const entries = extractEntryPoints(railways, bounds);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].x).toBeLessThanOrEqual(110);
  });

  it('merges entries from similar directions', () => {
    const bounds = { minX: 0, minZ: 0, maxX: 500, maxZ: 500 };
    const railways = [
      { polyline: [{ x: 0, z: 200 }, { x: 100, z: 200 }] },
      { polyline: [{ x: 0, z: 210 }, { x: 100, z: 210 }] },
    ];
    const entries = extractEntryPoints(railways, bounds);
    expect(entries.length).toBe(1); // merged because same direction
  });
});

describe('scoreStationLocation', () => {
  it('prefers central flat dry land within approach cone', () => {
    const w = 60, h = 60, cs = 5;
    const elevation = new Grid2D(w, h, { cellSize: cs });
    elevation.forEach((gx, gz) => elevation.set(gx, gz, 50));
    const waterMask = new Grid2D(w, h, { type: 'uint8' });
    const landValue = new Grid2D(w, h, { type: 'float32' });
    for (let gz = 25; gz < 35; gz++)
      for (let gx = 25; gx < 35; gx++)
        landValue.set(gx, gz, 0.8);

    const entries = [{ x: 0, z: 150, dirX: 1, dirZ: 0, elevation: 50 }];
    const result = scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cs, 0, 0);
    expect(result).not.toBeNull();
    expect(result.gx).toBeGreaterThan(20);
    expect(result.gx).toBeLessThan(40);
  });

  it('returns null with no entries', () => {
    const elevation = new Grid2D(10, 10, { cellSize: 5 });
    const waterMask = new Grid2D(10, 10, { type: 'uint8' });
    const landValue = new Grid2D(10, 10, { type: 'float32' });
    expect(scoreStationLocation([], elevation, waterMask, landValue, 10, 10, 5, 0, 0)).toBeNull();
  });
});

describe('routeCityRailways', () => {
  it('produces paths from entry points to station on flat terrain', () => {
    const w = 80, h = 80, cs = 5;
    const elevation = new Grid2D(w, h, { cellSize: cs });
    elevation.forEach((gx, gz) => elevation.set(gx, gz, 50));
    const waterMask = new Grid2D(w, h, { type: 'uint8' });
    const landValue = new Grid2D(w, h, { type: 'float32' });
    landValue.forEach((gx, gz) => landValue.set(gx, gz, 0.5));

    const railways = [
      { polyline: [{ x: 0, z: 200 }, { x: 100, z: 200 }, { x: 300, z: 200 }] },
    ];
    const bounds = { minX: 0, minZ: 0, maxX: 400, maxZ: 400 };

    const result = routeCityRailways(railways, elevation, waterMask, landValue, bounds, cs, 0, 0);
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.station).not.toBeNull();
    expect(result.railGrid).not.toBeNull();
  });

  it('returns empty for railways with no entry points', () => {
    const w = 100, h = 100, cs = 5;
    const elevation = new Grid2D(w, h, { cellSize: cs });
    elevation.forEach((gx, gz) => elevation.set(gx, gz, 50));
    const waterMask = new Grid2D(w, h, { type: 'uint8' });
    const landValue = new Grid2D(w, h, { type: 'float32' });

    // Polyline entirely inside bounds, far from all edges (margin = 20*5 = 100)
    const railways = [
      { polyline: [{ x: 150, z: 200 }, { x: 250, z: 250 }] },
    ];
    const bounds = { minX: 0, minZ: 0, maxX: 500, maxZ: 500 };

    const result = routeCityRailways(railways, elevation, waterMask, landValue, bounds, cs, 0, 0);
    expect(result.paths.length).toBe(0);
  });
});

describe('gradeRailwayCorridor', () => {
  it('modifies elevation along the corridor', () => {
    const w = 40, h = 40, cs = 5;
    const elevation = new Grid2D(w, h, { cellSize: cs });
    // Peak in the middle: gx=20 has elev 150, edges have 50
    elevation.forEach((gx, gz) => elevation.set(gx, gz, 150 - Math.abs(gx - 20) * 5));
    const railGrid = new Grid2D(w, h, { type: 'uint8' });

    const paths = [{
      path: [{ gx: 5, gz: 20 }, { gx: 20, gz: 20 }, { gx: 35, gz: 20 }],
    }];
    // Entry and station at 75 -- midpoint of corridor should be graded to 75
    const entries = [{ elevation: 75 }];
    const station = { elevation: 75 };

    const before = elevation.get(20, 20); // centre of hill = 150
    gradeRailwayCorridor(paths, entries, station, elevation, railGrid, cs);
    const after = elevation.get(20, 20);

    // Hill should be cut down to the graded elevation
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(75, 0);
  });
});
