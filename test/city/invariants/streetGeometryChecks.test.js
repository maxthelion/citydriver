import { describe, it, expect } from 'vitest';
import {
  countParallelViolations,
  countUnresolvedCrossings,
  countShortDeadEnds,
  checkAllViolations,
  countWaterCrossings,
  countFullLengthParallelViolations,
  checkFaceCoverage,
  checkParcelViability,
} from '../../../src/city/invariants/streetGeometryChecks.js';

describe('countParallelViolations', () => {
  it('detects two parallel segments within 5m', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 0, z: 3 }, { x: 100, z: 3 }], // 3m apart, parallel
    ];
    expect(countParallelViolations(segs, 5)).toBe(1);
  });

  it('allows parallel segments beyond minimum separation', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 0, z: 10 }, { x: 100, z: 10 }], // 10m apart
    ];
    expect(countParallelViolations(segs, 5)).toBe(0);
  });

  it('ignores perpendicular segments even if close', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],    // horizontal
      [{ x: 50, z: -50 }, { x: 50, z: 50 }],  // vertical, crosses at midpoint
    ];
    expect(countParallelViolations(segs, 5)).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(countParallelViolations([])).toBe(0);
  });
});

describe('countUnresolvedCrossings', () => {
  it('detects two crossing segments without a junction', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 100 }],
      [{ x: 0, z: 100 }, { x: 100, z: 0 }],
    ];
    expect(countUnresolvedCrossings(segs)).toBe(1);
  });

  it('allows crossing when endpoint is near intersection', () => {
    // Two segments meeting at (50, 50)
    const segs = [
      [{ x: 0, z: 0 }, { x: 50, z: 50 }],
      [{ x: 0, z: 100 }, { x: 100, z: 0 }], // passes through (50, 50)
    ];
    expect(countUnresolvedCrossings(segs)).toBe(0);
  });

  it('allows parallel non-crossing segments', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 0, z: 10 }, { x: 100, z: 10 }],
    ];
    expect(countUnresolvedCrossings(segs)).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(countUnresolvedCrossings([])).toBe(0);
  });
});

describe('countShortDeadEnds', () => {
  it('detects a short dead-end segment', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],  // main road
      [{ x: 50, z: 0 }, { x: 50, z: 10 }],  // 10m stub off main road
    ];
    expect(countShortDeadEnds(segs, 15)).toBe(1);
  });

  it('allows dead-ends longer than minimum', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 50, z: 0 }, { x: 50, z: 20 }], // 20m stub
    ];
    expect(countShortDeadEnds(segs, 15)).toBe(0);
  });

  it('does not count connected short segments', () => {
    // Three segments forming a short chain — no dead ends
    const segs = [
      [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      [{ x: 10, z: 0 }, { x: 20, z: 0 }],
      [{ x: 20, z: 0 }, { x: 30, z: 0 }],
    ];
    // All endpoints connect to neighbours — middle segment has no dead end
    // But first and last have one unconnected endpoint each, and they're short
    expect(countShortDeadEnds(segs, 15)).toBe(2);
  });

  it('returns 0 for empty input', () => {
    expect(countShortDeadEnds([])).toBe(0);
  });
});

describe('checkAllViolations', () => {
  it('returns all violation counts', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 0, z: 3 }, { x: 100, z: 3 }], // parallel violation
    ];
    const result = checkAllViolations(segs);
    expect(result.parallelViolations).toBe(1);
    expect(result.unresolvedCrossings).toBe(0);
    expect(result.shortDeadEnds).toBe(0);
  });
});

// ── countWaterCrossings ───────────────────────────────────────────────────

