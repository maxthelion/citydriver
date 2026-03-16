// test/city/pipeline/growthAgents.test.js
import { describe, it, expect } from 'vitest';
import { RESERVATION, scoreCell, spreadFromSeed, findSeeds } from '../../../src/city/pipeline/growthAgents.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

describe('RESERVATION constants', () => {
  it('defines all 9 reservation types', () => {
    expect(RESERVATION.NONE).toBe(0);
    expect(RESERVATION.COMMERCIAL).toBe(1);
    expect(RESERVATION.INDUSTRIAL).toBe(2);
    expect(RESERVATION.CIVIC).toBe(3);
    expect(RESERVATION.OPEN_SPACE).toBe(4);
    expect(RESERVATION.AGRICULTURE).toBe(5);
    expect(RESERVATION.RESIDENTIAL_FINE).toBe(6);
    expect(RESERVATION.RESIDENTIAL_ESTATE).toBe(7);
    expect(RESERVATION.RESIDENTIAL_QUALITY).toBe(8);
  });
});

describe('scoreCell', () => {
  it('returns weighted sum of spatial layer values', () => {
    const affinity = { centrality: 0.6, roadFrontage: 0.4 };
    const layers = {
      centrality: { get: () => 0.8 },
      roadFrontage: { get: () => 0.5 },
    };
    const score = scoreCell(10, 10, affinity, layers);
    // 0.6 * 0.8 + 0.4 * 0.5 = 0.48 + 0.20 = 0.68
    expect(score).toBeCloseTo(0.68);
  });

  it('handles negative affinity weights', () => {
    const affinity = { centrality: -0.2 };
    const layers = { centrality: { get: () => 0.5 } };
    expect(scoreCell(0, 0, affinity, layers)).toBeCloseTo(-0.1);
  });

  it('ignores missing layers', () => {
    const affinity = { centrality: 0.5, waterfrontness: 0.5 };
    const layers = { centrality: { get: () => 1.0 } };
    expect(scoreCell(0, 0, affinity, layers)).toBeCloseTo(0.5);
  });
});

describe('spreadFromSeed', () => {
  function makeGrid(w, h) {
    return new Grid2D(w, h, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
  }

  it('blob: grows outward from seed up to budget', () => {
    const resGrid = makeGrid(20, 20);
    const zoneGrid = makeGrid(20, 20);
    // Mark all cells as zone-eligible
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        zoneGrid.set(x, z, 1);

    const claimed = spreadFromSeed(
      { gx: 10, gz: 10 }, 12, resGrid, zoneGrid,
      RESERVATION.INDUSTRIAL, 'blob', {}, {}, 20, 20
    );
    expect(claimed.length).toBe(12);
    // All claimed cells should be marked in resGrid
    for (const c of claimed) {
      expect(resGrid.get(c.gx, c.gz)).toBe(RESERVATION.INDUSTRIAL);
    }
  });

  it('dot: claims only the seed cell', () => {
    const resGrid = makeGrid(10, 10);
    const zoneGrid = makeGrid(10, 10);
    zoneGrid.set(5, 5, 1);

    const claimed = spreadFromSeed(
      { gx: 5, gz: 5 }, 20, resGrid, zoneGrid,
      RESERVATION.CIVIC, 'dot', {}, {}, 10, 10
    );
    expect(claimed.length).toBe(1);
    expect(claimed[0]).toEqual({ gx: 5, gz: 5 });
  });

  it('does not overwrite existing reservations', () => {
    const resGrid = makeGrid(10, 10);
    const zoneGrid = makeGrid(10, 10);
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 10; x++)
        zoneGrid.set(x, z, 1);
    // Pre-fill some cells
    resGrid.set(5, 4, RESERVATION.COMMERCIAL);
    resGrid.set(5, 6, RESERVATION.COMMERCIAL);

    const claimed = spreadFromSeed(
      { gx: 5, gz: 5 }, 5, resGrid, zoneGrid,
      RESERVATION.INDUSTRIAL, 'blob', {}, {}, 10, 10
    );
    // Should not have overwritten the commercial cells
    expect(resGrid.get(5, 4)).toBe(RESERVATION.COMMERCIAL);
    expect(resGrid.get(5, 6)).toBe(RESERVATION.COMMERCIAL);
  });

  it('does not spread outside zone cells', () => {
    const resGrid = makeGrid(10, 10);
    const zoneGrid = makeGrid(10, 10);
    // Only a 3x3 zone
    for (let z = 4; z <= 6; z++)
      for (let x = 4; x <= 6; x++)
        zoneGrid.set(x, z, 1);

    const claimed = spreadFromSeed(
      { gx: 5, gz: 5 }, 20, resGrid, zoneGrid,
      RESERVATION.INDUSTRIAL, 'blob', {}, {}, 10, 10
    );
    expect(claimed.length).toBe(9); // bounded by zone
  });
});

describe('findSeeds', () => {
  function makeGrid(w, h) {
    return new Grid2D(w, h, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
  }

  it('roadFrontage: returns cells near roads', () => {
    const resGrid = makeGrid(20, 20);
    const zoneGrid = makeGrid(20, 20);
    const roadGrid = new Grid2D(20, 20, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        zoneGrid.set(x, z, 1);
    // Road along row 10
    for (let x = 0; x < 20; x++) roadGrid.set(x, 10, 1);

    const eligible = [];
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        if (resGrid.get(x, z) === 0 && zoneGrid.get(x, z) > 0)
          eligible.push({ gx: x, gz: z });

    const seeds = findSeeds('roadFrontage', eligible, 3, [4, 20],
      { roadFrontage: 0.8 }, { roadGrid, roadFrontage: roadGrid }, 20, 20, resGrid);
    expect(seeds.length).toBeLessThanOrEqual(3);
    // All seeds should be near the road (gz 9, 10, or 11)
    for (const s of seeds) {
      expect(Math.abs(s.gz - 10)).toBeLessThanOrEqual(2);
    }
  });

  it('scattered: returns spaced-apart seeds', () => {
    const resGrid = makeGrid(30, 30);
    const zoneGrid = makeGrid(30, 30);
    for (let z = 0; z < 30; z++)
      for (let x = 0; x < 30; x++)
        zoneGrid.set(x, z, 1);

    const eligible = [];
    for (let z = 0; z < 30; z++)
      for (let x = 0; x < 30; x++)
        eligible.push({ gx: x, gz: z });

    const seeds = findSeeds('scattered', eligible, 3, [3, 10],
      { centrality: 0.5 }, { centrality: { get: () => 0.5 } }, 30, 30, resGrid);
    expect(seeds.length).toBe(3);
    // Check minimum spacing: 3 * footprint[1] = 30 cells apart
    // On a 30x30 grid this means seeds must be spread out
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        const dx = seeds[i].gx - seeds[j].gx;
        const dz = seeds[i].gz - seeds[j].gz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        expect(dist).toBeGreaterThan(5); // at least some spacing
      }
    }
  });

  it('fill: returns many seeds without spacing constraint', () => {
    const resGrid = makeGrid(10, 10);
    const zoneGrid = makeGrid(10, 10);
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 10; x++)
        zoneGrid.set(x, z, 1);

    const eligible = [];
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 10; x++)
        eligible.push({ gx: x, gz: z });

    const seeds = findSeeds('fill', eligible, 5, [2, 15],
      {}, {}, 10, 10, resGrid);
    expect(seeds.length).toBe(5);
  });
});
