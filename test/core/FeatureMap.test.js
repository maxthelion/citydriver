import { describe, it, expect } from 'vitest';
import { FeatureMap } from '../../src/core/FeatureMap.js';
import { Grid2D } from '../../src/core/Grid2D.js';

function makeMap(width = 50, height = 50, cellSize = 10) {
  const map = new FeatureMap(width, height, cellSize);
  const elevation = new Grid2D(width, height, { cellSize, fill: 100 });
  const slope = new Grid2D(width, height, { cellSize, fill: 0.02 });
  map.setTerrain(elevation, slope);
  return map;
}

describe('FeatureMap', () => {
  it('initializes with correct dimensions', () => {
    const map = makeMap(60, 40, 10);
    expect(map.width).toBe(60);
    expect(map.height).toBe(40);
    expect(map.cellSize).toBe(10);
  });

  it('computes buildability from terrain', () => {
    const map = makeMap();
    // Interior flat cell should be buildable
    expect(map.buildability.get(25, 25)).toBeGreaterThan(0.5);
    // Edge cell should be 0
    expect(map.buildability.get(0, 0)).toBe(0);
  });

  it('adds road features and updates roadGrid', () => {
    const map = makeMap();
    map.addFeature('road', {
      polyline: [{ x: 100, z: 250 }, { x: 400, z: 250 }],
      width: 10,
      hierarchy: 'collector',
    });

    expect(map.roads.length).toBe(1);
    // Road should have stamped some cells
    let roadCells = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.roadGrid.get(gx, gz) > 0) roadCells++;
      }
    }
    expect(roadCells).toBeGreaterThan(10);
  });

  it('zeros buildability under roads', () => {
    const map = makeMap();
    const gx = 25, gz = 25;
    const origBuild = map.buildability.get(gx, gz);
    expect(origBuild).toBeGreaterThan(0);

    // Add road through that cell
    const wx = gx * map.cellSize;
    const wz = gz * map.cellSize;
    map.addFeature('road', {
      polyline: [{ x: wx - 50, z: wz }, { x: wx + 50, z: wz }],
      width: 12,
      hierarchy: 'local',
    });

    expect(map.buildability.get(gx, gz)).toBe(0);
  });

  it('adds river features and updates waterMask', () => {
    const map = makeMap();
    map.addFeature('river', {
      polyline: [
        { x: 0, z: 250, width: 20, accumulation: 100 },
        { x: 500, z: 250, width: 30, accumulation: 200 },
      ],
    });

    expect(map.rivers.length).toBe(1);
    let waterCells = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.waterMask.get(gx, gz) > 0) waterCells++;
      }
    }
    expect(waterCells).toBeGreaterThan(5);
  });

  it('detects bridges where roads cross water', () => {
    const map = makeMap();
    // Add river horizontally
    map.addFeature('river', {
      polyline: [
        { x: 0, z: 250, width: 20, accumulation: 100 },
        { x: 500, z: 250, width: 20, accumulation: 100 },
      ],
    });

    // Add bridge road crossing vertically
    map.addFeature('road', {
      polyline: [{ x: 250, z: 0 }, { x: 250, z: 500 }],
      width: 10,
      hierarchy: 'collector',
      bridge: true,
    });

    let bridgeCells = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.bridgeGrid.get(gx, gz) > 0) bridgeCells++;
      }
    }
    expect(bridgeCells).toBeGreaterThan(0);
  });

  it('creates path cost functions', () => {
    const map = makeMap();
    const costFn = map.createPathCost('growth');
    const cost = costFn(25, 25, 26, 25);
    expect(cost).toBeGreaterThan(0);
    expect(isFinite(cost)).toBe(true);
  });

  it('classifies water types', () => {
    const map = makeMap();
    // Set some cells below sea level to create sea
    for (let gx = 0; gx < 5; gx++) {
      for (let gz = 0; gz < map.height; gz++) {
        map.elevation.set(gx, gz, -5);
        map.waterMask.set(gx, gz, 1);
      }
    }

    map.classifyWater(0);
    expect(map.waterType).not.toBeNull();
    // Edge water should be classified as sea (1)
    expect(map.waterType.get(0, 25)).toBe(1);
  });

  it('carves channels without error', () => {
    const map = makeMap();
    map.addFeature('river', {
      polyline: [
        { x: 0, z: 250, width: 20, accumulation: 100 },
        { x: 500, z: 250, width: 20, accumulation: 100 },
      ],
    });
    map.carveChannels();

    // Elevation should be lowered at river center
    const centerElev = map.elevation.get(25, 25);
    expect(centerElev).toBeLessThan(100);
  });
});

describe('FeatureMap.clone', () => {
  it('creates an independent deep copy with all grids and features', () => {
    const map = new FeatureMap(20, 20, 10, { originX: 50, originZ: 50 });
    const elev = new Grid2D(20, 20);
    const slope = new Grid2D(20, 20);
    elev.set(5, 5, 100);
    map.setTerrain(elev, slope);

    map.addFeature('road', {
      polyline: [{ x: 50, z: 50 }, { x: 250, z: 50 }],
      width: 8,
      hierarchy: 'arterial',
    });

    map.nuclei = [{ gx: 10, gz: 10, type: 'market', tier: 1, index: 0 }];

    const clone = map.clone();

    // Same dimensions and origin
    expect(clone.width).toBe(20);
    expect(clone.cellSize).toBe(10);
    expect(clone.originX).toBe(50);

    // Terrain copied
    expect(clone.elevation.get(5, 5)).toBe(100);

    // Features copied
    expect(clone.roads.length).toBe(1);
    expect(clone.features.length).toBe(1);

    // Nuclei copied
    expect(clone.nuclei.length).toBe(1);
    expect(clone.nuclei[0].type).toBe('market');

    // Grids are independent
    clone.buildability.set(0, 0, 0.99);
    expect(map.buildability.get(0, 0)).not.toBe(0.99);

    // Features are independent
    clone.addFeature('road', {
      polyline: [{ x: 50, z: 100 }, { x: 250, z: 100 }],
      width: 6,
      hierarchy: 'local',
    });
    expect(clone.roads.length).toBe(2);
    expect(map.roads.length).toBe(1);

    // Nuclei are independent
    clone.nuclei.push({ gx: 5, gz: 5, type: 'suburban', tier: 3, index: 1 });
    expect(map.nuclei.length).toBe(1);
  });
});
