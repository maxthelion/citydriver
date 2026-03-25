import { describe, it, expect } from 'vitest';
import {
  countParallelViolations,
  countUnresolvedCrossings,
  countShortDeadEnds,
  checkAllViolations,
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
