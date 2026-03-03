import { describe, it, expect, beforeAll } from 'vitest';
import { PerlinNoise } from '../src/noise.js';
import { generateHeightmap, sampleHeightmap, CELL_SIZE, GRID_COUNT } from '../src/heightmap.js';
import { CityGenerator } from '../src/city.js';
import { initMaterials, initGeometries, sharedGeo } from '../src/materials.js';
import { buildBuilding } from '../src/builders.js';

const SEED = 12345;

const VALID_DISTRICTS = [
  'downtown_office', 'highrise_residential', 'shopping_street',
  'market', 'suburban_houses', 'park', 'industrial'
];

describe('District classification', () => {
  let cityData;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);
    initMaterials();
    initGeometries();
    const gen = new CityGenerator(SEED);
    cityData = gen.generate();
  });

  it('every block has a valid district type', () => {
    for (const block of cityData.blocks) {
      expect(VALID_DISTRICTS).toContain(block.district);
    }
  });

  it('city contains at least 3 different district types', () => {
    const types = new Set(cityData.blocks.map(b => b.district));
    expect(types.size).toBeGreaterThanOrEqual(3);
  });

  it('center blocks are downtown or highrise', () => {
    const halfCity = (GRID_COUNT * CELL_SIZE) / 2;
    const centerBlocks = cityData.blocks.filter(b => {
      const dist = Math.sqrt(b.x * b.x + b.z * b.z) / halfCity;
      return dist < 0.2;
    });
    if (centerBlocks.length > 0) {
      for (const block of centerBlocks) {
        expect(['downtown_office', 'highrise_residential']).toContain(block.district);
      }
    }
  });

  it('all buildings have compatibility contract fields (x, z, w, d)', () => {
    for (const b of cityData.buildings) {
      expect(typeof b.x).toBe('number');
      expect(typeof b.z).toBe('number');
      expect(typeof b.w).toBe('number');
      expect(typeof b.d).toBe('number');
      expect(b.w).toBeGreaterThan(0);
      expect(b.d).toBeGreaterThan(0);
    }
  });

  it('all buildings have district metadata', () => {
    for (const b of cityData.buildings) {
      expect(VALID_DISTRICTS.filter(d => d !== 'park')).toContain(b.district);
      expect(typeof b.floors).toBe('number');
      expect(b.floors).toBeGreaterThanOrEqual(1);
      expect(typeof b.doorFace).toBe('number');
      expect(b.doorFace).toBeGreaterThanOrEqual(0);
      expect(b.doorFace).toBeLessThanOrEqual(3);
    }
  });
});

describe('Building doors', () => {
  let builtBuildings;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);
    initMaterials();
    initGeometries();
    const gen = new CityGenerator(SEED);
    const cityData = gen.generate();
    // Build a sample of buildings (first 20) to keep test fast
    builtBuildings = cityData.buildings.slice(0, 20).map(b => buildBuilding(b));
  });

  it('every built building has at least one door mesh', () => {
    for (const group of builtBuildings) {
      let doorCount = 0;
      group.traverse((child) => {
        if (child.isMesh && child.geometry === sharedGeo.door) {
          doorCount++;
        }
      });
      expect(doorCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('door is positioned near ground level', () => {
    for (const group of builtBuildings) {
      group.traverse((child) => {
        if (child.isMesh && child.geometry === sharedGeo.door) {
          // Door center Y should be ~1.1 (half of 2.2 height) in local building space
          // But it's nested in a sub-group, so check local position
          expect(child.position.y).toBeCloseTo(1.1, 0);
        }
      });
    }
  });
});