describe('countWaterCrossings', () => {
  // Helper: create a simple grid-like waterMask with .get(gx, gz)
  function makeWaterMask(W, H, waterCells) {
    const data = new Float32Array(W * H);
    for (const [gx, gz] of waterCells) data[gz * W + gx] = 1;
    return { get(gx, gz) { return data[gz * W + gx]; } };
  }

  it('detects a segment crossing water cells', () => {
    const W = 20, H = 20, cs = 5, ox = 0, oz = 0;
    // Water at column gx=10 (world x=50)
    const waterCells = [];
    for (let gz = 0; gz < H; gz++) waterCells.push([10, gz]);
    const mask = makeWaterMask(W, H, waterCells);

    // Segment crosses from x=25 to x=75 (passes through x=50 water column)
    const segs = [[{ x: 25, z: 25 }, { x: 75, z: 25 }]];
    expect(countWaterCrossings(segs, mask, ox, oz, cs, W, H)).toBe(1);
  });

  it('allows segments that stay on land', () => {
    const W = 20, H = 20, cs = 5, ox = 0, oz = 0;
    // Water at column gx=15 (world x=75)
    const waterCells = [];
    for (let gz = 0; gz < H; gz++) waterCells.push([15, gz]);
    const mask = makeWaterMask(W, H, waterCells);

    // Segment stays well left of water
    const segs = [[{ x: 5, z: 25 }, { x: 30, z: 25 }]];
    expect(countWaterCrossings(segs, mask, ox, oz, cs, W, H)).toBe(0);
  });

  it('skips very short segments (len < 1)', () => {
    const W = 10, H = 10, cs = 5, ox = 0, oz = 0;
    const mask = makeWaterMask(W, H, [[1, 1]]);
    // Segment with length < 1
    const segs = [[{ x: 5.0, z: 5.0 }, { x: 5.5, z: 5.0 }]];
    expect(countWaterCrossings(segs, mask, ox, oz, cs, W, H)).toBe(0);
  });

  it('returns 0 for empty input', () => {
    const mask = { get() { return 0; } };
    expect(countWaterCrossings([], mask, 0, 0, 5, 10, 10)).toBe(0);
  });
});

// ── countFullLengthParallelViolations ─────────────────────────────────────

describe('countFullLengthParallelViolations', () => {
  it('detects parallel segments close along their full length', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 0, z: 3 }, { x: 100, z: 3 }], // 3m apart, parallel
    ];
    expect(countFullLengthParallelViolations(segs, 5)).toBe(1);
  });

  it('allows parallel segments beyond minimum separation', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 0, z: 10 }, { x: 100, z: 10 }], // 10m apart
    ];
    expect(countFullLengthParallelViolations(segs, 5)).toBe(0);
  });

  it('detects violation that midpoint-only check would miss', () => {
    // Two segments converge: midpoints are 8m apart but endpoints are 2m apart
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 0, z: 2 }, { x: 100, z: 16 }], // start 2m apart, end 16m apart, mid 9m apart
    ];
    // midpoint-only check at 5m threshold would pass (mid distance ~9m)
    // but full-length check catches the start point at 2m
    expect(countFullLengthParallelViolations(segs, 5, 15)).toBe(1);
  });

  it('ignores perpendicular segments', () => {
    const segs = [
      [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      [{ x: 50, z: -50 }, { x: 50, z: 50 }],
    ];
    expect(countFullLengthParallelViolations(segs, 5)).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(countFullLengthParallelViolations([])).toBe(0);
  });
});

// ── checkFaceCoverage ─────────────────────────────────────────────────────

