import { describe, it, expect } from 'vitest';
import { insetPolygon, computeSignedArea } from '../../src/core/polygonInset.js';

// Helper: CCW square (positive signed area)
function ccwSquare(size = 100) {
  return [
    { x: 0, z: 0 },
    { x: size, z: 0 },
    { x: size, z: size },
    { x: 0, z: size },
  ];
}

// Helper: CW square (negative signed area — reversed winding)
function cwSquare(size = 100) {
  return [
    { x: 0, z: 0 },
    { x: 0, z: size },
    { x: size, z: size },
    { x: size, z: 0 },
  ];
}

describe('computeSignedArea', () => {
  it('returns positive area for CCW polygon', () => {
    const area = computeSignedArea(ccwSquare(100));
    expect(area).toBeCloseTo(10000, 0);
  });

  it('returns negative area for CW polygon', () => {
    const area = computeSignedArea(cwSquare(100));
    expect(area).toBeCloseTo(-10000, 0);
  });
});

describe('insetPolygon', () => {
  it('returns empty for degenerate input (fewer than 3 vertices)', () => {
    expect(insetPolygon([], 10)).toEqual([]);
    expect(insetPolygon([{ x: 0, z: 0 }], 10)).toEqual([]);
    expect(insetPolygon([{ x: 0, z: 0 }, { x: 1, z: 0 }], 10)).toEqual([]);
  });

  it('square inset by 0 returns same polygon', () => {
    const sq = ccwSquare(100);
    const result = insetPolygon(sq, 0);
    expect(result.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(result[i].x).toBeCloseTo(sq[i].x, 6);
      expect(result[i].z).toBeCloseTo(sq[i].z, 6);
    }
  });

  it('CCW square inset by uniform distance gives smaller square', () => {
    const sq = ccwSquare(100);
    const d = 10;
    const result = insetPolygon(sq, d);

    expect(result.length).toBe(4);

    // Expected: corners at (10, 10), (90, 10), (90, 90), (10, 90)
    const expected = [
      { x: 10, z: 10 },
      { x: 90, z: 10 },
      { x: 90, z: 90 },
      { x: 10, z: 90 },
    ];
    for (let i = 0; i < 4; i++) {
      expect(result[i].x).toBeCloseTo(expected[i].x, 4);
      expect(result[i].z).toBeCloseTo(expected[i].z, 4);
    }
  });

  it('CW square inset by uniform distance gives smaller square', () => {
    const sq = cwSquare(100);
    const d = 10;
    const result = insetPolygon(sq, d);

    expect(result.length).toBe(4);

    // The inset polygon should be smaller, with area 80*80 = 6400
    const area = Math.abs(computeSignedArea(result));
    expect(area).toBeCloseTo(6400, 0);
  });

  it('square inset by exactly half-width collapses to empty', () => {
    const sq = ccwSquare(100);
    const result = insetPolygon(sq, 50);
    // Polygon collapses to a point (degenerate area)
    expect(result).toEqual([]);
  });

  it('square inset by more than half-width collapses to empty', () => {
    const sq = ccwSquare(100);
    const result = insetPolygon(sq, 60);
    expect(result).toEqual([]);
  });

  it('rectangle with non-uniform per-edge distances', () => {
    // Rectangle 200 x 100 (CCW)
    const rect = [
      { x: 0, z: 0 },     // bottom-left
      { x: 200, z: 0 },   // bottom-right
      { x: 200, z: 100 },  // top-right
      { x: 0, z: 100 },    // top-left
    ];

    // Distances: [bottom=10, right=20, top=10, left=20]
    const distances = [10, 20, 10, 20];
    const result = insetPolygon(rect, distances);

    expect(result.length).toBe(4);

    // Expected corners:
    // bottom edge inset 10 upward, left edge inset 20 rightward => (20, 10)
    // bottom edge inset 10 upward, right edge inset 20 leftward => (180, 10)
    // top edge inset 10 downward, right edge inset 20 leftward => (180, 90)
    // top edge inset 10 downward, left edge inset 20 rightward => (20, 90)
    const expected = [
      { x: 20, z: 10 },
      { x: 180, z: 10 },
      { x: 180, z: 90 },
      { x: 20, z: 90 },
    ];
    for (let i = 0; i < 4; i++) {
      expect(result[i].x).toBeCloseTo(expected[i].x, 4);
      expect(result[i].z).toBeCloseTo(expected[i].z, 4);
    }
  });

  it('equilateral triangle with uniform inset gives smaller triangle', () => {
    // Equilateral triangle (CCW), side length 100
    const h = 100 * Math.sqrt(3) / 2;
    const tri = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 50, z: h },
    ];

    const d = 5;
    const result = insetPolygon(tri, d);

    expect(result.length).toBe(3);

    // The inset triangle should have smaller area
    const originalArea = Math.abs(computeSignedArea(tri));
    const insetArea = Math.abs(computeSignedArea(result));
    expect(insetArea).toBeLessThan(originalArea);
    expect(insetArea).toBeGreaterThan(0);

    // The centroid should remain approximately the same
    const origCentroid = {
      x: (tri[0].x + tri[1].x + tri[2].x) / 3,
      z: (tri[0].z + tri[1].z + tri[2].z) / 3,
    };
    const insetCentroid = {
      x: (result[0].x + result[1].x + result[2].x) / 3,
      z: (result[0].z + result[1].z + result[2].z) / 3,
    };
    expect(insetCentroid.x).toBeCloseTo(origCentroid.x, 0);
    expect(insetCentroid.z).toBeCloseTo(origCentroid.z, 0);
  });

  it('concave L-shape polygon with uniform inset', () => {
    // L-shape (CCW):
    //  (0,0) → (60,0) → (60,40) → (40,40) → (40,60) → (0,60)
    const L = [
      { x: 0, z: 0 },
      { x: 60, z: 0 },
      { x: 60, z: 40 },
      { x: 40, z: 40 },
      { x: 40, z: 60 },
      { x: 0, z: 60 },
    ];

    const d = 5;
    const result = insetPolygon(L, d);

    // Should produce a valid polygon (6 vertices) with smaller area
    expect(result.length).toBe(6);
    const originalArea = Math.abs(computeSignedArea(L));
    const insetArea = Math.abs(computeSignedArea(result));
    expect(insetArea).toBeLessThan(originalArea);
    expect(insetArea).toBeGreaterThan(0);
  });

  it('throws when distances array length does not match polygon', () => {
    const sq = ccwSquare(100);
    expect(() => insetPolygon(sq, [10, 20])).toThrow(/Expected 4 distances/);
  });

  it('handles large inset on concave polygon (self-intersection) gracefully', () => {
    // L-shape with aggressive inset that would cause self-intersection
    const L = [
      { x: 0, z: 0 },
      { x: 60, z: 0 },
      { x: 60, z: 40 },
      { x: 40, z: 40 },
      { x: 40, z: 60 },
      { x: 0, z: 60 },
    ];

    // Inset by 25 — the inner corner of the L will collapse
    const result = insetPolygon(L, 25);
    // Should return empty (self-intersection detected) or a valid polygon
    if (result.length > 0) {
      // If it returned something, it should be a valid polygon
      const area = Math.abs(computeSignedArea(result));
      expect(area).toBeGreaterThan(0);
    }
  });
});
