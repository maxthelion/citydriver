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
    it('places a bridge across horizontal river', () => {
      const map = makeTestMap();
      const roadsBefore = map.roads.length;

      const result = placeBridges(map);

      expect(result.placed).toBe(1);
      // A new road feature with bridge=true should exist
      const bridgeRoads = map.roads.filter(r => r.bridge === true);
      expect(bridgeRoads.length).toBeGreaterThanOrEqual(1);

      // Bridge polyline should be roughly perpendicular to river (vertical)
      const bridge = bridgeRoads[0];
      const dx = Math.abs(bridge.polyline[1].x - bridge.polyline[0].x);
      const dz = Math.abs(bridge.polyline[1].z - bridge.polyline[0].z);
      // For horizontal river, bridge should be mostly vertical (dz >> dx)
      expect(dz).toBeGreaterThan(dx);
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

    it('allows bridges on different rivers', () => {
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
    });

    it('creates landing spur when bank is far from road network', () => {
      // A diagonal skeleton road crosses the river, but the perpendicular bridge
      // banks land far from the diagonal road's stamped cells — needs a spur.
      const width = 100, height = 100, cellSize = 10;
      const map = new FeatureMap(width, height, cellSize);

      map.elevation = new Grid2D(width, height, { type: 'float32', fill: 10 });
      map.slope = new Grid2D(width, height, { type: 'float32', fill: 0 });

      // River at z=48-52
      map.addFeature('river', {
        polyline: [
          { x: 0, z: 50 * cellSize, width: 4 * cellSize, accumulation: 100 },
          { x: width * cellSize, z: 50 * cellSize, width: 4 * cellSize, accumulation: 100 },
        ],
      });
      for (let gz = 48; gz <= 52; gz++) {
        for (let gx = 0; gx < width; gx++) {
          map.waterMask.set(gx, gz, 1);
          map.buildability.set(gx, gz, 0);
        }
      }
      for (let gz = 0; gz < height; gz++) {
        for (let gx = 0; gx < width; gx++) {
          if (map.waterMask.get(gx, gz) === 0) {
            map.buildability.set(gx, gz, 1.0);
          }
        }
      }

      // A steep diagonal road that crosses the river
      // Goes from (20, 10) to (80, 90) — crosses at roughly x=50
      map.addFeature('road', {
        polyline: [
          { x: 20 * cellSize, z: 10 * cellSize },
          { x: 80 * cellSize, z: 90 * cellSize },
        ],
        width: 10,
        hierarchy: 'arterial',
        importance: 0.9,
        source: 'skeleton',
      });

      const result = placeBridges(map);

      // Bridge should be placed
      expect(result.placed).toBeGreaterThanOrEqual(1);

      const bridgeRoads = map.roads.filter(r => r.bridge === true);
      expect(bridgeRoads.length).toBeGreaterThanOrEqual(1);
    });
  });
});
