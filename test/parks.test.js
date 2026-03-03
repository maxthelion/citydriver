import { describe, it, expect, beforeAll } from 'vitest';
import { PerlinNoise } from '../src/noise.js';
import { generateHeightmap, sampleHeightmap } from '../src/heightmap.js';
import { CityGenerator } from '../src/city.js';
import { initMaterials, initGeometries } from '../src/materials.js';
import { buildPark } from '../src/builders.js';

const SEED = 12345;

describe('Park objects on ground', () => {
  let parks;
  let builtParks;

  beforeAll(() => {
    const perlin = new PerlinNoise(SEED);
    generateHeightmap(perlin);
    initMaterials();
    initGeometries();

    const gen = new CityGenerator(SEED);
    const cityData = gen.generate();
    parks = cityData.parks;

    // Build park meshes to check object positions
    builtParks = parks.map(p => buildPark(p));
  });

  it('has parks to test', () => {
    expect(parks.length).toBeGreaterThan(0);
  });

  it('tree trunks are placed on the terrain surface', () => {
    let trunkCount = 0;

    for (const parkGroup of builtParks) {
      parkGroup.traverse((child) => {
        if (!child.isMesh) return;
        // Tree trunks use CylinderGeometry and trunk material
        if (child.geometry.type === 'CylinderGeometry' &&
            child.geometry.parameters.radiusTop < 1) {
          const x = child.position.x;
          const z = child.position.z;
          const y = child.position.y;
          const terrainY = sampleHeightmap(x, z);

          // Trunk base should be roughly at terrain level
          // trunk.position.y = elev + treeH * 0.25, so it's above terrain
          // The trunk base (bottom of cylinder) = position.y - height/2
          // We just check the trunk position is above terrain (not buried)
          expect(y).toBeGreaterThan(terrainY - 0.5);
          trunkCount++;
        }
      });
    }

    expect(trunkCount).toBeGreaterThan(0);
  });

  it('benches are placed on the terrain surface', () => {
    let benchCount = 0;

    for (const parkGroup of builtParks) {
      parkGroup.traverse((child) => {
        if (!child.isMesh) return;
        // Benches use BoxGeometry(3, 0.8, 1)
        if (child.geometry.type === 'BoxGeometry' &&
            child.geometry.parameters.width === 3 &&
            child.geometry.parameters.height === 0.8) {
          const x = child.position.x;
          const z = child.position.z;
          const y = child.position.y;
          const terrainY = sampleHeightmap(x, z);

          // bench.position.y = sampleHeightmap(bx, bz) + 0.4
          const error = Math.abs(y - (terrainY + 0.4));
          expect(error).toBeLessThan(0.5);
          benchCount++;
        }
      });
    }

    expect(benchCount).toBeGreaterThan(0);
  });

  it('park grass patches conform to terrain', () => {
    let grassVertexCount = 0;

    for (const parkGroup of builtParks) {
      parkGroup.traverse((child) => {
        if (!child.isMesh) return;
        // Grass patches use BufferGeometry (not a named type)
        if (child.geometry.type === 'BufferGeometry') {
          const pos = child.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            const z = pos.getZ(i);
            const terrainY = sampleHeightmap(x, z);

            // Grass sits 0.05 above terrain
            const error = Math.abs(y - 0.05 - terrainY);
            expect(error).toBeLessThan(0.1);
            grassVertexCount++;
          }
        }
      });
    }

    expect(grassVertexCount).toBeGreaterThan(0);
  });
});
