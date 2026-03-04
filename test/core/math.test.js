import { describe, it, expect } from 'vitest';
import {
  lerp,
  inverseLerp,
  smoothstep,
  clamp,
  distance2D,
  normalize2D,
  cross2D,
  dot2D,
  pointToSegmentDist,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  segmentsIntersect,
} from '../../src/core/math.js';

describe('lerp', () => {
  it('interpolates at 0.5', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('returns a at t=0', () => {
    expect(lerp(3, 7, 0)).toBe(3);
  });

  it('returns b at t=1', () => {
    expect(lerp(3, 7, 1)).toBe(7);
  });

  it('extrapolates beyond [0, 1]', () => {
    expect(lerp(0, 10, 2)).toBe(20);
  });
});

describe('inverseLerp', () => {
  it('is inverse of lerp', () => {
    expect(inverseLerp(0, 10, 5)).toBe(0.5);
  });

  it('returns 0 when a === b', () => {
    expect(inverseLerp(5, 5, 5)).toBe(0);
  });

  it('returns 0 at a', () => {
    expect(inverseLerp(2, 8, 2)).toBe(0);
  });

  it('returns 1 at b', () => {
    expect(inverseLerp(2, 8, 8)).toBe(1);
  });
});

describe('smoothstep', () => {
  it('returns 0 at edge0', () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
  });

  it('returns 1 at edge1', () => {
    expect(smoothstep(0, 1, 1)).toBe(1);
  });

  it('returns 0.5 at midpoint', () => {
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
  });

  it('returns 0 below edge0', () => {
    expect(smoothstep(2, 5, 1)).toBe(0);
  });

  it('returns 1 above edge1', () => {
    expect(smoothstep(2, 5, 6)).toBe(1);
  });

  it('is monotonically increasing', () => {
    let prev = 0;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = smoothstep(0, 1, t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-10);
      prev = v;
    }
  });
});

