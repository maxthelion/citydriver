import { describe, it, expect } from 'vitest';
import {
  lerp, inverseLerp, smoothstep, clamp, distance2D,
  normalize2D, cross2D, dot2D, pointToSegmentDist,
  pointInPolygon, polygonArea, polygonCentroid, segmentsIntersect, remap,
} from '../../src/core/math.js';

describe('math utilities', () => {
  it('lerp interpolates', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });

  it('inverseLerp', () => {
    expect(inverseLerp(0, 10, 5)).toBe(0.5);
    expect(inverseLerp(5, 5, 5)).toBe(0);
  });

  it('smoothstep', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('distance2D', () => {
    expect(distance2D(0, 0, 3, 4)).toBe(5);
    expect(distance2D(1, 1, 1, 1)).toBe(0);
  });

  it('normalize2D', () => {
    const n = normalize2D(3, 4);
    expect(n.x).toBeCloseTo(0.6);
    expect(n.z).toBeCloseTo(0.8);

    const zero = normalize2D(0, 0);
    expect(zero.x).toBe(0);
    expect(zero.z).toBe(0);
  });

  it('cross2D', () => {
    expect(cross2D(1, 0, 0, 1)).toBe(1);
    expect(cross2D(0, 1, 1, 0)).toBe(-1);
  });

  it('dot2D', () => {
    expect(dot2D(1, 0, 0, 1)).toBe(0);
    expect(dot2D(1, 2, 3, 4)).toBe(11);
  });

  it('pointToSegmentDist', () => {
    expect(pointToSegmentDist(0, 1, 0, 0, 10, 0)).toBeCloseTo(1);
    expect(pointToSegmentDist(5, 0, 0, 0, 10, 0)).toBeCloseTo(0);
    // Degenerate segment
    expect(pointToSegmentDist(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });

  it('pointInPolygon', () => {
    const square = [
      { x: 0, z: 0 }, { x: 10, z: 0 },
      { x: 10, z: 10 }, { x: 0, z: 10 },
    ];
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
  });

  it('polygonArea', () => {
    const square = [
      { x: 0, z: 0 }, { x: 10, z: 0 },
      { x: 10, z: 10 }, { x: 0, z: 10 },
    ];
    // CCW winding gives positive area
    expect(Math.abs(polygonArea(square))).toBeCloseTo(100);
  });

  it('polygonCentroid', () => {
    const square = [
      { x: 0, z: 0 }, { x: 10, z: 0 },
      { x: 10, z: 10 }, { x: 0, z: 10 },
    ];
    const c = polygonCentroid(square);
    expect(c.x).toBeCloseTo(5);
    expect(c.z).toBeCloseTo(5);
  });

  it('segmentsIntersect detects intersection', () => {
    const result = segmentsIntersect(
      { x: 0, z: 0 }, { x: 10, z: 10 },
      { x: 0, z: 10 }, { x: 10, z: 0 },
    );
    expect(result).not.toBeNull();
    expect(result.x).toBeCloseTo(5);
    expect(result.z).toBeCloseTo(5);
  });

  it('segmentsIntersect returns null for parallel', () => {
    const result = segmentsIntersect(
      { x: 0, z: 0 }, { x: 10, z: 0 },
      { x: 0, z: 5 }, { x: 10, z: 5 },
    );
    expect(result).toBeNull();
  });

  it('remap', () => {
    expect(remap(5, 0, 10, 0, 100)).toBe(50);
    expect(remap(0, 0, 10, 20, 40)).toBe(20);
  });
});
