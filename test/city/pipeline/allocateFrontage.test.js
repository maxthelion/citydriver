// test/city/pipeline/allocateFrontage.test.js
import { describe, it, expect } from 'vitest';
import { allocateFrontage } from '../../../src/city/pipeline/allocateFrontage.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

function makeGrid(w, h, type = 'uint8') {
  return new Grid2D(w, h, { type, cellSize: 5, originX: 0, originZ: 0 });
}

describe('allocateFrontage', () => {
  it('claims cells along a road proportional to value', () => {
    const w = 30, h = 30;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);

    // All in zone
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    // Horizontal road along row 15
    for (let x = 0; x < w; x++) roadGrid.set(x, 15, 1);

    // Value bitmap: high near road centre, lower at edges
    const valueLayer = new Float32Array(w * h);
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        valueLayer[z * w + x] = Math.max(0, 1.0 - Math.abs(x - 15) / 15);

    const devProximity = new Float32Array(w * h).fill(1.0);

    const claimed = allocateFrontage({
      valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
      resType: 1, budget: 200, maxDepth: 3, valueThreshold: 0.3,
      w, h,
    });

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.length).toBeLessThanOrEqual(200);

    // All claimed cells should be near the road (within maxDepth cells)
    for (const c of claimed) {
      expect(Math.abs(c.gz - 15)).toBeLessThanOrEqual(3);
    }

    // Centre of road should have deeper frontage than edges
    let centreCells = claimed.filter(c => Math.abs(c.gx - 15) < 5).length;
    let edgeCells = claimed.filter(c => Math.abs(c.gx - 15) > 10).length;
    // Centre has higher value → more depth per road cell → more claims
    expect(centreCells).toBeGreaterThan(edgeCells);
  });

  it('does not claim road cells themselves', () => {
    const w = 20, h = 20;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);
    for (let x = 0; x < w; x++) roadGrid.set(x, 10, 1);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    allocateFrontage({
      valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
      resType: 1, budget: 100, maxDepth: 2, valueThreshold: 0.1,
      w, h,
    });

    // Road cells should not be claimed
    for (let x = 0; x < w; x++) {
      expect(resGrid.get(x, 10)).toBe(0);
    }
  });

  it('respects existing reservations', () => {
    const w = 20, h = 20;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);
    for (let x = 0; x < w; x++) roadGrid.set(x, 10, 1);

    // Pre-fill row 11 with industrial
    for (let x = 0; x < w; x++) resGrid.set(x, 11, 2);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    const claimed = allocateFrontage({
      valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
      resType: 1, budget: 100, maxDepth: 2, valueThreshold: 0.1,
      w, h,
    });

    // Should only claim on the other side of the road (row 9)
    for (const c of claimed) {
      expect(c.gz).not.toBe(11);
    }
  });
});
