import { describe, it, expect } from 'vitest';
import { mergeRoadPaths } from '../../src/core/mergeRoadPaths.js';

/** Helper: create a horizontal path from (x0,z) to (x1,z) */
function hPath(x0, x1, z, rank = 1) {
  const cells = [];
  const step = x0 <= x1 ? 1 : -1;
  for (let x = x0; step > 0 ? x <= x1 : x >= x1; x += step) {
    cells.push({ gx: x, gz: z });
  }
  return { cells, rank };
}

/** Helper: create a vertical path from (x, z0) to (x, z1) */
function vPath(x, z0, z1, rank = 1) {
  const cells = [];
  const step = z0 <= z1 ? 1 : -1;
  for (let z = z0; step > 0 ? z <= z1 : z >= z1; z += step) {
    cells.push({ gx: x, gz: z });
  }
  return { cells, rank };
}

/** Utility: cell key */
function cKey(c) { return `${c.gx},${c.gz}`; }

/** Utility: count how many segments each cell appears in */
function cellSegmentCounts(segments) {
  const counts = new Map();
  for (const seg of segments) {
    for (const c of seg.cells) {
      const k = cKey(c);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return counts;
}

describe('mergeRoadPaths', () => {
  it('two paths sharing a middle section produce no duplicate segments', () => {
    // Path A: x=0..7 at z=0
    // Path B: x=3..10 at z=0
    // Overlap at x=3..7
    const pathA = hPath(0, 7, 0);
    const pathB = hPath(3, 10, 0);

    const segments = mergeRoadPaths([pathA, pathB]);

    // Should produce 3 segments: A-only (0..3), shared (3..7), B-only (7..10)
    expect(segments.length).toBe(3);

    // No cell should appear in more than 2 segments (junction overlap only)
    const counts = cellSegmentCounts(segments);
    for (const [key, count] of counts) {
      expect(count, `cell ${key} appears in ${count} segments`).toBeLessThanOrEqual(2);
    }

    // All cells from both paths should be covered
    const allCells = new Set();
    for (const seg of segments) {
      for (const c of seg.cells) allCells.add(cKey(c));
    }
    for (let x = 0; x <= 10; x++) {
      expect(allCells.has(`${x},0`), `cell (${x},0) missing`).toBe(true);
    }
  });

  it('three paths forming a Y-junction produce 3 segments', () => {
    // All three paths share cell (5,5) as the junction
    // Path A: (0,5) -> (5,5)
    // Path B: (5,5) -> (10,5)
    // Path C: (5,5) -> (5,0)
    const pathA = hPath(0, 5, 5);
    const pathB = hPath(5, 10, 5);
    const pathC = vPath(5, 5, 0);

    const segments = mergeRoadPaths([pathA, pathB, pathC]);

    // Should produce 3 segments meeting at (5,5)
    expect(segments.length).toBe(3);

    // Junction cell (5,5) should appear in all 3 segments (as endpoint)
    const counts = cellSegmentCounts(segments);
    expect(counts.get('5,5')).toBe(3);
  });

  it('path that is a subset of another produces 3 segments', () => {
    // Path A: x=0..10 at z=0
    // Path B: x=3..7 at z=0 (subset)
    const pathA = hPath(0, 10, 0);
    const pathB = hPath(3, 7, 0);

    const segments = mergeRoadPaths([pathA, pathB]);

    // Should produce 3 segments: 0..3, 3..7, 7..10
    expect(segments.length).toBe(3);

    // Cells 4,5,6 (interior of shared section) appear in exactly 1 segment
    const counts = cellSegmentCounts(segments);
    expect(counts.get('4,0')).toBe(1);
    expect(counts.get('5,0')).toBe(1);
    expect(counts.get('6,0')).toBe(1);
  });

  it('no shared cells keeps paths separate', () => {
    // Two paths at different z values — no overlap
    const pathA = hPath(0, 5, 0);
    const pathB = hPath(0, 5, 10);

    const segments = mergeRoadPaths([pathA, pathB]);

    expect(segments.length).toBe(2);

    // No cell appears in more than one segment
    const counts = cellSegmentCounts(segments);
    for (const [key, count] of counts) {
      expect(count, `cell ${key} appears in ${count} segments`).toBe(1);
    }
  });

  it('empty input returns empty', () => {
    const segments = mergeRoadPaths([]);
    expect(segments).toEqual([]);
  });

  it('single path returns one segment', () => {
    const pathA = hPath(0, 5, 0);
    const segments = mergeRoadPaths([pathA]);

    expect(segments.length).toBe(1);
    expect(segments[0].cells.length).toBe(6); // 0,1,2,3,4,5
  });
});
