import { describe, it, expect } from 'vitest';
import { compactRoads } from '../../src/city/skeleton.js';
import { FeatureMap } from '../../src/core/FeatureMap.js';
import { Grid2D } from '../../src/core/Grid2D.js';

function makeMap(width = 50, height = 50, cellSize = 10) {
  const map = new FeatureMap(width, height, cellSize);
  map.elevation = new Grid2D(width, height, { cellSize, fill: 100 });
  map.slope = new Grid2D(width, height, { cellSize, fill: 0.02 });
  return map;
}

function addRoad(map, polyline, hierarchy = 'arterial') {
  map.roadNetwork.add(polyline, { width: hierarchy === 'arterial' ? 16 : 10, hierarchy, source: 'skeleton' });
}

describe('compactRoads', () => {
  it('removes duplicate roads with identical endpoints', () => {
    const map = makeMap();
    addRoad(map, [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }], 'arterial');
    addRoad(map, [{ x: 0, z: 0 }, { x: 50, z: 5 }, { x: 100, z: 0 }], 'collector');

    expect(map.ways.length).toBe(2);
    compactRoads(map, 15);
    expect(map.ways.length).toBe(1);
    expect(map.ways[0].hierarchy).toBe('arterial');
  });

  it('removes duplicate roads whose endpoints become identical after snapping', () => {
    const map = makeMap();
    addRoad(map, [{ x: 0, z: 0 }, { x: 200, z: 0 }], 'arterial');
    addRoad(map, [{ x: 10, z: 0 }, { x: 200, z: 10 }], 'collector');

    expect(map.ways.length).toBe(2);
    compactRoads(map, 15);
    expect(map.ways.length).toBe(1);
  });

  it('snaps nearby endpoints to shared positions', () => {
    const map = makeMap();
    addRoad(map, [{ x: 0, z: 0 }, { x: 100, z: 0 }], 'arterial');
    addRoad(map, [{ x: 100, z: 10 }, { x: 200, z: 0 }], 'collector');

    compactRoads(map, 15);

    const road1end = map.ways[0].polyline[map.ways[0].polyline.length - 1];
    const road2start = map.ways[1].polyline[0];
    expect(road2start.x).toBe(road1end.x);
    expect(road2start.z).toBe(road1end.z);
  });

  it('deduplicates consecutive identical endpoints', () => {
    const map = makeMap();
    addRoad(map, [{ x: 0, z: 0 }, { x: 100, z: 0 }], 'arterial');
    addRoad(map, [{ x: 0, z: 0 }, { x: 100, z: 10 }], 'collector');

    compactRoads(map, 15);
    expect(map.ways.length).toBe(1);
  });

  it('removes fan duplicates that share one snapped endpoint and near-opposite endpoints', () => {
    const map = makeMap();
    addRoad(map, [{ x: 0, z: 0 }, { x: 0, z: 20 }], 'arterial');
    addRoad(map, [{ x: 5, z: 0 }, { x: 0, z: 20 }], 'collector');

    compactRoads(map, 15);
    expect(map.ways.length).toBe(1);
    expect(map.ways[0].hierarchy).toBe('arterial');
  });

  it('does not merge distant roads', () => {
    const map = makeMap();
    addRoad(map, [{ x: 0, z: 0 }, { x: 100, z: 0 }], 'arterial');
    addRoad(map, [{ x: 0, z: 100 }, { x: 100, z: 100 }], 'collector');

    compactRoads(map, 15);
    expect(map.ways.length).toBe(2);
  });
});
