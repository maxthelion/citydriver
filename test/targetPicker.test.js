import { describe, it, expect, beforeAll } from 'vitest';
import { PerlinNoise } from '../src/noise.js';
import { generateHeightmap, sampleHeightmap, CELL_SIZE, GRID_COUNT, ROAD_WIDTH } from '../src/heightmap.js';
import { CityGenerator } from '../src/city.js';
import { pickTargetLocation } from '../src/modes/targetPicker.js';

const SEED = 12345;

describe('pickTargetLocation', () => {
  let cityData;
  let rng;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);

    const gen = new CityGenerator(SEED);
    cityData = gen.generate();
  });

  function makeRng(seed) {
    let s = seed;
    return () => {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  it('returned point is on a road (within ROAD_WIDTH/2 of a road centerline)', () => {
    rng = makeRng(SEED);
    const carPos = { x: 0, z: 0 };
    const point = pickTargetLocation(cityData, carPos, rng, 0);

    // Check that the point is within ROAD_WIDTH/2 of at least one road centerline
    let onRoad = false;
    for (const road of cityData.roads) {
      if (road.horizontal) {
        // Road runs along x-axis at road.z
        if (point.x >= road.x && point.x <= road.endX) {
          if (Math.abs(point.z - road.z) <= ROAD_WIDTH / 2) {
            onRoad = true;
            break;
          }
        }
      } else {
        // Road runs along z-axis at road.x
        if (point.z >= road.z && point.z <= road.endZ) {
          if (Math.abs(point.x - road.x) <= ROAD_WIDTH / 2) {
            onRoad = true;
            break;
          }
        }
      }
    }

    expect(onRoad).toBe(true);
  });

  it('returned point is not inside any building', () => {
    rng = makeRng(SEED);
    const carPos = { x: 0, z: 0 };
    const point = pickTargetLocation(cityData, carPos, rng, 0);

    for (const b of cityData.buildings) {
      const insideX = Math.abs(point.x - b.x) < b.w / 2;
      const insideZ = Math.abs(point.z - b.z) < b.d / 2;
      expect(insideX && insideZ).toBe(false);
    }
  });

  it('returned point respects minimum distance from car', () => {
    rng = makeRng(SEED);
    const carPos = { x: 0, z: 0 };
    const minDist = 100;
    const point = pickTargetLocation(cityData, carPos, rng, minDist);

    const dx = point.x - carPos.x;
    const dz = point.z - carPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    expect(dist).toBeGreaterThanOrEqual(minDist);
  });

  it('returned y matches sampleHeightmap(x, z)', () => {
    rng = makeRng(SEED);
    const carPos = { x: 0, z: 0 };
    const point = pickTargetLocation(cityData, carPos, rng, 0);

    const expectedY = sampleHeightmap(point.x, point.z);
    expect(point.y).toBeCloseTo(expectedY, 5);
  });

  it('multiple calls return different locations', () => {
    const carPos = { x: 0, z: 0 };

    const rng1 = makeRng(SEED);
    const p1 = pickTargetLocation(cityData, carPos, rng1, 0);

    const rng2 = makeRng(SEED + 999);
    const p2 = pickTargetLocation(cityData, carPos, rng2, 0);

    // At least one coordinate should differ
    const same = p1.x === p2.x && p1.z === p2.z;
    expect(same).toBe(false);
  });
});
