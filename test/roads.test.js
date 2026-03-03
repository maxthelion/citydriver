import { describe, it, expect, beforeAll } from 'vitest';
import { PerlinNoise } from '../src/noise.js';
import { generateHeightmap, sampleHeightmap } from '../src/heightmap.js';
import { CityGenerator } from '../src/city.js';
import { initMaterials, initGeometries } from '../src/materials.js';
import { buildRoadChunk, buildIntersection, ROAD_LIFT } from '../src/builders.js';

const SEED = 12345;

describe('Road-terrain contact', () => {
  let cityData;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);
    initMaterials();
    initGeometries();

    const gen = new CityGenerator(SEED);
    cityData = gen.generate();
  });

  it('road mesh vertices sit on the terrain surface (within tolerance)', () => {
    let maxError = 0;
    let vertexCount = 0;

    for (const road of cityData.roads) {
      const group = buildRoadChunk(road);

      group.traverse((child) => {
        if (!child.isMesh) return;
        const pos = child.geometry.attributes.position;

        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);

          const terrainY = sampleHeightmap(x, z);
          const error = Math.abs(y - ROAD_LIFT - terrainY);
          maxError = Math.max(maxError, error);
          vertexCount++;

          expect(error).toBeLessThan(0.1);
        }
      });
    }

    expect(vertexCount).toBeGreaterThan(0);
  });

  it('intersection patches sit on the terrain surface', async () => {
    const { CELL_SIZE, GRID_COUNT } = await import('../src/heightmap.js');
    const halfCity = (GRID_COUNT * CELL_SIZE) / 2;
    let vertexCount = 0;

    for (let gx = 0; gx <= GRID_COUNT; gx++) {
      for (let gz = 0; gz <= GRID_COUNT; gz++) {
        const ix = gx * CELL_SIZE - halfCity;
        const iz = gz * CELL_SIZE - halfCity;
        const mesh = buildIntersection(ix, iz);
        const pos = mesh.geometry.attributes.position;

        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);

          const terrainY = sampleHeightmap(x, z);
          const error = Math.abs(y - ROAD_LIFT - terrainY);
          vertexCount++;

          expect(error).toBeLessThan(0.1);
        }
      }
    }

    expect(vertexCount).toBeGreaterThan(0);
  });

  it('road mesh face normals point upward (visible from above)', () => {
    for (const road of cityData.roads) {
      const group = buildRoadChunk(road);

      group.traverse((child) => {
        if (!child.isMesh) return;
        const pos = child.geometry.attributes.position;
        const normal = child.geometry.attributes.normal;

        if (!normal) return;

        // Every vertex normal should have a positive Y component
        // (faces visible from above, not back-face culled)
        for (let i = 0; i < normal.count; i++) {
          const ny = normal.getY(i);
          expect(ny).toBeGreaterThan(0);
        }
      });
    }
  });
});
