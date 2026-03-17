import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import {
  findEntryPoint,
  computeEntryAccumulation,
  buildElevationProfile,
  carveCorridorTerrain,
  carveRiverProfiles,
} from '../../src/regional/carveRiverProfiles.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('findEntryPoint', () => {
  it('picks the lowest above-sea-level cell in the scan window', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    // Fill with high terrain
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;
    // Create a low point at (10, 0) on the north edge
    elevation.set(10, 0, 20);
    elevation.set(11, 0, 15); // lowest
    elevation.set(12, 0, 25);

    const planned = { gx: 10, gz: 0 };
    const result = findEntryPoint(planned, elevation, 'north', 0);

    expect(result.gx).toBe(11);
    expect(result.gz).toBe(0);
  });

  it('skips below-sea-level cells', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;
    elevation.set(10, 0, -5);  // below sea level
    elevation.set(11, 0, 30);  // lowest above sea level

    const planned = { gx: 10, gz: 0 };
    const result = findEntryPoint(planned, elevation, 'north', 0);

    expect(result.gx).toBe(11);
  });

  it('clamps scan window near corners', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;
    elevation.set(1, 0, 20);

    const planned = { gx: 1, gz: 0 };
    const result = findEntryPoint(planned, elevation, 'north', 0);

    // Should not crash, should find the low point
    expect(result.gx).toBeGreaterThanOrEqual(0);
    expect(result.gx).toBeLessThan(32);
  });
});

describe('computeEntryAccumulation', () => {
  it('returns high accumulation for low-elevation entry', () => {
    const acc = computeEntryAccumulation(10, 500, 0, 1.0);
    expect(acc).toBeGreaterThan(8000);
  });

  it('returns low accumulation for high-elevation entry', () => {
    const acc = computeEntryAccumulation(400, 500, 0, 1.0);
    expect(acc).toBeLessThan(4000);
  });

  it('scales by importance', () => {
    const full = computeEntryAccumulation(100, 500, 0, 1.0);
    const half = computeEntryAccumulation(100, 500, 0, 0.6);
    expect(half).toBeCloseTo(full * 0.6, 0);
  });
});

describe('buildElevationProfile', () => {
  it('returns monotonically decreasing elevations', () => {
    // Uniform medium resistance
    const resistance = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) resistance.data[i] = 0.5;

    const polyline = [];
    for (let i = 0; i < 20; i++) polyline.push({ gx: i + 5, gz: 16 });

    const profile = buildElevationProfile(polyline, 200, 0, resistance);

    expect(profile.length).toBe(polyline.length);
    for (let i = 1; i < profile.length; i++) {
      expect(profile[i]).toBeLessThanOrEqual(profile[i - 1]);
    }
    expect(profile[0]).toBeCloseTo(200, 0);
    expect(profile[profile.length - 1]).toBeCloseTo(0, 0);
  });

  it('hard rock creates knickpoints — steeper drops at resistant sections', () => {
    const resistance = new Grid2D(32, 32, { cellSize: 50 });
    // Soft rock everywhere
    for (let i = 0; i < 32 * 32; i++) resistance.data[i] = 0.2;
    // Hard rock band in the middle
    for (let gx = 0; gx < 32; gx++) {
      resistance.set(gx, 16, 0.9);
      resistance.set(gx, 15, 0.9);
      resistance.set(gx, 17, 0.9);
    }

    const polyline = [];
    for (let i = 0; i < 20; i++) polyline.push({ gx: 16, gz: i + 5 });

    const softProfile = buildElevationProfile(
      polyline, 200, 0,
      // All soft
      (() => { const r = new Grid2D(32, 32, { cellSize: 50 }); for (let i = 0; i < 32*32; i++) r.data[i] = 0.2; return r; })(),
    );
    const mixedProfile = buildElevationProfile(polyline, 200, 0, resistance);

    // At the midpoint, hard rock should hold elevation higher than soft
    const mid = Math.floor(polyline.length / 2);
    expect(mixedProfile[mid]).toBeGreaterThan(softProfile[mid]);
  });
});

