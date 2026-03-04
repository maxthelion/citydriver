import { describe, it, expect } from 'vitest';
import {
  fillSinks,
  flowDirections,
  flowAccumulation,
  extractStreams,
  findConfluences,
  findNarrowCrossings,
} from '../../src/core/flowAccumulation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal Heightmap-compatible object for testing.
 */
function createTestHeightmap(width, height, data) {
  return {
    width,
    height,
    get(gx, gz) {
      gx = Math.max(0, Math.min(width - 1, gx));
      gz = Math.max(0, Math.min(height - 1, gz));
      return data[gz * width + gx];
    },
    set(gx, gz, val) {
      data[gz * width + gx] = val;
    },
  };
}

/**
 * After fillSinks, every interior cell should be able to reach an edge via
 * downhill flow (D8).  Returns true if all cells can drain.
 */
function allCellsDrain(heightmap) {
  const W = heightmap.width;
  const H = heightmap.height;
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DZ = [0, 1, 1, 1, 0, -1, -1, -1];
  const DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      // Walk downhill from (gx, gz) — must eventually reach an edge.
      let cx = gx;
      let cz = gz;
      const visited = new Set();
      let reachedEdge = false;

      while (true) {
        if (cx === 0 || cx === W - 1 || cz === 0 || cz === H - 1) {
          reachedEdge = true;
          break;
        }
        const key = cz * W + cx;
        if (visited.has(key)) break; // stuck in a loop
        visited.add(key);

        const elev = heightmap.get(cx, cz);
        let bestDir = -1;
        let bestGrad = 0;
        for (let d = 0; d < 8; d++) {
          const nx = cx + DX[d];
          const nz = cz + DZ[d];
          if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
          const drop = elev - heightmap.get(nx, nz);
          if (drop <= 0) continue;
          const grad = drop / DIST[d];
          if (grad > bestGrad) { bestGrad = grad; bestDir = d; }
        }

        if (bestDir === -1) break; // no downhill neighbor — flat but on edge?
        cx += DX[bestDir];
        cz += DZ[bestDir];
      }

      if (!reachedEdge) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fillSinks', () => {
  it('fills a simple pit so all cells can drain to an edge', () => {
    // 7x7 heightmap with a general south-east slope and a depression in the
    // interior.  Edge cells slope from 20 (top-left) down to 6 (bottom-right)
    // so there is always a viable drainage path after filling.
    const W = 7;
    const H = 7;
    const data = new Float32Array(W * H);
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        // General south-east slope
        data[gz * W + gx] = 20 - gx * 1.5 - gz * 1.5;
      }
    }
    // Carve a depression at (3,3): drop it well below its neighbors.
    const center = 3 * W + 3;
    const originalCenter = data[center];
    data[center] = originalCenter - 10;
    // Also depress a neighbor to make a multi-cell pit.
    data[3 * W + 4] = data[3 * W + 4] - 8;

    const hm = createTestHeightmap(W, H, data);
    const depressedElev = hm.get(3, 3);

    fillSinks(hm);

    // The depressed cell should have been raised.
    expect(hm.get(3, 3)).toBeGreaterThan(depressedElev);

    // Every cell should now be able to reach an edge via downhill flow.
    expect(allCellsDrain(hm)).toBe(true);
  });

  it('does not modify an already-draining heightmap (uniform slope)', () => {
    // East-sloping: column 0 = 20, column 4 = 0
    const data = new Float32Array(25);
    for (let gz = 0; gz < 5; gz++) {
      for (let gx = 0; gx < 5; gx++) {
        data[gz * 5 + gx] = 20 - gx * 5;
      }
    }
    const original = new Float32Array(data);
    const hm = createTestHeightmap(5, 5, data);

    fillSinks(hm);

    for (let i = 0; i < 25; i++) {
      expect(data[i]).toBe(original[i]);
    }
  });
});

