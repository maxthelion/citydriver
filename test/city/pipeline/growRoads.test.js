// test/city/pipeline/growRoads.test.js
import { describe, it, expect } from 'vitest';
import { growRoads } from '../../../src/city/pipeline/growRoads.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

function makeGrid(w, h, type = 'uint8') {
  return new Grid2D(w, h, { type, cellSize: 5, originX: 0, originZ: 0 });
}

describe('growRoads', () => {
  it('marks ribbon gaps as road cells', () => {
    const w = 20, h = 20;
    const roadGrid = makeGrid(w, h);
    const ribbonGaps = [
      { gx: 5, gz: 5 }, { gx: 6, gz: 5 }, { gx: 7, gz: 5 },
    ];

    growRoads({ roadGrid, ribbonGaps, ribbonEndpoints: [], w, h,
      maxCrossStreetLength: 10, pathClosingDistance: 10 });

    for (const g of ribbonGaps) {
      expect(roadGrid.get(g.gx, g.gz)).toBe(1);
    }
  });

  it('extends cross streets from ribbon endpoints', () => {
    const w = 30, h = 30;
    const roadGrid = makeGrid(w, h);

    // Existing road along row 15
    for (let x = 0; x < w; x++) roadGrid.set(x, 15, 1);

    // Ribbon endpoint wanting to extend upward
    const ribbonEndpoints = [
      { gx: 15, gz: 14, dx: 0, dz: -1 }, // extend upward from road
    ];

    growRoads({ roadGrid, ribbonGaps: [], ribbonEndpoints, w, h,
      maxCrossStreetLength: 10, pathClosingDistance: 10 });

    // Should have placed some road cells above row 15
    let newRoadCells = 0;
    for (let z = 0; z < 14; z++) {
      if (roadGrid.get(15, z) > 0) newRoadCells++;
    }
    expect(newRoadCells).toBeGreaterThan(0);
    expect(newRoadCells).toBeLessThanOrEqual(10); // max cross street length
  });

  it('connects cross streets to nearby existing roads', () => {
    const w = 30, h = 30;
    const roadGrid = makeGrid(w, h);

    // Two parallel roads
    for (let x = 0; x < w; x++) {
      roadGrid.set(x, 10, 1);
      roadGrid.set(x, 20, 1);
    }

    // Cross street starting from road at row 10, extending toward road at row 20
    const ribbonEndpoints = [
      { gx: 15, gz: 11, dx: 0, dz: 1 },
    ];

    growRoads({ roadGrid, ribbonGaps: [], ribbonEndpoints, w, h,
      maxCrossStreetLength: 20, pathClosingDistance: 15 });

    // Should have connected: road cells from row 11 to row 20
    let connected = true;
    for (let z = 11; z < 20; z++) {
      if (roadGrid.get(15, z) === 0) { connected = false; break; }
    }
    expect(connected).toBe(true);
  });
});
