import { describe, it, expect } from 'vitest';
import { compactRoads } from '../../src/city/skeleton.js';
import { FeatureMap } from '../../src/core/FeatureMap.js';
import { Grid2D } from '../../src/core/Grid2D.js';

function makeMap(width = 50, height = 50, cellSize = 10) {
  const map = new FeatureMap(width, height, cellSize);
  const elevation = new Grid2D(width, height, { cellSize, fill: 100 });
  const slope = new Grid2D(width, height, { cellSize, fill: 0.02 });
  map.setTerrain(elevation, slope);
  return map;
}

describe('compactRoads', () => {
  it('removes duplicate roads with identical endpoints', () => {
    const map = makeMap();
    // Two roads with exact same endpoints
    map.addFeature('road', {
      polyline: [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }],
      width: 16, hierarchy: 'arterial', source: 'skeleton',
    });
    map.addFeature('road', {
      polyline: [{ x: 0, z: 0 }, { x: 50, z: 5 }, { x: 100, z: 0 }],
      width: 10, hierarchy: 'collector', source: 'skeleton',
    });

    expect(map.roads.length).toBe(2);
    compactRoads(map, 15);
    expect(map.roads.length).toBe(1);
    expect(map.roads[0].hierarchy).toBe('arterial');
  });

  it('removes duplicate roads whose endpoints become identical after snapping', () => {
    const map = makeMap();
    // Two roads with endpoints 10 units apart (within snapDist=15)
    map.addFeature('road', {
      polyline: [{ x: 0, z: 0 }, { x: 200, z: 0 }],
      width: 16, hierarchy: 'arterial', source: 'skeleton',
    });
    map.addFeature('road', {
      polyline: [{ x: 10, z: 0 }, { x: 200, z: 10 }],
      width: 10, hierarchy: 'collector', source: 'skeleton',
    });

    expect(map.roads.length).toBe(2);
    compactRoads(map, 15);
    // After snapping, both roads should have same start and end points
    // so one should be removed
    expect(map.roads.length).toBe(1);
  });

  it('snaps nearby endpoints to shared positions', () => {
    const map = makeMap();
    map.addFeature('road', {
      polyline: [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      width: 10, hierarchy: 'arterial', source: 'skeleton',
    });
    map.addFeature('road', {
      polyline: [{ x: 100, z: 10 }, { x: 200, z: 0 }],
      width: 10, hierarchy: 'collector', source: 'skeleton',
    });

    compactRoads(map, 15);

    // road1 endpoint (100,0) and road2 start (100,10) are within snapDist=15
    // road2's start should snap to road1's end
    const road1end = map.roads[0].polyline[map.roads[0].polyline.length - 1];
    const road2start = map.roads[1].polyline[0];
    expect(road2start.x).toBe(road1end.x);
    expect(road2start.z).toBe(road1end.z);
  });

  it('deduplicates consecutive identical endpoints', () => {
    const map = makeMap();
    // Two roads ending at the same snapped point, both going to a third
    map.addFeature('road', {
      polyline: [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      width: 10, hierarchy: 'arterial', source: 'skeleton',
    });
    map.addFeature('road', {
      polyline: [{ x: 0, z: 0 }, { x: 100, z: 10 }],
      width: 10, hierarchy: 'collector', source: 'skeleton',
    });

    compactRoads(map, 15);

    // (100,0) and (100,10) snap together → both roads same endpoints → deduped
    expect(map.roads.length).toBe(1);
  });

  it('does not merge distant roads', () => {
    const map = makeMap();
    map.addFeature('road', {
      polyline: [{ x: 0, z: 0 }, { x: 100, z: 0 }],
      width: 10, hierarchy: 'arterial', source: 'skeleton',
    });
    map.addFeature('road', {
      polyline: [{ x: 0, z: 100 }, { x: 100, z: 100 }],
      width: 10, hierarchy: 'collector', source: 'skeleton',
    });

    compactRoads(map, 15);
    expect(map.roads.length).toBe(2);
  });

});
