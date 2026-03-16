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

  it('scored: grows outward from seed up to budget', () => {
    const resGrid = makeGrid(20, 20);
    const zoneGrid = makeGrid(20, 20);
    // Mark all cells as zone-eligible
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        zoneGrid.set(x, z, 1);

    const claimed = spreadFromSeed(
      { gx: 10, gz: 10 }, 12, resGrid, zoneGrid,
      RESERVATION.INDUSTRIAL, 'scored', {}, {}, 20, 20
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
      RESERVATION.INDUSTRIAL, 'scored', {}, {}, 10, 10
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
      RESERVATION.INDUSTRIAL, 'scored', {}, {}, 10, 10
    );
    expect(claimed.length).toBe(9); // bounded by zone
  });
});

describe('findSeeds', () => {
  it('returns top-scored seeds up to count', () => {
    const eligible = [];
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 10; x++)
        eligible.push({ gx: x, gz: z });

    // centrality layer: high in the centre
    const layers = {
      centrality: { get: (x, z) => 1.0 - Math.abs(x - 5) / 10 - Math.abs(z - 5) / 10 },
    };
    const seeds = findSeeds(eligible, 3, 0, { centrality: 1.0 }, layers, 10, 10);
    expect(seeds.length).toBe(3);
    // Seeds should be near centre (x=5, z=5)
    for (const s of seeds) {
      expect(Math.abs(s.gx - 5) + Math.abs(s.gz - 5)).toBeLessThanOrEqual(2);
    }
  });

  it('respects minSpacing between seeds', () => {
    const eligible = [];
    for (let z = 0; z < 30; z++)
      for (let x = 0; x < 30; x++)
        eligible.push({ gx: x, gz: z });

    const seeds = findSeeds(eligible, 3, 10, { centrality: 0.5 },
      { centrality: { get: () => 0.5 } }, 30, 30);
    expect(seeds.length).toBe(3);
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        const dx = seeds[i].gx - seeds[j].gx;
        const dz = seeds[i].gz - seeds[j].gz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        expect(dist).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('returns fewer seeds if minSpacing prevents more', () => {
    // 5x5 grid, minSpacing=4 — can only fit 1-2 seeds comfortably
    const eligible = [];
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 5; x++)
        eligible.push({ gx: x, gz: z });

    const seeds = findSeeds(eligible, 5, 4, {}, {}, 5, 5);
    // With spacing=4 on a 5x5 grid, at most ~2 seeds can fit
    expect(seeds.length).toBeLessThan(5);
  });

  it('returns empty array for empty eligible list', () => {
    const seeds = findSeeds([], 5, 0, {}, {}, 10, 10);
    expect(seeds).toEqual([]);
  });

  it('returns empty array when count is 0', () => {
    const eligible = [{ gx: 0, gz: 0 }];
    const seeds = findSeeds(eligible, 0, 0, {}, {}, 10, 10);
    expect(seeds).toEqual([]);
  });
});
