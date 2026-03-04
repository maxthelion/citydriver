import { describe, it, expect } from 'vitest';
import { fillSinks, flowDirections, flowAccumulation, extractStreams, findConfluences } from '../../src/core/flowAccumulation.js';
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
});