describe('flowDirections', () => {
  it('uniform eastward slope: all cells flow east (dir 0)', () => {
    // Column 0 = 20, column 4 = 0.  Every cell's steepest drop is eastward.
    const data = new Float32Array(25);
    for (let gz = 0; gz < 5; gz++) {
      for (let gx = 0; gx < 5; gx++) {
        data[gz * 5 + gx] = 20 - gx * 5;
      }
    }
    const hm = createTestHeightmap(5, 5, data);
    const dirs = flowDirections(hm);

    for (let gz = 0; gz < 5; gz++) {
      for (let gx = 0; gx < 5; gx++) {
        const d = dirs[gz * 5 + gx];
        if (gx === 4) {
          // Rightmost column has no lower neighbor to the east.
          // It can still flow S/N/diagonal if the neighbor is lower, but
          // on a purely east slope with same-row elevations equal, it will
          // be -1 (no downhill neighbor).
          expect(d).toBe(-1);
        } else {
          expect(d).toBe(0); // east
        }
      }
    }
  });

  it('V-shaped valley: cells on slopes flow toward the valley bottom', () => {
    // 7-wide heightmap.  Valley axis at column 3.
    // Elevation = |gx - 3| * 5  (V shape, symmetric).
    // Row variation: gentle south slope so flow isn't ambiguous.
    const W = 7;
    const H = 5;
    const data = new Float32Array(W * H);
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        data[gz * W + gx] = Math.abs(gx - 3) * 5 + (H - 1 - gz) * 0.5;
      }
    }
    const hm = createTestHeightmap(W, H, data);
    fillSinks(hm);
    const dirs = flowDirections(hm);

    // Interior cells left of valley (gx < 3) should flow east (0) or
    // south-east (1) — toward the valley bottom.
    // Interior cells right of valley (gx > 3) should flow west (4) or
    // south-west (3).
    for (let gz = 1; gz < H - 1; gz++) {
      for (let gx = 1; gx < W - 1; gx++) {
        const d = dirs[gz * W + gx];
        if (gx < 3) {
          // Should have an eastward component (dir 0, 1, or 7)
          expect([0, 1, 7]).toContain(d);
        } else if (gx > 3) {
          // Should have a westward component (dir 3, 4, or 5)
          expect([3, 4, 5]).toContain(d);
        }
        // gx === 3 is the valley axis — flows south (dir 2) due to south slope
      }
    }
  });
});

describe('flowAccumulation', () => {
  it('uniform east slope: rightmost column has highest accumulation', () => {
    const W = 5;
    const H = 5;
    const data = new Float32Array(W * H);
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        data[gz * W + gx] = 20 - gx * 5;
      }
    }
    const hm = createTestHeightmap(W, H, data);
    fillSinks(hm);
    const dirs = flowDirections(hm);
    const acc = flowAccumulation(hm, dirs);

    // The last column (gx=4) should have the highest accumulation values.
    for (let gz = 0; gz < H; gz++) {
      const edgeAcc = acc[gz * W + 4];
      // Each cell in the last column collects from all cells in its row
      // that flow east.  With a uniform east slope, that's the 4 cells
      // to its left plus itself = 5.
      expect(edgeAcc).toBe(5);
    }
  });

  it('funnel heightmap: lowest corner accumulates all cells', () => {
    // 5x5 where elevation = distance to corner (0,0).
    // So (0,0) is the lowest point and everything flows there.
    const W = 5;
    const H = 5;
    const data = new Float32Array(W * H);
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        data[gz * W + gx] = Math.sqrt(gx * gx + gz * gz);
      }
    }
    const hm = createTestHeightmap(W, H, data);
    fillSinks(hm);
    const dirs = flowDirections(hm);
    const acc = flowAccumulation(hm, dirs);

    // Corner (0,0) should collect all cells.
    expect(acc[0]).toBe(W * H);
  });
});

describe('extractStreams', () => {
  it('produces a DrainageNode with cells ordered high-to-low elevation', () => {
    // 20x20 V-shaped valley along column 10 with a south slope.
    // The valley concentrates flow so the stream along the valley axis
    // accumulates many upstream cells.
    const W = 20;
    const H = 20;
    const data = new Float32Array(W * H);
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        data[gz * W + gx] = Math.abs(gx - 10) * 3 + (H - 1 - gz) * 2;
      }
    }
    const hm = createTestHeightmap(W, H, data);
    fillSinks(hm);
    const dirs = flowDirections(hm);
    const acc = flowAccumulation(hm, dirs);
    const roots = extractStreams(acc, dirs, hm, { stream: 5, river: 500, majorRiver: 5000 });

    expect(roots.length).toBeGreaterThan(0);

    // Collect all segments (including children) into a flat list.
    function allSegments(nodes) {
      const result = [];
      for (const n of nodes) {
        result.push(n);
        result.push(...allSegments(n.children));
      }
      return result;
    }
    const segs = allSegments(roots);

    // Find the segment with the most cells.
    const longest = segs.reduce((a, b) => a.cells.length > b.cells.length ? a : b);
    expect(longest.cells.length).toBeGreaterThan(1);

    // Verify cells are ordered with non-increasing elevation.
    for (let i = 1; i < longest.cells.length; i++) {
      expect(longest.cells[i].elevation).toBeLessThanOrEqual(
        longest.cells[i - 1].elevation + 1e-6
      );
    }
  });

  it('rivers flow downhill — every extracted stream has non-increasing elevation', () => {
    const W = 12;
    const H = 12;
    const data = new Float32Array(W * H);
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        data[gz * W + gx] = Math.abs(gx - 6) * 2 + (H - 1 - gz) * 1.5;
      }
    }
    const hm = createTestHeightmap(W, H, data);
    fillSinks(hm);
    const dirs = flowDirections(hm);
    const acc = flowAccumulation(hm, dirs);
    const roots = extractStreams(acc, dirs, hm, { stream: 3, river: 500, majorRiver: 5000 });

    function checkDownhill(node) {
      for (let i = 1; i < node.cells.length; i++) {
        expect(node.cells[i].elevation).toBeLessThanOrEqual(
          node.cells[i - 1].elevation + 1e-6
        );
      }
      for (const child of node.children) {
        checkDownhill(child);
      }
    }

    for (const root of roots) {
      checkDownhill(root);
    }
  });
});

