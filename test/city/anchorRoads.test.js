import { describe, it, expect } from 'vitest';
import { clipPolylineToBounds } from '../../src/core/clipPolyline.js';
import { setupCity } from '../../src/city/setup.js';
import { buildSkeletonRoads } from '../../src/city/skeleton.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

// ============================================================
// Unit tests: clipPolylineToBounds for anchor road use case
// ============================================================

describe('clipPolylineToBounds for anchor roads', () => {
  const bounds = { minX: 100, minZ: 100, maxX: 500, maxZ: 500 };

  it('clips a line crossing the boundary and returns boundary intersection points', () => {
    // Road enters from the left, exits to the right
    const polyline = [
      { x: 0, z: 300 },
      { x: 200, z: 300 },
      { x: 400, z: 300 },
      { x: 600, z: 300 },
    ];

    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    expect(result.clipped.length).toBeGreaterThanOrEqual(2);

    // First clipped point should be at boundary x=100
    expect(result.clipped[0].x).toBeCloseTo(100, 1);
    expect(result.clipped[0].z).toBeCloseTo(300, 1);

    // Last clipped point should be at boundary x=500
    const last = result.clipped[result.clipped.length - 1];
    expect(last.x).toBeCloseTo(500, 1);
    expect(last.z).toBeCloseTo(300, 1);
  });

  it('preserves entry direction', () => {
    // Road enters from the bottom-left diagonally
    const polyline = [
      { x: 0, z: 0 },
      { x: 200, z: 200 },
      { x: 400, z: 400 },
    ];

    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    expect(result.entryDir).not.toBeNull();

    // Direction should be roughly (1, 1) normalized = (0.707, 0.707)
    expect(result.entryDir.x).toBeCloseTo(Math.SQRT1_2, 1);
    expect(result.entryDir.z).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it('preserves intermediate waypoints inside the boundary', () => {
    // Road with several waypoints inside the bounds
    const polyline = [
      { x: 0, z: 300 },    // outside
      { x: 200, z: 250 },  // inside
      { x: 300, z: 350 },  // inside
      { x: 400, z: 280 },  // inside
      { x: 600, z: 300 },  // outside
    ];

    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();

    // Should include: entry crossing, 3 interior points, exit crossing = 5 points
    expect(result.clipped.length).toBe(5);

    // Interior waypoints should be preserved exactly
    expect(result.clipped[1]).toEqual({ x: 200, z: 250 });
    expect(result.clipped[2]).toEqual({ x: 300, z: 350 });
    expect(result.clipped[3]).toEqual({ x: 400, z: 280 });
  });

  it('handles a road that only enters from one side (one-ended)', () => {
    // Road enters from the left and ends inside the bounds
    const polyline = [
      { x: 0, z: 300 },
      { x: 200, z: 300 },
      { x: 350, z: 300 },
    ];

    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();

    // First point should be at the boundary
    expect(result.clipped[0].x).toBeCloseTo(100, 1);

    // Last point should be interior (not at boundary)
    const last = result.clipped[result.clipped.length - 1];
    expect(last.x).toBeCloseTo(350, 1);

    // Should have entry direction but no exit direction
    expect(result.entryDir).not.toBeNull();
    expect(result.exitDir).toBeNull();
  });

  it('returns null for a road entirely outside the bounds', () => {
    const polyline = [
      { x: 0, z: 0 },
      { x: 50, z: 50 },
    ];

    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).toBeNull();
  });

  it('handles a road entirely inside the bounds', () => {
    const polyline = [
      { x: 200, z: 200 },
      { x: 300, z: 300 },
      { x: 400, z: 400 },
    ];

    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    expect(result.clipped.length).toBe(3);
    // No entry/exit directions since it doesn't cross the boundary
    expect(result.entryDir).toBeNull();
    expect(result.exitDir).toBeNull();
  });
});

// ============================================================
// Integration test: anchor roads reach the city boundary
// ============================================================

describe('anchor roads integration', { timeout: 30000 }, () => {
  it('at least one road endpoint is within 2 cells of the city boundary', { timeout: 15000 }, () => {
    // Try multiple seeds to find one where anchor roads exist
    let foundBoundaryRoad = false;

    for (const seed of [42, 1, 100, 255]) {
      const rng = new SeededRandom(seed);
      const coastEdge = ['north', 'south', 'east', 'west', null][rng.int(0, 4)];
      const layers = generateRegion({
        width: 128, height: 128, cellSize: 50, seaLevel: 0, coastEdge,
      }, rng);

      const settlements = layers.getData('settlements');
      if (!settlements || settlements.length === 0) continue;

      const cityRng = rng.fork('city');
      const map = setupCity(layers, settlements[0], cityRng);

      buildSkeletonRoads(map);

      if (map.ways.length === 0) continue;

      // Check if any road endpoint is near the boundary (within 2 cells worth of world coords)
      const margin = 2 * map.cellSize;
      const minX = map.originX;
      const minZ = map.originZ;
      const maxX = map.originX + map.width * map.cellSize;
      const maxZ = map.originZ + map.height * map.cellSize;

      for (const road of map.ways) {
        if (!road.polyline || road.polyline.length < 2) continue;

        for (const endpoint of [road.polyline[0], road.polyline[road.polyline.length - 1]]) {
          const nearLeft = Math.abs(endpoint.x - minX) <= margin;
          const nearRight = Math.abs(endpoint.x - maxX) <= margin;
          const nearTop = Math.abs(endpoint.z - minZ) <= margin;
          const nearBottom = Math.abs(endpoint.z - maxZ) <= margin;

          if (nearLeft || nearRight || nearTop || nearBottom) {
            foundBoundaryRoad = true;
            break;
          }
        }
        if (foundBoundaryRoad) break;
      }
      if (foundBoundaryRoad) break;
    }

    expect(foundBoundaryRoad).toBe(true);
  });
});