describe('carveCorridorTerrain', () => {
  it('lowers terrain along corridor to match profile', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    const slope = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;

    const polyline = [];
    for (let i = 5; i < 25; i++) polyline.push({ gx: 16, gz: i });
    // Profile descends from 80 to 10
    const profile = polyline.map((_, i) => 80 - (i / (polyline.length - 1)) * 70);
    const accumulation = 5000;

    carveCorridorTerrain(polyline, profile, accumulation, elevation, slope);

    // Centre cells should be at or below profile (terrain was higher, and
    // overlapping valley radii from adjacent polyline points may pull lower)
    for (let i = 0; i < polyline.length; i++) {
      expect(elevation.get(polyline[i].gx, polyline[i].gz)).toBeLessThanOrEqual(profile[i] + 0.01);
      // But should be substantially lowered from the original 100
      expect(elevation.get(polyline[i].gx, polyline[i].gz)).toBeLessThan(100);
    }
  });

  it('never raises terrain above existing elevation', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    const slope = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 50;
    // One cell is already very low
    elevation.set(16, 15, 5);

    const polyline = [];
    for (let i = 5; i < 25; i++) polyline.push({ gx: 16, gz: i });
    const profile = polyline.map((_, i) => 80 - (i / (polyline.length - 1)) * 70);
    const accumulation = 5000;

    carveCorridorTerrain(polyline, profile, accumulation, elevation, slope);

    // The low cell should not have been raised
    expect(elevation.get(16, 15)).toBeLessThanOrEqual(5);
  });

  it('carves a valley wider than just the centreline', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    const slope = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;

    const polyline = [];
    for (let i = 5; i < 25; i++) polyline.push({ gx: 16, gz: i });
    const profile = polyline.map(() => 50);
    const accumulation = 5000;

    carveCorridorTerrain(polyline, profile, accumulation, elevation, slope);

    // Adjacent cells should also be lowered (valley widening)
    const adjElev = elevation.get(17, 15);
    expect(adjElev).toBeLessThan(100);
  });
});

describe('carveRiverProfiles', () => {
  it('enriches corridors with entryAccumulation and profile', () => {
    const W = 64, H = 64;
    const elevation = new Grid2D(W, H, { cellSize: 50 });
    const slope = new Grid2D(W, H, { cellSize: 50 });
    const resistance = new Grid2D(W, H, { cellSize: 50 });
    // Terrain: high in south, low in north
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        elevation.set(gx, gz, 200 - gz * 3);
        resistance.set(gx, gz, 0.5);
      }
    }

    const corridors = [{
      polyline: Array.from({ length: 50 }, (_, i) => ({ gx: 32, gz: 5 + i })),
      importance: 1.0,
      entryEdge: 'south',
      exitEdge: 'north',
    }];

    const enriched = carveRiverProfiles(corridors, elevation, slope, resistance, 0);

    expect(enriched[0].entryAccumulation).toBeGreaterThan(0);
    expect(enriched[0].profile).toBeInstanceOf(Array);
    expect(enriched[0].profile.length).toBe(corridors[0].polyline.length);
    // Profile should be monotonically decreasing
    for (let i = 1; i < enriched[0].profile.length; i++) {
      expect(enriched[0].profile[i]).toBeLessThanOrEqual(enriched[0].profile[i - 1]);
    }
  });

  it('ensures no corridor cell is below sea level after carving', () => {
    const W = 64, H = 64;
    const elevation = new Grid2D(W, H, { cellSize: 50 });
    const slope = new Grid2D(W, H, { cellSize: 50 });
    const resistance = new Grid2D(W, H, { cellSize: 50 });
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        elevation.set(gx, gz, 100 - gz * 1.5);
        resistance.set(gx, gz, 0.5);
      }
    }

    const corridors = [{
      polyline: Array.from({ length: 50 }, (_, i) => ({ gx: 32, gz: 5 + i })),
      importance: 1.0,
      entryEdge: 'south',
      exitEdge: 'north',
    }];

    carveRiverProfiles(corridors, elevation, slope, resistance, 0);

    for (const pt of corridors[0].polyline) {
      expect(elevation.get(pt.gx, pt.gz)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('acceptance: seed 786031 river connectivity', () => {
  it('produces a connected major river (not 67 fragments)', () => {
    const rng = new SeededRandom(786031);
    const layers = generateRegion({ width: 256, height: 256, cellSize: 50, seaLevel: 0 }, rng);
    const rivers = layers.getData('rivers');

    // Should have far fewer roots than the 67 we had before
    expect(rivers.length).toBeLessThan(30);
    // The largest major river should have substantial flow
    const largest = rivers.reduce((best, r) => r.flowVolume > best.flowVolume ? r : best, { flowVolume: 0 });
    expect(largest.flowVolume).toBeGreaterThan(10000);
  });

  it('no corridor cell is below sea level after carving', () => {
    const rng = new SeededRandom(786031);
    const layers = generateRegion({ width: 256, height: 256, cellSize: 50, seaLevel: 0 }, rng);
    const elevation = layers.getGrid('elevation');
    const corridors = layers.getData('riverCorridors');

    for (const corridor of corridors) {
      for (let i = 0; i < corridor.polyline.length; i++) {
        const pt = corridor.polyline[i];
        // Allow last few cells near coast to be below sea level (coastline erosion)
        const distFromEnd = corridor.polyline.length - i;
        if (distFromEnd > 5) {
          expect(elevation.get(pt.gx, pt.gz)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
