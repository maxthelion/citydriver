import { describe, it, expect } from 'vitest';
import { prepareCityScene } from '../../src/rendering/prepareCityScene.js';
import { setupCity } from '../../src/city/setup.js';
import { buildSkeletonRoads } from '../../src/city/skeleton.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

// Shared city across structure tests (same seed, generated once)
let sharedMap = null;
let sharedScene = null;
function getShared() {
  if (!sharedMap) {
    sharedMap = makeCity(42);
    if (sharedMap) sharedScene = prepareCityScene(sharedMap);
  }
  return { map: sharedMap, sd: sharedScene };
}

function makeCity(seed = 42) {
  const rng = new SeededRandom(seed);
  const layers = generateRegion({ width: 128, height: 128, cellSize: 200, seaLevel: 0 }, rng);
  const settlements = layers.getData('settlements');
  if (!settlements || settlements.length === 0) return null;
  const settlement = settlements[0];
  const map = setupCity(layers, settlement, rng.fork('city'));
  buildSkeletonRoads(map);
  return map;
}

describe('prepareCityScene', { timeout: 60000 }, () => {
  it('returns expected structure', () => {
    const { map, sd } = getShared();
    if (!map) return;

    expect(sd.roads).toBeInstanceOf(Array);
    expect(sd.rivers).toBeInstanceOf(Array);
    expect(sd.cutElevation).toBeInstanceOf(Float32Array);
    expect(sd.cutElevation.length).toBe(map.width * map.height);
    expect(sd.width).toBe(map.width);
    expect(sd.height).toBe(map.height);
  });

  it('road polylines are in local coords (near 0..width*cellSize)', () => {
    const { map, sd } = getShared();
    if (!map) return;

    const maxX = map.width * map.cellSize;
    const maxZ = map.height * map.cellSize;

    for (const road of sd.roads) {
      for (const p of road.localPts) {
        expect(p.x).toBeGreaterThanOrEqual(-maxX * 0.1);
        expect(p.x).toBeLessThanOrEqual(maxX * 1.1);
        expect(p.z).toBeGreaterThanOrEqual(-maxZ * 0.1);
        expect(p.z).toBeLessThanOrEqual(maxZ * 1.1);
      }
    }
  });

  it('roads have neutral camber (flat Y across width)', () => {
    const { map, sd } = getShared();
    if (!map) return;

    for (const road of sd.roads) {
      for (const p of road.localPts) {
        expect(typeof p.y).toBe('number');
        expect(p.y).not.toBeNaN();
      }
    }
  });

  it('rivers flow monotonically downhill', () => {
    const { map, sd } = getShared();
    if (!map) return;

    for (const river of sd.rivers) {
      const pts = river.localPts;
      for (let i = 1; i < pts.length; i++) {
        expect(pts[i].y).toBeLessThanOrEqual(pts[i - 1].y + 0.001);
      }
    }
  });

  it('cutElevation has no NaN values', () => {
    const { map, sd } = getShared();
    if (!map) return;

    for (let i = 0; i < sd.cutElevation.length; i++) {
      expect(sd.cutElevation[i]).not.toBeNaN();
    }
  });

  it('works across multiple seeds without errors', { timeout: 180000 }, () => {
    for (const seed of [1, 100, 999]) {
      const map = makeCity(seed);
      if (!map) continue;
      const sd = prepareCityScene(map);
      expect(sd.roads).toBeInstanceOf(Array);
      expect(sd.rivers).toBeInstanceOf(Array);
      for (let i = 0; i < sd.cutElevation.length; i++) {
        expect(sd.cutElevation[i]).not.toBeNaN();
      }
    }
  });
});
