import { describe, it, expect } from 'vitest';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../../src/core/pathfinding.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('pathfinding', () => {
  it('finds path on flat grid', () => {
    const costFn = () => 1;
    const result = findPath(0, 0, 4, 4, 5, 5, costFn);
    expect(result).not.toBeNull();
    expect(result.path[0]).toEqual({ gx: 0, gz: 0 });
    expect(result.path[result.path.length - 1]).toEqual({ gx: 4, gz: 4 });
  });

  it('returns null for blocked path', () => {
    const costFn = (fx, fz, tx, tz) => {
      if (tx === 2) return Infinity;
      return 1;
    };
    // 5x5 grid with column 2 blocked
    const result = findPath(0, 2, 4, 2, 5, 5, costFn);
    expect(result).toBeNull();
  });

  it('start equals goal returns single-point path', () => {
    const result = findPath(3, 3, 3, 3, 5, 5, () => 1);
    expect(result.path).toEqual([{ gx: 3, gz: 3 }]);
    expect(result.cost).toBe(0);
  });

  it('terrainCostFunction penalizes slope', () => {
    const elev = new Grid2D(5, 5);
    // Create a steep slope at column 2
    for (let z = 0; z < 5; z++) {
      elev.set(2, z, 100);
    }

    const costFn = terrainCostFunction(elev, { slopePenalty: 100 });

    // Cost crossing the steep slope should be high
    const costFlat = costFn(0, 0, 1, 0);
    const costSteep = costFn(1, 0, 2, 0);
    expect(costSteep).toBeGreaterThan(costFlat * 10);
  });

  it('simplifyPath reduces collinear points', () => {
    const path = [
      { gx: 0, gz: 0 },
      { gx: 1, gz: 0 },
      { gx: 2, gz: 0 },
      { gx: 3, gz: 0 },
    ];
    const simplified = simplifyPath(path, 0.1);
    expect(simplified.length).toBe(2);
    expect(simplified[0]).toEqual({ gx: 0, gz: 0 });
    expect(simplified[1]).toEqual({ gx: 3, gz: 0 });
  });

  it('smoothPath produces world coordinates', () => {
    const path = [
      { gx: 0, gz: 0 },
      { gx: 5, gz: 0 },
      { gx: 5, gz: 5 },
    ];
    const smooth = smoothPath(path, 10, 1);
    // Should start at world (0,0) and end at (50,50)
    expect(smooth[0].x).toBeCloseTo(0);
    expect(smooth[0].z).toBeCloseTo(0);
    expect(smooth[smooth.length - 1].x).toBeCloseTo(50);
    expect(smooth[smooth.length - 1].z).toBeCloseTo(50);
    // Should have more points than original
    expect(smooth.length).toBeGreaterThan(path.length);
  });
});
