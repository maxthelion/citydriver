import { describe, it, expect } from 'vitest';
import { clipPolylineToBounds } from '../../src/core/clipPolyline.js';

describe('clipPolylineToBounds', () => {
  const bounds = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };

  it('clips polyline crossing full bounds to boundary intersections', () => {
    // Horizontal line from outside-left to outside-right at z=5
    const polyline = [
      { x: -5, z: 5 },
      { x: 15, z: 5 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    expect(result.clipped.length).toBe(2);
    expect(result.clipped[0].x).toBeCloseTo(0);
    expect(result.clipped[0].z).toBeCloseTo(5);
    expect(result.clipped[1].x).toBeCloseTo(10);
    expect(result.clipped[1].z).toBeCloseTo(5);
    expect(result.entryDir).not.toBeNull();
    expect(result.entryDir.x).toBeCloseTo(1);
    expect(result.entryDir.z).toBeCloseTo(0);
    expect(result.exitDir).not.toBeNull();
    expect(result.exitDir.x).toBeCloseTo(1);
    expect(result.exitDir.z).toBeCloseTo(0);
  });

  it('preserves interior points', () => {
    // 4-point polyline: starts outside, 2 interior points, ends outside
    const polyline = [
      { x: -5, z: 5 },
      { x: 3, z: 5 },
      { x: 7, z: 5 },
      { x: 15, z: 5 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    // entry crossing + 2 interior + exit crossing = 4 points
    expect(result.clipped.length).toBe(4);
    expect(result.clipped[0].x).toBeCloseTo(0);
    expect(result.clipped[0].z).toBeCloseTo(5);
    expect(result.clipped[1].x).toBeCloseTo(3);
    expect(result.clipped[1].z).toBeCloseTo(5);
    expect(result.clipped[2].x).toBeCloseTo(7);
    expect(result.clipped[2].z).toBeCloseTo(5);
    expect(result.clipped[3].x).toBeCloseTo(10);
    expect(result.clipped[3].z).toBeCloseTo(5);
  });

  it('handles polyline starting inside bounds', () => {
    // Starts inside, exits through right boundary
    const polyline = [
      { x: 5, z: 5 },
      { x: 15, z: 5 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    expect(result.entryDir).toBeNull();
    expect(result.exitDir).not.toBeNull();
    expect(result.clipped.length).toBe(2);
    expect(result.clipped[0].x).toBeCloseTo(5);
    expect(result.clipped[0].z).toBeCloseTo(5);
    expect(result.clipped[1].x).toBeCloseTo(10);
    expect(result.clipped[1].z).toBeCloseTo(5);
  });

  it('handles polyline ending inside bounds', () => {
    // Enters through left boundary, ends inside
    const polyline = [
      { x: -5, z: 5 },
      { x: 5, z: 5 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    expect(result.entryDir).not.toBeNull();
    expect(result.exitDir).toBeNull();
    expect(result.clipped.length).toBe(2);
    expect(result.clipped[0].x).toBeCloseTo(0);
    expect(result.clipped[0].z).toBeCloseTo(5);
    expect(result.clipped[1].x).toBeCloseTo(5);
    expect(result.clipped[1].z).toBeCloseTo(5);
  });

  it('handles polyline fully inside bounds', () => {
    const polyline = [
      { x: 2, z: 3 },
      { x: 5, z: 5 },
      { x: 8, z: 7 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    expect(result.entryDir).toBeNull();
    expect(result.exitDir).toBeNull();
    expect(result.clipped.length).toBe(3);
    expect(result.clipped[0].x).toBeCloseTo(2);
    expect(result.clipped[0].z).toBeCloseTo(3);
    expect(result.clipped[2].x).toBeCloseTo(8);
    expect(result.clipped[2].z).toBeCloseTo(7);
  });

  it('returns null for polyline fully outside bounds', () => {
    const polyline = [
      { x: -10, z: -5 },
      { x: -5, z: -5 },
      { x: -2, z: -5 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).toBeNull();
  });

  it('provides correct entry direction for diagonal crossing', () => {
    // Diagonal from bottom-left outside to top-right outside
    const polyline = [
      { x: -5, z: -5 },
      { x: 15, z: 15 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    // Entry direction should be normalized (1,1) direction
    const invSqrt2 = 1 / Math.sqrt(2);
    expect(result.entryDir.x).toBeCloseTo(invSqrt2);
    expect(result.entryDir.z).toBeCloseTo(invSqrt2);
    expect(result.exitDir.x).toBeCloseTo(invSqrt2);
    expect(result.exitDir.z).toBeCloseTo(invSqrt2);
  });

  it('interpolates extra properties at boundary crossings', () => {
    // Polyline with accumulation property, crossing from outside to inside
    const polyline = [
      { x: -10, z: 5, accumulation: 100 },
      { x: 10, z: 5, accumulation: 200 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    // Entry at x=0: t = 10/20 = 0.5, so accumulation = lerp(100, 200, 0.5) = 150
    expect(result.clipped[0].accumulation).toBeCloseTo(150);
    // Exit at x=10: t = 20/20 = 1.0, so accumulation = 200
    expect(result.clipped[1].accumulation).toBeCloseTo(200);
  });
});