describe('clamp', () => {
  it('returns value when in range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to min', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('clamps to max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('works when value equals bounds', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('distance2D', () => {
  it('computes 3-4-5 triangle', () => {
    expect(distance2D(0, 0, 3, 4)).toBe(5);
  });

  it('returns 0 for same point', () => {
    expect(distance2D(5, 5, 5, 5)).toBe(0);
  });

  it('is commutative', () => {
    expect(distance2D(1, 2, 4, 6)).toBe(distance2D(4, 6, 1, 2));
  });
});

describe('normalize2D', () => {
  it('normalizes to unit length', () => {
    const { x, z } = normalize2D(3, 4);
    const len = Math.sqrt(x * x + z * z);
    expect(len).toBeCloseTo(1, 10);
  });

  it('returns zero vector for zero input', () => {
    const { x, z } = normalize2D(0, 0);
    expect(x).toBe(0);
    expect(z).toBe(0);
  });

  it('preserves direction', () => {
    const { x, z } = normalize2D(3, 4);
    expect(x).toBeCloseTo(0.6, 10);
    expect(z).toBeCloseTo(0.8, 10);
  });
});

describe('cross2D', () => {
  it('returns positive for CCW rotation', () => {
    // (1,0) x (0,1) = 1 (CCW)
    expect(cross2D(1, 0, 0, 1)).toBe(1);
  });

  it('returns negative for CW rotation', () => {
    // (0,1) x (1,0) = -1 (CW)
    expect(cross2D(0, 1, 1, 0)).toBe(-1);
  });

  it('returns 0 for parallel vectors', () => {
    expect(cross2D(2, 3, 4, 6)).toBe(0);
  });
});

describe('dot2D', () => {
  it('computes dot product', () => {
    expect(dot2D(1, 0, 0, 1)).toBe(0); // perpendicular
    expect(dot2D(1, 0, 1, 0)).toBe(1); // parallel
    expect(dot2D(2, 3, 4, 5)).toBe(23);
  });
});

describe('pointToSegmentDist', () => {
  it('returns 0 for point on segment', () => {
    // Point (5, 0) on segment (0,0)-(10,0)
    expect(pointToSegmentDist(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 10);
  });

  it('returns perpendicular distance for point off segment middle', () => {
    // Point (5, 3) from segment (0,0)-(10,0) => distance 3
    expect(pointToSegmentDist(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 10);
  });

  it('returns distance to nearest endpoint when projection falls outside', () => {
    // Point (15, 0) from segment (0,0)-(10,0) => distance 5
    expect(pointToSegmentDist(15, 0, 0, 0, 10, 0)).toBeCloseTo(5, 10);
  });

  it('handles degenerate segment (point)', () => {
    expect(pointToSegmentDist(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 10);
  });
});

describe('pointInPolygon', () => {
  // Unit square: (0,0), (1,0), (1,1), (0,1) - CCW
  const square = [
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { x: 1, z: 1 },
    { x: 0, z: 1 },
  ];

  it('returns true for point inside', () => {
    expect(pointInPolygon(0.5, 0.5, square)).toBe(true);
  });

  it('returns false for point outside', () => {
    expect(pointInPolygon(2, 2, square)).toBe(false);
    expect(pointInPolygon(-1, 0.5, square)).toBe(false);
  });

  it('returns true for point near center', () => {
    expect(pointInPolygon(0.25, 0.75, square)).toBe(true);
  });

  it('handles concave polygon', () => {
    // L-shaped polygon
    const lShape = [
      { x: 0, z: 0 },
      { x: 2, z: 0 },
      { x: 2, z: 1 },
      { x: 1, z: 1 },
      { x: 1, z: 2 },
      { x: 0, z: 2 },
    ];
    expect(pointInPolygon(0.5, 0.5, lShape)).toBe(true);  // inside bottom
    expect(pointInPolygon(0.5, 1.5, lShape)).toBe(true);  // inside left arm
    expect(pointInPolygon(1.5, 1.5, lShape)).toBe(false); // outside (the cutout)
  });
});

describe('polygonArea', () => {
  it('returns 1 for CCW unit square', () => {
    const square = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 1, z: 1 },
      { x: 0, z: 1 },
    ];
    expect(polygonArea(square)).toBeCloseTo(1, 10);
  });

  it('returns negative for CW winding', () => {
    const cwSquare = [
      { x: 0, z: 0 },
      { x: 0, z: 1 },
      { x: 1, z: 1 },
      { x: 1, z: 0 },
    ];
    expect(polygonArea(cwSquare)).toBeCloseTo(-1, 10);
  });

  it('handles triangle', () => {
    const tri = [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 0, z: 3 },
    ];
    expect(polygonArea(tri)).toBeCloseTo(6, 10);
  });
});

describe('polygonCentroid', () => {
  it('returns center of unit square', () => {
    const square = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 1, z: 1 },
      { x: 0, z: 1 },
    ];
    const c = polygonCentroid(square);
    expect(c.x).toBeCloseTo(0.5, 10);
    expect(c.z).toBeCloseTo(0.5, 10);
  });

  it('returns centroid of triangle', () => {
    const tri = [
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 0, z: 3 },
    ];
    const c = polygonCentroid(tri);
    expect(c.x).toBeCloseTo(1, 10);
    expect(c.z).toBeCloseTo(1, 10);
  });
});

describe('segmentsIntersect', () => {
  it('returns intersection for crossing segments', () => {
    const result = segmentsIntersect(
      { x: 0, z: 0 }, { x: 2, z: 2 },
      { x: 0, z: 2 }, { x: 2, z: 0 }
    );
    expect(result).not.toBeNull();
    expect(result.x).toBeCloseTo(1, 10);
    expect(result.z).toBeCloseTo(1, 10);
  });

  it('returns null for parallel segments', () => {
    const result = segmentsIntersect(
      { x: 0, z: 0 }, { x: 1, z: 0 },
      { x: 0, z: 1 }, { x: 1, z: 1 }
    );
    expect(result).toBeNull();
  });

  it('returns null for non-intersecting segments', () => {
    const result = segmentsIntersect(
      { x: 0, z: 0 }, { x: 1, z: 0 },
      { x: 2, z: 1 }, { x: 3, z: 1 }
    );
    expect(result).toBeNull();
  });

  it('handles T-intersection at endpoint', () => {
    const result = segmentsIntersect(
      { x: 0, z: 0 }, { x: 2, z: 0 },
      { x: 1, z: -1 }, { x: 1, z: 1 }
    );
    expect(result).not.toBeNull();
    expect(result.x).toBeCloseTo(1, 10);
    expect(result.z).toBeCloseTo(0, 10);
  });

  it('returns null for collinear non-overlapping segments', () => {
    const result = segmentsIntersect(
      { x: 0, z: 0 }, { x: 1, z: 0 },
      { x: 2, z: 0 }, { x: 3, z: 0 }
    );
    expect(result).toBeNull();
  });
});
