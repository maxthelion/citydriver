import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { PerlinNoise } from '../src/noise.js';
import { generateHeightmap, sampleHeightmap, TERRAIN_SIZE, TERRAIN_SEGMENTS } from '../src/heightmap.js';
import { createTerrain } from '../src/builders.js';
import { initMaterials } from '../src/materials.js';

const SEED = 12345;

describe('Terrain mesh vertex accuracy', () => {
  let terrainMesh;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    const hmData = generateHeightmap(perlin);
    initMaterials();
    terrainMesh = createTerrain(hmData);
  });

  it('every mesh vertex in world space matches sampleHeightmap(worldX, worldZ)', () => {
    // The terrain mesh is a PlaneGeometry rotated -PI/2 around X.
    // We must transform local coords to world coords before comparing.
    //
    // Rotation -PI/2 around X:
    //   local X  →  world X
    //   local Y  →  world -Z
    //   local Z  →  world Y  (this is the height)
    //
    // The spec requires: worldY == sampleHeightmap(worldX, worldZ)

    const pos = terrainMesh.geometry.attributes.position;
    let maxError = 0;
    let failCount = 0;

    for (let i = 0; i < pos.count; i++) {
      const localX = pos.getX(i);
      const localY = pos.getY(i);
      const localZ = pos.getZ(i);

      // Transform to world space
      const worldX = localX;
      const worldZ = -localY;
      const worldY = localZ; // the height set by createTerrain

      const expected = sampleHeightmap(worldX, worldZ);
      const error = Math.abs(worldY - expected);
      maxError = Math.max(maxError, error);

      if (error >= 1e-4) failCount++;
    }

    expect(maxError).toBeLessThan(1e-4);
  });

  it('heightmap returns consistent values for repeated queries', () => {
    for (let i = 0; i < 100; i++) {
      const x = (Math.random() - 0.5) * TERRAIN_SIZE;
      const z = (Math.random() - 0.5) * TERRAIN_SIZE;
      const h1 = sampleHeightmap(x, z);
      const h2 = sampleHeightmap(x, z);
      expect(h1).toBe(h2);
    }
  });

  it('heightmap values are within reasonable bounds', () => {
    for (let i = 0; i < 200; i++) {
      const x = (Math.random() - 0.5) * TERRAIN_SIZE;
      const z = (Math.random() - 0.5) * TERRAIN_SIZE;
      const h = sampleHeightmap(x, z);
      expect(h).toBeGreaterThan(-80);
      expect(h).toBeLessThan(80);
    }
  });
});
