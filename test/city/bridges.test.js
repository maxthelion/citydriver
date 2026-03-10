import { describe, it, expect } from 'vitest';
import { FeatureMap } from '../../src/core/FeatureMap.js';
import { Grid2D } from '../../src/core/Grid2D.js';
import {
  placeBridges,
  findRoadWaterCrossings,
  findBridgeBanks,
  nearestRiverSegment,
} from '../../src/city/bridges.js';

/**
 * Create a test map with flat terrain, a horizontal river, and a vertical skeleton road.
 */
function makeTestMap(options = {}) {
  const {
    width = 100,
    height = 100,
    cellSize = 10,
    riverMinZ = 48,
    riverMaxZ = 52,
    roads = true,
  } = options;

  const map = new FeatureMap(width, height, cellSize);

  // Flat elevation + zero slope
  map.elevation = new Grid2D(width, height, { type: 'float32', fill: 10 });
  map.slope = new Grid2D(width, height, { type: 'float32', fill: 0 });

  // Add a horizontal river (polyline with width)
  const riverPolyline = [
    { x: 0, z: (riverMinZ + riverMaxZ) / 2 * cellSize, width: (riverMaxZ - riverMinZ) * cellSize, accumulation: 100 },
    { x: width * cellSize, z: (riverMinZ + riverMaxZ) / 2 * cellSize, width: (riverMaxZ - riverMinZ) * cellSize, accumulation: 100 },
  ];
  map.addFeature('river', { polyline: riverPolyline });

  // Stamp the river band onto waterMask manually for precise control
  for (let gz = riverMinZ; gz <= riverMaxZ; gz++) {
    for (let gx = 0; gx < width; gx++) {
      map.waterMask.set(gx, gz, 1);
      map.buildability.set(gx, gz, 0);
    }
  }

  // Recompute buildability for non-water cells
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) === 0) {
        map.buildability.set(gx, gz, 1.0);
      }
    }
  }

  if (roads) {
    // Add a vertical skeleton road crossing the river at x=50
    const roadPolyline = [
      { x: 50 * cellSize, z: 10 * cellSize },
      { x: 50 * cellSize, z: 90 * cellSize },
    ];
    map.addFeature('road', {
      polyline: roadPolyline,
      width: 10,
      hierarchy: 'arterial',
      importance: 0.9,
      source: 'skeleton',
    });
  }

  return map;
}

