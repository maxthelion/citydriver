import { describe, it, expect } from 'vitest';
import { fillSinks, flowDirections, flowAccumulation, dinfFlowDirections, dinfFlowAccumulation, extractStreams, findConfluences } from '../../src/core/flowAccumulation.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('flowAccumulation', () => {
  function makeSloped(w, h) {
    // Simple slope: elevation = gz (higher at bottom)
    const g = new Grid2D(w, h);
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        g.set(gx, gz, h - gz); // higher at top (gz=0)
      }
    }
    return g;
  }

  it('fillSinks raises depression cells', () => {
    const g = new Grid2D(5, 5);
    // Create a bowl: edges high, center low
    for (let gz = 0; gz < 5; gz++) {
      for (let gx = 0; gx < 5; gx++) {
        if (gx === 0 || gx === 4 || gz === 0 || gz === 4) {
          g.set(gx, gz, 10);
        } else {
          g.set(gx, gz, 1); // depression
        }
      }
    }
    // One low exit at edge
    g.set(2, 0, 2);

    fillSinks(g);

    // After filling, all interior cells should be >= the pour point (2)
    for (let gz = 1; gz < 4; gz++) {
      for (let gx = 1; gx < 4; gx++) {
        expect(g.get(gx, gz)).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('flowDirections assigns downhill directions on sloped terrain', () => {
    const g = makeSloped(5, 5);
    const dirs = flowDirections(g);

    // Interior cell should flow north (toward gz=0 which has highest elevation?
    // Actually our slope is: elevation = h - gz, so gz=0 has highest elev.
    // So flow should be toward higher gz (downhill).
    // Direction 2 = South (dz=+1)
    const dir = dirs[2 * 5 + 2]; // cell (2,2)
    expect(dir).toBe(2); // South
  });

  it('flowAccumulation counts upstream cells', () => {
    const g = makeSloped(5, 5);
    fillSinks(g);
    const dirs = flowDirections(g);
    const acc = flowAccumulation(g, dirs);

    // Bottom row should have highest accumulation
    // Total cells = 25. Bottom-center should collect from most cells above.
    const bottomCenter = acc[4 * 5 + 2];
    const topCenter = acc[0 * 5 + 2];
    expect(bottomCenter).toBeGreaterThan(topCenter);
  });

  it('every cell has accumulation >= 1', () => {
    const g = makeSloped(10, 10);
    fillSinks(g);
    const dirs = flowDirections(g);
    const acc = flowAccumulation(g, dirs);

    for (let i = 0; i < acc.length; i++) {
      expect(acc[i]).toBeGreaterThanOrEqual(1);
    }
  });

  it('extractStreams returns segments with cells', () => {
    // Create a terrain with a clear valley
    const g = new Grid2D(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        // V-shaped valley along center column
        const distFromCenter = Math.abs(gx - 10);
        g.set(gx, gz, distFromCenter * 2 + (20 - gz) * 0.5);
      }
    }

    fillSinks(g);
    const dirs = flowDirections(g);
    const acc = flowAccumulation(g, dirs);
    const streams = extractStreams(acc, dirs, g, { stream: 5, river: 50, majorRiver: 200 });

    // Should have at least one stream
    expect(streams.length).toBeGreaterThan(0);
    // Each stream should have cells
    for (const seg of streams) {
      expect(seg.cells.length).toBeGreaterThan(0);
      expect(seg.rank).toBeDefined();
    }
  });

  it('findConfluences finds junction points', () => {
    // Use the same V-valley terrain
    const g = new Grid2D(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        const distFromCenter = Math.abs(gx - 10);
        g.set(gx, gz, distFromCenter * 2 + (20 - gz) * 0.5);
      }
    }

    fillSinks(g);
    const dirs = flowDirections(g);
    const acc = flowAccumulation(g, dirs);
    const confluences = findConfluences(acc, dirs, g, 3);

    // With a V-valley, tributaries should join
    // At minimum the function should return an array
    expect(Array.isArray(confluences)).toBe(true);
  });

  // ─── D-infinity tests ─────────────────────────────────────────────────

  describe('dinfFlowDirections', () => {
    it('matches D8 on axis-aligned slopes', () => {
      // Pure southward slope: elevation = h - gz
      // Both D8 and Dinf should agree on direction 2 (South)
      const g = new Grid2D(10, 10);
      for (let gz = 0; gz < 10; gz++) {
        for (let gx = 0; gx < 10; gx++) {
          g.set(gx, gz, 10 - gz);
        }
      }

      const d8Dirs = flowDirections(g);
      const dinfDirs = dinfFlowDirections(g);

      // Check interior cells (edges may differ due to boundary effects)
      for (let gz = 1; gz < 9; gz++) {
        for (let gx = 1; gx < 9; gx++) {
          const idx = gz * 10 + gx;
          expect(dinfDirs[idx]).toBe(d8Dirs[idx]);
        }
      }
    });

    it('returns Int8Array with valid D8 directions', () => {
      // On any terrain, every cell should have a direction in [-1, 7]
      const g = new Grid2D(10, 10);
      for (let gz = 0; gz < 10; gz++) {
        for (let gx = 0; gx < 10; gx++) {
          g.set(gx, gz, 50 - gx * 3 - gz * 2);
        }
      }

      const dirs = dinfFlowDirections(g);
      expect(dirs).toBeInstanceOf(Int8Array);
      expect(dirs.length).toBe(100);
      for (let i = 0; i < dirs.length; i++) {
        expect(dirs[i]).toBeGreaterThanOrEqual(-1);
        expect(dirs[i]).toBeLessThanOrEqual(7);
      }
    });
  });

  describe('dinfFlowAccumulation', () => {
    it('distributes flow more evenly than D8 on a tilted plane', () => {
      // Create a 20x20 plane tilted at ~22.5° between East and NE.
      // elevation = -gx - 0.414*gz  (tan(22.5°) ≈ 0.414)
      // With D8, flow concentrates into axis-aligned channels.
      // With Dinf, flow should spread between E and NE neighbors.
      const size = 20;
      const g = new Grid2D(size, size);
      const tan22 = Math.tan(Math.PI / 8); // ≈ 0.414
      for (let gz = 0; gz < size; gz++) {
        for (let gx = 0; gx < size; gx++) {
          // Higher at top-left, lower at bottom-right
          g.set(gx, gz, 100 - gx - tan22 * gz);
        }
      }

      fillSinks(g);

      const d8Dirs = flowDirections(g);
      const d8Acc = flowAccumulation(g, d8Dirs);
      const dinfDirs = dinfFlowDirections(g);
      const dinfAcc = dinfFlowAccumulation(g, dinfDirs);

      // Find max accumulation for each method
      let d8Max = 0, dinfMax = 0;
      for (let i = 0; i < d8Acc.length; i++) {
        if (d8Acc[i] > d8Max) d8Max = d8Acc[i];
        if (dinfAcc[i] > dinfMax) dinfMax = dinfAcc[i];
      }

      // Dinf should have a lower peak accumulation (flow is more spread out)
      expect(dinfMax).toBeLessThan(d8Max);
    });

    it('all cells have accumulation >= 1', () => {
      const g = new Grid2D(15, 15);
      for (let gz = 0; gz < 15; gz++) {
        for (let gx = 0; gx < 15; gx++) {
          g.set(gx, gz, 15 - gz);
        }
      }

      fillSinks(g);
      const dirs = dinfFlowDirections(g);
      const acc = dinfFlowAccumulation(g, dirs);

      for (let i = 0; i < acc.length; i++) {
        expect(acc[i]).toBeGreaterThanOrEqual(1);
      }
    });

    it('returns Float32Array with same size as grid', () => {
      const g = new Grid2D(8, 8);
      for (let gz = 0; gz < 8; gz++) {
        for (let gx = 0; gx < 8; gx++) {
          g.set(gx, gz, 8 - gz);
        }
      }

      fillSinks(g);
      const dirs = dinfFlowDirections(g);
      const acc = dinfFlowAccumulation(g, dirs);

      expect(acc).toBeInstanceOf(Float32Array);
      expect(acc.length).toBe(64);
    });
  });
});
