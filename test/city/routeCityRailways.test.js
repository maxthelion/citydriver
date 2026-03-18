import { describe, it, expect } from 'vitest';
import { extractEntryPoints, scoreStationLocation, routeCityRailways } from '../../src/city/routeCityRailways.js';
import { Grid2D } from '../../src/core/Grid2D.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { setupCity } from '../../src/city/setup.js';
import { SeededRandom } from '../../src/core/rng.js';

// --- Helpers ---

function assertNoOverlap(gridA, gridB) {
  let violations = 0;
  for (let gz = 0; gz < gridA.height; gz++) {
    for (let gx = 0; gx < gridA.width; gx++) {
      if (gridA.get(gx, gz) > 0 && gridB.get(gx, gz) > 0) violations++;
    }
  }
  return violations;
}

function makeCity(seed) {
  const rng = new SeededRandom(seed);
  const layers = generateRegion({ width: 64, height: 64, cellSize: 200 }, rng);
  const s = layers.getData('settlements').find(s => s.tier === 1)
    || layers.getData('settlements')[0];
  return setupCity(layers, s, new SeededRandom(seed));
}

// --- Unit tests ---

describe('unit tests', () => {
  it('extractEntryPoints finds boundary crossings', () => {
    const bounds = { minX: 100, minZ: 100, maxX: 500, maxZ: 500 };
    const railways = [
      { polyline: [{ x: 100, z: 300 }, { x: 200, z: 300 }, { x: 400, z: 300 }] },
    ];
    const entries = extractEntryPoints(railways, bounds);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('merges entries from similar directions', () => {
    const bounds = { minX: 0, minZ: 0, maxX: 500, maxZ: 500 };
    const railways = [
      { polyline: [{ x: 0, z: 200 }, { x: 100, z: 200 }] },
      { polyline: [{ x: 0, z: 210 }, { x: 100, z: 210 }] },
    ];
    const entries = extractEntryPoints(railways, bounds);
    expect(entries.length).toBe(1);
  });

  it('scoreStationLocation returns null with no entries', () => {
    const e = new Grid2D(10, 10, { cellSize: 5 });
    const w = new Grid2D(10, 10, { type: 'uint8' });
    const l = new Grid2D(10, 10, { type: 'float32' });
    expect(scoreStationLocation([], e, w, l, 10, 10, 5, 0, 0)).toBeNull();
  });

  it('routeCityRailways returns polylines, not raw paths or grids', () => {
    const w = 80, h = 80, cs = 5;
    const elevation = new Grid2D(w, h, { cellSize: cs });
    elevation.forEach((gx, gz) => elevation.set(gx, gz, 50));
    const waterMask = new Grid2D(w, h, { type: 'uint8' });
    const landValue = new Grid2D(w, h, { type: 'float32' });
    landValue.forEach((gx, gz) => landValue.set(gx, gz, 0.5));

    const railways = [{ polyline: [{ x: 0, z: 200 }, { x: 100, z: 200 }, { x: 300, z: 200 }] }];
    const bounds = { minX: 0, minZ: 0, maxX: 400, maxZ: 400 };

    const result = routeCityRailways(railways, elevation, waterMask, landValue, bounds, cs, 0, 0);
    expect(result.polylines.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('railGrid');
    expect(result).not.toHaveProperty('paths');
    for (const pl of result.polylines) {
      expect(pl[0]).toHaveProperty('x');
      expect(pl[0]).toHaveProperty('z');
    }
  });
});

// --- Bitmap invariant tests (full pipeline) ---

describe('bitmap invariants', () => {
  for (const seed of [42, 99, 751119]) {
    describe(`seed ${seed}`, () => {
      const map = makeCity(seed);

      it('railway ∩ water = ∅', () => {
        const violations = assertNoOverlap(map.railwayGrid, map.waterMask);
        expect(violations, `${violations} railway cells on water`).toBe(0);
      });

      it('station on dry land', () => {
        if (!map.station) return;
        const gx = Math.round((map.station.x - map.originX) / map.cellSize);
        const gz = Math.round((map.station.z - map.originZ) / map.cellSize);
        if (gx >= 0 && gx < map.width && gz >= 0 && gz < map.height) {
          expect(map.waterMask.get(gx, gz), 'station on water').toBe(0);
        }
      });

      it('railway cells have buildability = 0', () => {
        let violations = 0;
        map.railwayGrid.forEach((gx, gz, v) => {
          if (v > 0 && map.buildability.get(gx, gz) > 0) violations++;
        });
        expect(violations, `${violations} buildable railway cells`).toBe(0);
      });

      it('station elevation above sea level', () => {
        if (!map.station) return;
        expect(map.station.elevation).toBeGreaterThan(map.seaLevel || 0);
      });
    });
  }
});
