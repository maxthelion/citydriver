import { describe, expect, it } from 'vitest';
import { layRibbons } from '../../../src/city/incremental/ribbons.js';

function makeStreet(points, ctOff) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return { points, ctOff, length };
}

function makeScanStreet(startX, startZ, endZ, gradX, gradZ, stepSize, ctOff) {
  const points = [];
  const totalDist = (endZ - startZ) / gradZ;
  const numSteps = Math.abs(Math.round(totalDist / stepSize));
  for (let i = 0; i <= numSteps; i++) {
    const t = i * stepSize;
    points.push({
      x: startX + gradX * t,
      z: startZ + gradZ * t,
    });
  }
  return makeStreet(points, ctOff);
}

function makeMockMap(crossStreets) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const street of crossStreets) {
    for (const p of street.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }

  const pad = 50;
  const cellSize = 5;
  const originX = minX - pad;
  const originZ = minZ - pad;
  const width = Math.ceil((maxX - minX + 2 * pad) / cellSize);
  const height = Math.ceil((maxZ - minZ + 2 * pad) / cellSize);

  const cells = [];
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      cells.push({ gx, gz });
    }
  }

  return {
    map: {
      cellSize,
      width,
      height,
      originX,
      originZ,
      hasLayer: () => false,
      getLayer: () => null,
    },
    zone: {
      cells,
      centroidGx: width / 2,
      centroidGz: height / 2,
    },
  };
}

describe('layRibbons', () => {
  it('lays one seed link from the centroid street to one adjacent cross street', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons, parcels, angleRejects } = layRibbons(crossStreets, zone, map);

    expect(ribbons).toHaveLength(1);
    expect(parcels).toHaveLength(0);
    expect(angleRejects).toBe(0);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(2);
    expect(ribbons[0].source).toBe('seed-link');
    const endpoints = [ribbons[0].points[0], ribbons[0].points[ribbons[0].points.length - 1]];
    const xs = endpoints.map(p => p.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBe(90);
  });

  it('lays one realistic seed link between adjacent scan streets', () => {
    const crossStreets = [
      makeScanStreet(0, 0, 300, 0.95, -0.31, 2.5, -45),
      makeScanStreet(28, 85, 385, 0.95, -0.31, 2.5, 0),
      makeScanStreet(56, 171, 471, 0.95, -0.31, 2.5, 45),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons, angleRejects } = layRibbons(crossStreets, zone, map);

    expect(angleRejects).toBe(0);
    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(2);
    expect(ribbons[0].source).toBe('seed-link');
  });

  it('projects across shifted neighboring streets instead of matching normalized progress', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([{ x: 90, z: 50 }, { x: 90, z: 350 }], 0),
      makeStreet([{ x: 180, z: 100 }, { x: 180, z: 400 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons } = layRibbons(crossStreets, zone, map);

    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(2);
    const endpoints = [ribbons[0].points[0], ribbons[0].points[ribbons[0].points.length - 1]];
    expect(Math.abs(endpoints[0].z - endpoints[1].z)).toBeLessThan(25);
    expect(Math.abs(endpoints[0].x - endpoints[1].x)).toBeGreaterThan(80);
  });

  it('still creates a seed link from a kinked anchor street near the sector centroid', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([
        { x: 90, z: 0 },
        { x: 90, z: 135 },
        { x: 125, z: 150 },
        { x: 90, z: 165 },
        { x: 90, z: 300 },
      ], 0),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons, angleRejects, seedAnchors } = layRibbons(crossStreets, zone, map);

    expect(angleRejects).toBeGreaterThanOrEqual(0);
    expect(seedAnchors).toHaveLength(1);
    expect(seedAnchors[0].streetIdx).toBe(1);
    expect(seedAnchors[0].point.x).toBeGreaterThan(90);
    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(2);
    expect(ribbons[0].source).toBe('seed-link');
  });

  it('stops before skipping over a failed neighboring street', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -180),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], -90),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 0),
      makeStreet([{ x: 270, z: 240 }, { x: 270, z: 540 }], 90),
      makeStreet([{ x: 360, z: 0 }, { x: 360, z: 300 }], 180),
    ];
    const { map, zone } = makeMockMap(crossStreets);
    zone.centroidGx = (180 - map.originX) / map.cellSize;
    zone.centroidGz = (150 - map.originZ) / map.cellSize;

    const { ribbons, failedRibbons } = layRibbons(crossStreets, zone, map);

    expect(ribbons).toHaveLength(1);
    const endpoints = [ribbons[0].points[0], ribbons[0].points[ribbons[0].points.length - 1]];
    const xs = endpoints.map(pt => pt.x).sort((a, b) => a - b);
    expect(xs).toEqual([90, 180]);
    expect(failedRibbons.length).toBeGreaterThanOrEqual(0);
  });

  it('chooses the seed anchor from the sector centroid rather than the middle street index', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -180),
      makeStreet([{ x: 75, z: 0 }, { x: 75, z: 300 }], -90),
      makeStreet([{ x: 150, z: 0 }, { x: 150, z: 300 }], 0),
      makeStreet([{ x: 225, z: 0 }, { x: 225, z: 300 }], 90),
      makeStreet([{ x: 300, z: 0 }, { x: 300, z: 300 }], 180),
    ];
    const { map, zone } = makeMockMap(crossStreets);
    zone.centroidGx = (225 - map.originX) / map.cellSize;
    zone.centroidGz = (220 - map.originZ) / map.cellSize;

    const { seedAnchors } = layRibbons(crossStreets, zone, map);

    expect(seedAnchors).toHaveLength(1);
    expect(Math.abs(seedAnchors[0].point.x - 225)).toBeLessThan(1e-6);
    expect(Math.abs(seedAnchors[0].point.z - 220)).toBeLessThan(1e-6);
  });

  it('orders neighboring streets by spatial placement rather than ctOff', () => {
    const crossStreets = [
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], -100),
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], 100),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeStreet([{ x: 270, z: 0 }, { x: 270, z: 300 }], 200),
    ];
    const { map, zone } = makeMockMap(crossStreets);
    zone.centroidGx = (180 - map.originX) / map.cellSize;
    zone.centroidGz = (150 - map.originZ) / map.cellSize;

    const { ribbons } = layRibbons(crossStreets, zone, map);

    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(2);
    const endpoints = [ribbons[0].points[0], ribbons[0].points[ribbons[0].points.length - 1]];
    const xs = endpoints.map(pt => pt.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBe(90);
    expect(xs.includes(0)).toBe(false);
  });
});
