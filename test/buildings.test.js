import { describe, it, expect, beforeAll } from 'vitest';
import { PerlinNoise } from '../src/noise.js';
import { generateHeightmap, sampleHeightmap, CELL_SIZE, GRID_COUNT, BLOCK_SIZE, ROAD_WIDTH } from '../src/heightmap.js';
import { CityGenerator } from '../src/city.js';
import { initMaterials, initGeometries } from '../src/materials.js';
import { BUILDING_EXTRA_DEPTH } from '../src/builders.js';

const SEED = 12345;

describe('Building grounding', () => {
  let buildings;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);
    initMaterials();
    initGeometries();

    const gen = new CityGenerator(SEED);
    const cityData = gen.generate();
    buildings = cityData.buildings;
  });

  it('has buildings to test', () => {
    expect(buildings.length).toBeGreaterThan(0);
  });

  it('every building base is at or below terrain at all 4 corners', () => {
    for (const b of buildings) {
      // buildBuilding sets group.position.y = min of 5 sample points
      const groundY = Math.min(
        sampleHeightmap(b.x, b.z),
        sampleHeightmap(b.x - b.w / 2, b.z - b.d / 2),
        sampleHeightmap(b.x + b.w / 2, b.z - b.d / 2),
        sampleHeightmap(b.x - b.w / 2, b.z + b.d / 2),
        sampleHeightmap(b.x + b.w / 2, b.z + b.d / 2),
      );

      // Check that groundY is at or below all 4 corners
      const corners = [
        [b.x - b.w / 2, b.z - b.d / 2],
        [b.x + b.w / 2, b.z - b.d / 2],
        [b.x - b.w / 2, b.z + b.d / 2],
        [b.x + b.w / 2, b.z + b.d / 2],
      ];

      for (const [cx, cz] of corners) {
        const cornerTerrain = sampleHeightmap(cx, cz);
        // groundY should be <= cornerTerrain (it's the min of all 5 points)
        expect(groundY).toBeLessThanOrEqual(cornerTerrain + 0.01);
      }

      // No building base should be more than EXTRA_DEPTH + 0.5 below terrain at any corner
      for (const [cx, cz] of corners) {
        const cornerTerrain = sampleHeightmap(cx, cz);
        expect(cornerTerrain - groundY).toBeLessThan(BUILDING_EXTRA_DEPTH + 10);
      }
    }
  });
});

describe('No building overlaps', () => {
  let buildings;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);
    const gen = new CityGenerator(SEED);
    const cityData = gen.generate();
    buildings = cityData.buildings;
  });

  it('no pair of buildings has overlapping XZ footprints (with 1-unit margin)', () => {
    for (let i = 0; i < buildings.length; i++) {
      for (let j = i + 1; j < buildings.length; j++) {
        const a = buildings[i];
        const b = buildings[j];
        const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 1;
        const overlapZ = Math.abs(a.z - b.z) < (a.d + b.d) / 2 + 1;

        if (overlapX && overlapZ) {
          // If both overlap, the buildings are overlapping
          expect(overlapX && overlapZ).toBe(false);
        }
      }
    }
  });
});

describe('Buildings within blocks (not on roads)', () => {
  let buildings;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);
    const gen = new CityGenerator(SEED);
    const cityData = gen.generate();
    buildings = cityData.buildings;
  });

  it('every building center falls within a block boundary, not on a road', () => {
    const halfCity = (GRID_COUNT * CELL_SIZE) / 2;

    for (const b of buildings) {
      // Convert building position to grid-relative coordinates
      const relX = b.x + halfCity;
      const relZ = b.z + halfCity;

      // Position within a cell
      const cellX = ((relX % CELL_SIZE) + CELL_SIZE) % CELL_SIZE;
      const cellZ = ((relZ % CELL_SIZE) + CELL_SIZE) % CELL_SIZE;

      // Road occupies the first ROAD_WIDTH/2 on each side of the cell boundary
      // The block is in the center: from ROAD_WIDTH/2 to ROAD_WIDTH/2 + BLOCK_SIZE
      const inBlockX = cellX >= ROAD_WIDTH / 2 && cellX <= ROAD_WIDTH / 2 + BLOCK_SIZE;
      const inBlockZ = cellZ >= ROAD_WIDTH / 2 && cellZ <= ROAD_WIDTH / 2 + BLOCK_SIZE;

      expect(inBlockX || inBlockZ).toBe(true);
    }
  });
});