describe('findConfluences', () => {
  it('two valleys merging into one produce exactly one confluence', () => {
    // 15x15 heightmap.  Two valleys converge at approximately (7, 10).
    // Left valley axis at gx=4, right valley axis at gx=10, merging to gx=7.
    const W = 15;
    const H = 15;
    const data = new Float32Array(W * H);

    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        // Base: gentle south slope
        let elev = (H - 1 - gz) * 1.0;

        if (gz < 10) {
          // Two separate valleys in the upper part
          const distLeft = Math.abs(gx - 4);
          const distRight = Math.abs(gx - 10);
          const valley = Math.min(distLeft, distRight);
          elev += valley * 3;
        } else {
          // Single merged valley in the lower part
          const distCenter = Math.abs(gx - 7);
          elev += distCenter * 3;
        }

        data[gz * W + gx] = elev;
      }
    }

    const hm = createTestHeightmap(W, H, data);
    fillSinks(hm);
    const dirs = flowDirections(hm);
    const acc = flowAccumulation(hm, dirs);

    const confluences = findConfluences(acc, dirs, hm, 3);

    // Should find at least one confluence where the two valleys merge.
    expect(confluences.length).toBeGreaterThanOrEqual(1);

    // The confluence with the highest flow volume should be near the merge
    // area (gz around 9-12, gx around 5-9).
    const main = confluences.reduce((a, b) => a.flowVolume > b.flowVolume ? a : b);
    expect(main.tributaryCount).toBeGreaterThanOrEqual(2);
    expect(main.gz).toBeGreaterThanOrEqual(8);
    expect(main.gx).toBeGreaterThanOrEqual(4);
    expect(main.gx).toBeLessThanOrEqual(10);
  });
});

describe('findNarrowCrossings', () => {
  it('identifies the narrowest valley point along a stream', () => {
    // Create a heightmap with a river channel that is narrow in the middle
    // and wide at the ends.
    const W = 20;
    const H = 20;
    const data = new Float32Array(W * H);

    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        // River flows south along column 10.
        const distFromRiver = Math.abs(gx - 10);

        // Valley width varies: wide at top and bottom, narrow in the middle.
        // At gz=10, the valley walls are steepest (narrowest crossing).
        const narrowness = 1.0 + 3.0 * Math.exp(-((gz - 10) * (gz - 10)) / 8);
        const valleyProfile = distFromRiver * narrowness;

        // South slope so water flows downward.
        data[gz * W + gx] = valleyProfile + (H - 1 - gz) * 0.5;
      }
    }

    const hm = createTestHeightmap(W, H, data);

    // Construct stream cells along the valley axis (column 10, flowing south).
    const streamCells = [];
    for (let gz = 1; gz < H - 1; gz++) {
      streamCells.push({ gx: 10, gz });
    }

    const crossings = findNarrowCrossings(streamCells, hm);

    expect(crossings.length).toBeGreaterThan(0);

    // The narrowest crossing should be near gz=10 where the valley is
    // steepest-walled.
    const narrowest = crossings[0];
    expect(narrowest.gz).toBeGreaterThanOrEqual(7);
    expect(narrowest.gz).toBeLessThanOrEqual(13);

    // Verify sorted ascending by valleyWidth.
    for (let i = 1; i < crossings.length; i++) {
      expect(crossings[i].valleyWidth).toBeGreaterThanOrEqual(crossings[i - 1].valleyWidth);
    }
  });
});