describe('bridges', () => {
  describe('findRoadWaterCrossings', () => {
    it('detects a crossing where road meets water', () => {
      const map = makeTestMap();
      const crossings = findRoadWaterCrossings(map);

      expect(crossings.length).toBe(1);
      expect(crossings[0].widthCells).toBeGreaterThan(0);
      // Midpoint should be near the river center
      const expectedMidZ = 50 * map.cellSize;
      expect(Math.abs(crossings[0].midZ - expectedMidZ)).toBeLessThan(10 * map.cellSize);
    });
  });

  describe('nearestRiverSegment', () => {
    it('finds the river and returns a horizontal tangent', () => {
      const map = makeTestMap({ roads: false });
      const result = nearestRiverSegment(map, 500, 500);

      expect(result).not.toBeNull();
      expect(result.riverIndex).toBe(0);
      // Horizontal river: tangent should be roughly (1, 0) or (-1, 0)
      expect(Math.abs(result.tangentX)).toBeCloseTo(1, 1);
      expect(Math.abs(result.tangentZ)).toBeCloseTo(0, 1);
    });
  });

  describe('findBridgeBanks', () => {
    it('finds banks on both sides of horizontal river', () => {
      const map = makeTestMap({ roads: false });
      const midX = 50 * map.cellSize;
      const midZ = 50 * map.cellSize;
      // Perpendicular to horizontal river = vertical direction
      const banks = findBridgeBanks(map, midX, midZ, 0, 1);

      expect(banks).not.toBeNull();
      // bankA should be south of river, bankB north
      expect(banks.bankA.z).toBeGreaterThan(midZ);
      expect(banks.bankB.z).toBeLessThan(midZ);
    });

    it('returns null for very wide crossings (>50 cells from midpoint)', () => {
      // Water spans z=0 to z=99 — bank search of 50 cells from midpoint won't reach land
      const map = makeTestMap({ riverMinZ: 0, riverMaxZ: 99, roads: false });
      const midX = 50 * map.cellSize;
      const midZ = 50 * map.cellSize;
      const banks = findBridgeBanks(map, midX, midZ, 0, 1);

      expect(banks).toBeNull();
    });
  });

  describe('placeBridges', () => {
    it('splices a perpendicular bridge into the triggering road', () => {
      const map = makeTestMap();
      const roadsBefore = map.roads.length;
      const road = map.roads.find(r => r.source === 'skeleton');
      const originalPolylineLength = road.polyline.length;

      const result = placeBridges(map);

      expect(result.placed).toBe(1);
      // No new road features created — bridge is spliced into existing road
      expect(map.roads.length).toBe(roadsBefore);
      // The road's polyline should now have more points than the original 2
      expect(road.polyline.length).toBeGreaterThan(originalPolylineLength);
      // Some mid-polyline points should be near the river crossing zone (z ~ 500)
      const riverCenterZ = 50 * map.cellSize;
      const midPoints = road.polyline.slice(1, -1);
      const nearRiver = midPoints.some(
        p => Math.abs(p.z - riverCenterZ) < 15 * map.cellSize
      );
      expect(nearRiver).toBe(true);
    });

    it('enforces minimum spacing — two parallel roads 15 cells apart', () => {
      const map = makeTestMap({ roads: false });

      // Two vertical roads 15 cells apart (< MIN_BRIDGE_SPACING of 25)
      for (const roadX of [45, 55]) {
        map.addFeature('road', {
          polyline: [
            { x: roadX * map.cellSize, z: 10 * map.cellSize },
            { x: roadX * map.cellSize, z: 90 * map.cellSize },
          ],
          width: 10,
          hierarchy: 'arterial',
          importance: 0.9,
          source: 'skeleton',
        });
      }

      const result = placeBridges(map);

      // Only one bridge should be placed (second rejected by spacing)
      expect(result.placed).toBe(1);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    });

    it('splices multiple bridges for road crossing two rivers', () => {
      const width = 100, height = 100, cellSize = 10;
      const map = new FeatureMap(width, height, cellSize);

      map.elevation = new Grid2D(width, height, { type: 'float32', fill: 10 });
      map.slope = new Grid2D(width, height, { type: 'float32', fill: 0 });

      // River 1 at z=20-25
      map.addFeature('river', {
        polyline: [
          { x: 0, z: 22.5 * cellSize, width: 5 * cellSize, accumulation: 50 },
          { x: width * cellSize, z: 22.5 * cellSize, width: 5 * cellSize, accumulation: 50 },
        ],
      });
      for (let gz = 20; gz <= 25; gz++) {
        for (let gx = 0; gx < width; gx++) {
          map.waterMask.set(gx, gz, 1);
          map.buildability.set(gx, gz, 0);
        }
      }

      // River 2 at z=70-75
      map.addFeature('river', {
        polyline: [
          { x: 0, z: 72.5 * cellSize, width: 5 * cellSize, accumulation: 50 },
          { x: width * cellSize, z: 72.5 * cellSize, width: 5 * cellSize, accumulation: 50 },
        ],
      });
      for (let gz = 70; gz <= 75; gz++) {
        for (let gx = 0; gx < width; gx++) {
          map.waterMask.set(gx, gz, 1);
          map.buildability.set(gx, gz, 0);
        }
      }

      // Set buildability for non-water
      for (let gz = 0; gz < height; gz++) {
        for (let gx = 0; gx < width; gx++) {
          if (map.waterMask.get(gx, gz) === 0) {
            map.buildability.set(gx, gz, 1.0);
          }
        }
      }

      // One road crossing both rivers at x=50
      map.addFeature('road', {
        polyline: [
          { x: 50 * cellSize, z: 5 * cellSize },
          { x: 50 * cellSize, z: 95 * cellSize },
        ],
        width: 10,
        hierarchy: 'arterial',
        importance: 0.9,
        source: 'skeleton',
      });

      const result = placeBridges(map);

      // Both rivers should get a bridge
      expect(result.placed).toBe(2);
      // Still only 1 skeleton road (both bridges spliced into it)
      const skeletonRoads = map.roads.filter(r => r.source === 'skeleton');
      expect(skeletonRoads.length).toBe(1);
      // Road polyline should have grown from the original 2 points
      expect(skeletonRoads[0].polyline.length).toBeGreaterThan(2);
    });
  });
});