describe('checkFaceCoverage', () => {
  it('returns full coverage when all zone cells are in faces', () => {
    const W = 10;
    const zoneCells = [{ gx: 1, gz: 2 }, { gx: 3, gz: 4 }];
    const faces = [{ cells: [{ gx: 1, gz: 2 }, { gx: 3, gz: 4 }] }];
    const result = checkFaceCoverage(zoneCells, faces, W);
    expect(result.uncoveredCells).toBe(0);
    expect(result.totalZoneCells).toBe(2);
    expect(result.coverageRatio).toBe(1);
  });

  it('reports uncovered zone cells', () => {
    const W = 10;
    const zoneCells = [{ gx: 1, gz: 2 }, { gx: 3, gz: 4 }, { gx: 5, gz: 6 }];
    const faces = [{ cells: [{ gx: 1, gz: 2 }] }];
    const result = checkFaceCoverage(zoneCells, faces, W);
    expect(result.uncoveredCells).toBe(2);
    expect(result.totalZoneCells).toBe(3);
    expect(result.coverageRatio).toBeCloseTo(1 / 3);
  });

  it('handles multiple faces', () => {
    const W = 10;
    const zoneCells = [{ gx: 0, gz: 0 }, { gx: 1, gz: 1 }, { gx: 2, gz: 2 }, { gx: 3, gz: 3 }];
    const faces = [
      { cells: [{ gx: 0, gz: 0 }, { gx: 1, gz: 1 }] },
      { cells: [{ gx: 2, gz: 2 }] },
    ];
    const result = checkFaceCoverage(zoneCells, faces, W);
    expect(result.uncoveredCells).toBe(1);
    expect(result.coverageRatio).toBe(0.75);
  });

  it('handles empty faces list', () => {
    const W = 10;
    const zoneCells = [{ gx: 1, gz: 2 }];
    const result = checkFaceCoverage(zoneCells, [], W);
    expect(result.uncoveredCells).toBe(1);
    expect(result.coverageRatio).toBe(0);
  });

  it('handles empty zone cells', () => {
    const W = 10;
    const result = checkFaceCoverage([], [{ cells: [{ gx: 1, gz: 2 }] }], W);
    expect(result.uncoveredCells).toBe(0);
    expect(result.totalZoneCells).toBe(0);
    // coverageRatio is NaN (0/0) but that's mathematically correct for empty input
    expect(result.coverageRatio).toBeNaN();
  });
});

// ── checkParcelViability ──────────────────────────────────────────────────

describe('checkParcelViability', () => {
  it('accepts a well-proportioned parcel', () => {
    const polygon = [
      { x: 0, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 25 }, { x: 0, z: 25 },
    ];
    const result = checkParcelViability(polygon, 5);
    expect(result.width).toBe(30);
    expect(result.depth).toBe(25);
    expect(result.shortSide).toBe(25);
    expect(result.longSide).toBe(30);
    expect(result.tooShallow).toBe(false);
    expect(result.tooNarrow).toBe(false);
    expect(result.isSliver).toBe(false);
  });

  it('flags a shallow parcel (short side < 15)', () => {
    const polygon = [
      { x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 10 }, { x: 0, z: 10 },
    ];
    const result = checkParcelViability(polygon, 5);
    expect(result.tooShallow).toBe(true);
    expect(result.tooNarrow).toBe(false);
    expect(result.isSliver).toBe(false);
  });

  it('flags a narrow parcel (long side < 20)', () => {
    const polygon = [
      { x: 0, z: 0 }, { x: 15, z: 0 }, { x: 15, z: 10 }, { x: 0, z: 10 },
    ];
    const result = checkParcelViability(polygon, 5);
    expect(result.tooNarrow).toBe(true);
    expect(result.tooShallow).toBe(true);
  });

  it('flags a sliver parcel (ratio < 0.1)', () => {
    const polygon = [
      { x: 0, z: 0 }, { x: 200, z: 0 }, { x: 200, z: 5 }, { x: 0, z: 5 },
    ];
    const result = checkParcelViability(polygon, 5);
    expect(result.isSliver).toBe(true);
    expect(result.ratio).toBeCloseTo(5 / 200);
  });

  it('handles a degenerate (zero-area) polygon', () => {
    const polygon = [
      { x: 10, z: 10 }, { x: 10, z: 10 },
    ];
    const result = checkParcelViability(polygon, 5);
    expect(result.width).toBe(0);
    expect(result.depth).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.tooShallow).toBe(true);
    expect(result.tooNarrow).toBe(true);
  });
});
