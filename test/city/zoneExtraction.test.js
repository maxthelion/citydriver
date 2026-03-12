import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { FeatureMap } from '../../src/core/FeatureMap.js';
import {
  morphClose, floodFillZones, extractZoneBoundary, extractDevelopmentZones,
} from '../../src/city/zoneExtraction.js';

describe('morphClose', () => {
  it('fills small holes in a mask', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 1 });
    mask.set(10, 10, 0);
    mask.set(11, 10, 0);
    mask.set(10, 11, 0);
    mask.set(11, 11, 0);

    const closed = morphClose(mask, 2);
    expect(closed.get(10, 10)).toBe(1);
    expect(closed.get(11, 11)).toBe(1);
  });

  it('does not expand outer boundary', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 0 });
    for (let z = 8; z <= 12; z++)
      for (let x = 8; x <= 12; x++)
        mask.set(x, z, 1);

    const closed = morphClose(mask, 2);
    expect(closed.get(5, 5)).toBe(0);
    expect(closed.get(15, 15)).toBe(0);
    expect(closed.get(10, 10)).toBe(1);
  });
});

describe('floodFillZones', () => {
  it('finds connected components', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 0 });
    for (let z = 2; z <= 5; z++)
      for (let x = 2; x <= 5; x++) mask.set(x, z, 1);
    for (let z = 12; z <= 16; z++)
      for (let x = 12; x <= 16; x++) mask.set(x, z, 1);

    const zones = floodFillZones(mask, 1);
    expect(zones.length).toBe(2);
  });

  it('filters zones by minimum size', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 0 });
    for (let z = 2; z <= 10; z++)
      for (let x = 2; x <= 10; x++) mask.set(x, z, 1);
    for (let z = 15; z <= 16; z++)
      for (let x = 15; x <= 16; x++) mask.set(x, z, 1);

    const zones = floodFillZones(mask, 10);
    expect(zones.length).toBe(1);
    expect(zones[0].cells.length).toBeGreaterThan(10);
  });

  it('computes zone centroid', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 0 });
    for (let z = 5; z <= 15; z++)
      for (let x = 5; x <= 15; x++) mask.set(x, z, 1);

    const zones = floodFillZones(mask, 1);
    expect(zones.length).toBe(1);
    expect(zones[0].centroidGx).toBeCloseTo(10, 0);
    expect(zones[0].centroidGz).toBeCloseTo(10, 0);
  });
});

describe('extractZoneBoundary', () => {
  it('returns a closed polygon for a rectangular zone', () => {
    const cells = [];
    for (let gz = 5; gz <= 10; gz++)
      for (let gx = 5; gx <= 10; gx++)
        cells.push({ gx, gz });

    const boundary = extractZoneBoundary(cells, 5, 100, 100);
    expect(boundary.length).toBeGreaterThanOrEqual(4);
    for (const pt of boundary) {
      expect(pt.x).toBeDefined();
      expect(pt.z).toBeDefined();
    }
  });

  it('boundary encloses zone cells', () => {
    const cells = [];
    for (let gz = 5; gz <= 10; gz++)
      for (let gx = 5; gx <= 10; gx++)
        cells.push({ gx, gz });

    const boundary = extractZoneBoundary(cells, 5, 0, 0);
    const cx = 7.5 * 5, cz = 7.5 * 5;
    expect(pointInPolygon(cx, cz, boundary)).toBe(true);
  });
});

describe('extractDevelopmentZones', () => {
  it('extracts zones from a flat map with nuclei', () => {
    const map = new FeatureMap(60, 60, 5);
    const elevation = new Grid2D(60, 60, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(60, 60, { cellSize: 5, fill: 0.02 });
    map.setTerrain(elevation, slope);
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();

    const zones = extractDevelopmentZones(map);
    expect(zones.length).toBeGreaterThan(0);
    for (const z of zones) {
      expect(z.cells.length).toBeGreaterThan(0);
      expect(z.boundary.length).toBeGreaterThanOrEqual(4);
      expect(z.nucleusIdx).toBeDefined();
      expect(z.avgSlope).toBeDefined();
      expect(z.priority).toBeGreaterThan(0);
    }
  });

  it('assigns zones to nearest nucleus', () => {
    const map = new FeatureMap(100, 100, 5);
    const elevation = new Grid2D(100, 100, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(100, 100, { cellSize: 5, fill: 0.02 });
    map.setTerrain(elevation, slope);
    map.nuclei = [
      { gx: 25, gz: 50, type: 'market' },
      { gx: 75, gz: 50, type: 'suburban' },
    ];
    map.computeLandValue();

    const zones = extractDevelopmentZones(map);
    const nuclei0 = zones.filter(z => z.nucleusIdx === 0);
    const nuclei1 = zones.filter(z => z.nucleusIdx === 1);
    expect(nuclei0.length).toBeGreaterThan(0);
    expect(nuclei1.length).toBeGreaterThan(0);
  });
});

// Helper: construct a FeatureMap with manually set grids for isolated testing.
// Bypasses setTerrain()/computeLandValue() to control exact cell values.
function makeZoneTestMap(w, h) {
  const map = new FeatureMap(w, h, 5);
  map.slope = new Grid2D(w, h, { cellSize: 5, fill: 0 });
  map.buildability = new Grid2D(w, h, { cellSize: 5, fill: 0 });
  return map;
}

describe('adaptive slope threshold', () => {
  it('includes high-slope cells when land value is high', () => {
    const map = makeZoneTestMap(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        map.slope.set(gx, gz, 0.25);
        map.landValue.set(gx, gz, 0.8);
        map.buildability.set(gx, gz, 0.5);
      }
    }
    map.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];
    const zones = extractDevelopmentZones(map);
    expect(zones.length).toBeGreaterThan(0);
  });

  it('excludes high-slope cells when land value is low', () => {
    const map = makeZoneTestMap(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        map.slope.set(gx, gz, 0.25);
        map.landValue.set(gx, gz, 0.31);
        map.buildability.set(gx, gz, 0.5);
      }
    }
    map.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];
    const zones = extractDevelopmentZones(map);
    expect(zones.length).toBe(0);
  });

  it('stores avgLandValue on zone metadata', () => {
    const map = makeZoneTestMap(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        map.slope.set(gx, gz, 0.05);
        map.landValue.set(gx, gz, 0.7);
        map.buildability.set(gx, gz, 0.5);
      }
    }
    map.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];
    const zones = extractDevelopmentZones(map);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].avgLandValue).toBeCloseTo(0.7, 1);
  });

  it('steeper zones get lower priority than flat zones of equal land value', () => {
    const mapFlat = makeZoneTestMap(20, 20);
    const mapSteep = makeZoneTestMap(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        mapFlat.slope.set(gx, gz, 0.05);
        mapFlat.landValue.set(gx, gz, 0.7);
        mapFlat.buildability.set(gx, gz, 0.5);
        mapSteep.slope.set(gx, gz, 0.22);
        mapSteep.landValue.set(gx, gz, 0.7);
        mapSteep.buildability.set(gx, gz, 0.5);
      }
    }
    mapFlat.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];
    mapSteep.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];
    const flatZones = extractDevelopmentZones(mapFlat);
    const steepZones = extractDevelopmentZones(mapSteep);
    expect(flatZones.length).toBeGreaterThan(0);
    expect(steepZones.length).toBeGreaterThan(0);
    expect(steepZones[0].priority).toBeLessThan(flatZones[0].priority);
  });
});

// Helper for point-in-polygon (ray casting)
function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
