// test/city/pipeline/allocateRibbon.test.js
import { describe, it, expect } from 'vitest';
import { allocateRibbon } from '../../../src/city/pipeline/allocateRibbon.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

function makeGrid(w, h, type = 'uint8') {
  return new Grid2D(w, h, { type, cellSize: 5, originX: 0, originZ: 0 });
}

describe('allocateRibbon', () => {
  it('claims strips with gaps along a road', () => {
    const w = 40, h = 40;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);
    const slope = makeGrid(w, h, 'float32'); // flat

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    // Horizontal road along row 20
    for (let x = 0; x < w; x++) roadGrid.set(x, 20, 1);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    const result = allocateRibbon({
      valueLayer, resGrid, zoneGrid, roadGrid, slope, devProximity,
      resType: 6, budget: 500, plotDepth: 3, gapWidth: 1,
      maxRibbonLength: 30, seedCount: 4, noise: 0.1,
      w, h, cellSize: 5,
    });

    expect(result.claimed.length).toBeGreaterThan(0);

    // Should produce ribbonGaps (cells that should become roads)
    expect(result.ribbonGaps.length).toBeGreaterThan(0);

    // Claimed cells should be near the road but not ON the road
    for (const c of result.claimed) {
      expect(roadGrid.get(c.gx, c.gz)).toBe(0);
    }

    // Gap cells should also not be on the original road
    for (const g of result.ribbonGaps) {
      expect(roadGrid.get(g.gx, g.gz)).toBe(0);
    }
  });

  it('creates parallel strips separated by gaps', () => {
    const w = 40, h = 40;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);
    const slope = makeGrid(w, h, 'float32');

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    for (let x = 0; x < w; x++) roadGrid.set(x, 20, 1);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    const result = allocateRibbon({
      valueLayer, resGrid, zoneGrid, roadGrid, slope, devProximity,
      resType: 6, budget: 1000, plotDepth: 2, gapWidth: 1,
      maxRibbonLength: 30, seedCount: 2, noise: 0,
      w, h, cellSize: 5,
    });

    // Check that there are gaps between claimed rows
    // Above the road, rows should alternate: claimed, claimed, gap, claimed, claimed, gap...
    // (plotDepth=2 means 2 rows of claims, gapWidth=1 means 1 row gap)
    const aboveRoad = result.claimed.filter(c => c.gz < 20);
    if (aboveRoad.length > 0) {
      const rows = new Set(aboveRoad.map(c => c.gz));
      // Should not have every row claimed — gaps should exist
      const minRow = Math.min(...rows);
      const maxRow = Math.max(...rows);
      const totalRows = maxRow - minRow + 1;
      expect(rows.size).toBeLessThan(totalRows); // some rows should be gaps
    }
  });

  it('returns ribbon metadata for cross street placement', () => {
    const w = 30, h = 30;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);
    const slope = makeGrid(w, h, 'float32');

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    for (let x = 0; x < w; x++) roadGrid.set(x, 15, 1);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    const result = allocateRibbon({
      valueLayer, resGrid, zoneGrid, roadGrid, slope, devProximity,
      resType: 6, budget: 500, plotDepth: 2, gapWidth: 1,
      maxRibbonLength: 15, seedCount: 2, noise: 0,
      w, h, cellSize: 5,
    });

    // Should return ribbon endpoints for cross street placement
    expect(result.ribbonEndpoints).toBeDefined();
    expect(result.ribbonEndpoints.length).toBeGreaterThan(0);
    // Each endpoint has position and direction
    for (const ep of result.ribbonEndpoints) {
      expect(ep.gx).toBeDefined();
      expect(ep.gz).toBeDefined();
      expect(ep.dx).toBeDefined();
      expect(ep.dz).toBeDefined();
    }
  });
});
