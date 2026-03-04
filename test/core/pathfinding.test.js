import { describe, it, expect } from 'vitest';
import {
  findPath,
  terrainCostFunction,
  simplifyPath,
  smoothPath,
  findWorldPath,
} from '../../src/core/pathfinding.js';

// ---------------------------------------------------------------------------
// Test grid helper
// ---------------------------------------------------------------------------

function createTestGrid(width, height, elevationFn) {
  return {
    width,
    height,
    get(gx, gz) {
      gx = Math.max(0, Math.min(width - 1, gx));
      gz = Math.max(0, Math.min(height - 1, gz));
      return elevationFn(gx, gz);
    },
    worldToGrid(x, z) { return { gx: x, gz: z }; },
    cellSize: 1,
  };
}

/**
 * Simple flat cost function: uniform cost = distance (1 or sqrt(2)).
 */
function flatCostFn(fromGx, fromGz, toGx, toGz) {
  const dx = toGx - fromGx;
  const dz = toGz - fromGz;
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pathfinding', () => {
  // 1. Straight path on flat terrain
  describe('straight path on flat terrain', () => {
    it('should find a roughly straight path along z=0 on a flat grid', () => {
      const result = findPath(0, 0, 9, 0, 10, 10, flatCostFn);
      expect(result).not.toBeNull();
      expect(result.path.length).toBeGreaterThanOrEqual(2);

      // All points should be near z=0 (within 1 cell tolerance)
      for (const p of result.path) {
        expect(p.gz).toBeLessThanOrEqual(1);
        expect(p.gz).toBeGreaterThanOrEqual(-1);
      }

      // Start and end match
      expect(result.path[0]).toEqual({ gx: 0, gz: 0 });
      expect(result.path[result.path.length - 1]).toEqual({ gx: 9, gz: 0 });
    });
  });

  // 2. Path avoids obstacle
  describe('path avoids obstacle', () => {
    it('should route through a gap in a wall of impassable cells', () => {
      const wallZ = 5;
      const gapX = 5;

      function wallCostFn(fromGx, fromGz, toGx, toGz) {
        // Wall across z=5, except at x=5
        if (toGz === wallZ && toGx !== gapX) return Infinity;
        const dx = toGx - fromGx;
        const dz = toGz - fromGz;
        return Math.sqrt(dx * dx + dz * dz);
      }

      const result = findPath(0, 0, 0, 9, 10, 10, wallCostFn);
      expect(result).not.toBeNull();

      // The path must pass through the gap
      const crossesWall = result.path.some(p => p.gz === wallZ);
      expect(crossesWall).toBe(true);

      const wallCrossings = result.path.filter(p => p.gz === wallZ);
      for (const p of wallCrossings) {
        // Must cross at or near the gap
        expect(Math.abs(p.gx - gapX)).toBeLessThanOrEqual(1);
      }
    });
  });

  // 3. Path prefers flat terrain (avoids hill)
  describe('path prefers flat terrain', () => {
    it('should go around a hill when slope penalty is high', () => {
      // Grid with a hill centered at (10,10) with radius ~5
      const grid = createTestGrid(20, 20, (gx, gz) => {
        const dx = gx - 10;
        const dz = gz - 10;
        const distSq = dx * dx + dz * dz;
        if (distSq < 25) return 20 * (1 - distSq / 25); // Hill up to height 20
        return 0;
      });

      const costFn = terrainCostFunction(grid, {
        slopePenalty: 20,
        edgeMargin: 0,
        edgePenalty: 0,
      });

      const result = findPath(0, 10, 19, 10, grid.width, grid.height, costFn);
      expect(result).not.toBeNull();

      // Path should mostly avoid the hill center (10,10)
      // Check that the path goes around rather than straight through
      const directPathThrough = result.path.some(
        p => Math.abs(p.gx - 10) <= 2 && Math.abs(p.gz - 10) <= 2,
      );

      // With a high enough slope penalty, the path should avoid the peak
      const peakVisit = result.path.some(
        p => p.gx === 10 && p.gz === 10,
      );
      expect(peakVisit).toBe(false);
    });
  });

  // 4. No path returns null
  describe('no path returns null', () => {
    it('should return null when start and goal are separated by impassable wall', () => {
      function blockedCostFn(fromGx, fromGz, toGx, toGz) {
        // Complete wall at z=5
        if (toGz === 5) return Infinity;
        const dx = toGx - fromGx;
        const dz = toGz - fromGz;
        return Math.sqrt(dx * dx + dz * dz);
      }

      const result = findPath(5, 0, 5, 9, 10, 10, blockedCostFn);
      expect(result).toBeNull();
    });
  });

  // 5. Start equals goal
  describe('start equals goal', () => {
    it('should return a path with a single point when start equals goal', () => {
      const result = findPath(5, 5, 5, 5, 10, 10, flatCostFn);
      expect(result).not.toBeNull();
      expect(result.path).toEqual([{ gx: 5, gz: 5 }]);
      expect(result.cost).toBe(0);
    });
  });

  // 6. Path includes start and goal
  describe('path includes start and goal', () => {
    it('should have start as first element and goal as last element', () => {
      const result = findPath(1, 2, 8, 7, 10, 10, flatCostFn);
      expect(result).not.toBeNull();
      expect(result.path[0]).toEqual({ gx: 1, gz: 2 });
      expect(result.path[result.path.length - 1]).toEqual({ gx: 8, gz: 7 });
    });
  });

  // 7. simplifyPath - straight line
  describe('simplifyPath - straight line', () => {
    it('should simplify collinear points to just endpoints', () => {
      const path = [];
      for (let i = 0; i <= 10; i++) {
        path.push({ gx: i, gz: 0 });
      }

      const simplified = simplifyPath(path, 0.5);
      expect(simplified.length).toBe(2);
      expect(simplified[0]).toEqual({ gx: 0, gz: 0 });
      expect(simplified[1]).toEqual({ gx: 10, gz: 0 });
    });
  });

  // 8. simplifyPath - L-shape preserved
  describe('simplifyPath - L-shape preserved', () => {
    it('should preserve the corner of an L-shaped path', () => {
      const path = [
        { gx: 0, gz: 0 },
        { gx: 1, gz: 0 },
        { gx: 2, gz: 0 },
        { gx: 3, gz: 0 },
        { gx: 4, gz: 0 },
        { gx: 5, gz: 0 },
        { gx: 5, gz: 1 },
        { gx: 5, gz: 2 },
        { gx: 5, gz: 3 },
        { gx: 5, gz: 4 },
        { gx: 5, gz: 5 },
      ];

      const simplified = simplifyPath(path, 0.5);
      // Should have at least 3 points: start, corner, end
      expect(simplified.length).toBeGreaterThanOrEqual(3);

      // Corner near (5,0) should be preserved
      const hasCorner = simplified.some(
        p => p.gx === 5 && p.gz === 0,
      );
      expect(hasCorner).toBe(true);

      // Endpoints preserved
      expect(simplified[0]).toEqual({ gx: 0, gz: 0 });
      expect(simplified[simplified.length - 1]).toEqual({ gx: 5, gz: 5 });
    });
  });

  // 9. smoothPath - preserves endpoints
  describe('smoothPath - preserves endpoints', () => {
    it('should preserve the first and last world-coordinate points', () => {
      const path = [
        { gx: 0, gz: 0 },
        { gx: 5, gz: 3 },
        { gx: 10, gz: 10 },
      ];

      const cellSize = 2;
      const smoothed = smoothPath(path, cellSize, 3);

      expect(smoothed.length).toBeGreaterThan(0);
      expect(smoothed[0]).toEqual({ x: 0 * cellSize, z: 0 * cellSize });
      expect(smoothed[smoothed.length - 1]).toEqual({ x: 10 * cellSize, z: 10 * cellSize });
    });
  });

  // 10. terrainCostFunction - water penalty
  describe('terrainCostFunction - water penalty', () => {
    it('should avoid water cells when an alternative exists', () => {
      const grid = createTestGrid(10, 10, () => 0);

      // Water across z=5, except at x=0
      const waterCells = new Set();
      for (let x = 1; x < 10; x++) {
        waterCells.add(5 * 10 + x);
      }

      const costFn = terrainCostFunction(grid, {
        waterCells,
        waterPenalty: 100,
        slopePenalty: 0,
        edgeMargin: 0,
        edgePenalty: 0,
      });

      const result = findPath(5, 0, 5, 9, grid.width, grid.height, costFn);
      expect(result).not.toBeNull();

      // Path should avoid water by going through x=0 gap
      const waterHits = result.path.filter(p => {
        const key = p.gz * 10 + p.gx;
        return waterCells.has(key);
      });
      expect(waterHits.length).toBe(0);
    });

    it('should cross water when there is no alternative', () => {
      const grid = createTestGrid(10, 10, () => 0);

      // Water across entire z=5
      const waterCells = new Set();
      for (let x = 0; x < 10; x++) {
        waterCells.add(5 * 10 + x);
      }

      const costFn = terrainCostFunction(grid, {
        waterCells,
        waterPenalty: 100,
        slopePenalty: 0,
        edgeMargin: 0,
        edgePenalty: 0,
      });

      const result = findPath(5, 0, 5, 9, grid.width, grid.height, costFn);
      expect(result).not.toBeNull();

      // Must cross water since there is no alternative
      const crossesWater = result.path.some(p => {
        const key = p.gz * 10 + p.gx;
        return waterCells.has(key);
      });
      expect(crossesWater).toBe(true);
    });
  });

  // 11. Diagonal movement
  describe('diagonal movement', () => {
    it('should use diagonal moves on a flat grid, resulting in fewer than 10 steps', () => {
      const result = findPath(0, 0, 5, 5, 10, 10, flatCostFn);
      expect(result).not.toBeNull();

      // Straight diagonal: 5 diagonal moves = 6 points (including start and goal)
      // Without diagonals it would be 11 points (5 in x + 5 in z + start)
      expect(result.path.length).toBeLessThan(10);

      // Cost should be approximately 5 * sqrt(2) = ~7.07
      expect(result.cost).toBeCloseTo(5 * Math.SQRT2, 1);
    });
  });

  // 12. Large grid performance
  describe('large grid performance', () => {
    it('should complete a 200x200 path in under 1 second', () => {
      const size = 200;
      const grid = createTestGrid(size, size, () => 0);
      const costFn = terrainCostFunction(grid, {
        slopePenalty: 0,
        edgeMargin: 0,
        edgePenalty: 0,
      });

      const start = performance.now();
      const result = findPath(0, 0, size - 1, size - 1, size, size, costFn);
      const elapsed = performance.now() - start;

      expect(result).not.toBeNull();
      expect(result.path.length).toBeGreaterThan(1);
      expect(result.path[0]).toEqual({ gx: 0, gz: 0 });
      expect(result.path[result.path.length - 1]).toEqual({ gx: size - 1, gz: size - 1 });
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // Bonus: findWorldPath integration
  describe('findWorldPath', () => {
    it('should convert world coordinates and return a valid world-coordinate path', () => {
      const grid = createTestGrid(20, 20, () => 0);

      const result = findWorldPath(0, 0, 10, 10, grid, {
        slopePenalty: 0,
        edgeMargin: 0,
        edgePenalty: 0,
      });

      expect(result).not.toBeNull();
      expect(result.path.length).toBeGreaterThan(1);
      // Since cellSize is 1 and worldToGrid is identity, world coords = grid coords
      expect(result.path[0]).toEqual({ x: 0, z: 0 });
      expect(result.path[result.path.length - 1]).toEqual({ x: 10, z: 10 });
    });
  });
});
