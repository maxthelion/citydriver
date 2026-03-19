import { describe, it, expect } from 'vitest';
import { FeatureMap } from '../../src/core/FeatureMap.js';
import { Grid2D } from '../../src/core/Grid2D.js';
import { computeTerrainSuitability } from '../../src/core/terrainSuitability.js';
import { stampRiverWaterMask } from '../../src/city/stampFeature.js';

function makeMap(width = 50, height = 50, cellSize = 10) {
  const map = new FeatureMap(width, height, cellSize);
  const elevation = new Grid2D(width, height, { cellSize, fill: 100 });
  const slope = new Grid2D(width, height, { cellSize, fill: 0.02 });
  map.elevation = elevation;
  map.slope = slope;
  const { suitability } = computeTerrainSuitability(elevation, slope, map.waterMask, 0, null);
  map.setLayer('terrainSuitability', suitability);
  map.setLayer('elevation', elevation);
  map.setLayer('slope', slope);
  map.setLayer('waterMask', map.waterMask);
  return map;
}

describe('FeatureMap', () => {
  it('initializes with correct dimensions', () => {
    const map = makeMap(60, 40, 10);
    expect(map.width).toBe(60);
    expect(map.height).toBe(40);
    expect(map.cellSize).toBe(10);
  });

  it('terrainSuitability is set from computeTerrainSuitability', () => {
    const map = makeMap();
    const suitability = map.getLayer('terrainSuitability');
    expect(suitability).toBeDefined();
    // Interior flat cell should be buildable
    expect(suitability.get(25, 25)).toBeGreaterThan(0.5);
    // Edge cell should be 0
    expect(suitability.get(0, 0)).toBe(0);
  });

  it('adds roads via roadNetwork and updates roadGrid', () => {
    const map = makeMap();
    map.roadNetwork.add(
      [{ x: 100, z: 250 }, { x: 400, z: 250 }],
      { width: 10, hierarchy: 'collector', source: 'skeleton' }
    );

    expect(map.roads.length).toBe(1);
    let roadCells = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.roadGrid.get(gx, gz) > 0) roadCells++;
      }
    }
    expect(roadCells).toBeGreaterThan(10);
  });

  it('adds river features and stamps waterMask', () => {
    const map = makeMap();
    const river = {
      type: 'river',
      polyline: [
        { x: 0, z: 250, width: 20, accumulation: 100 },
        { x: 500, z: 250, width: 30, accumulation: 200 },
      ],
    };
    map.rivers.push(river);
    stampRiverWaterMask(map.waterMask, river, map.cellSize, map.originX, map.originZ);

    expect(map.rivers.length).toBe(1);
    let waterCells = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.waterMask.get(gx, gz) > 0) waterCells++;
      }
    }
    expect(waterCells).toBeGreaterThan(5);
  });

  it('creates path cost functions using terrainSuitability', () => {
    const map = makeMap();
    const costFn = map.createPathCost('growth');
    const cost = costFn(25, 25, 26, 25);
    expect(cost).toBeGreaterThan(0);
    expect(isFinite(cost)).toBe(true);
  });

  it('classifies water types', () => {
    const map = makeMap();
    for (let gx = 0; gx < 5; gx++) {
      for (let gz = 0; gz < map.height; gz++) {
        map.elevation.set(gx, gz, -5);
        map.waterMask.set(gx, gz, 1);
      }
    }
    map.classifyWater(0);
    expect(map.waterType).not.toBeNull();
    expect(map.waterType.get(0, 25)).toBe(1);
  });

  it('carves channels without error', () => {
    const map = makeMap();
    const river = {
      type: 'river',
      polyline: [
        { x: 0, z: 250, width: 20, accumulation: 100 },
        { x: 500, z: 250, width: 20, accumulation: 100 },
      ],
    };
    map.rivers.push(river);
    stampRiverWaterMask(map.waterMask, river, map.cellSize, map.originX, map.originZ);
    map.carveChannels();
    const centerElev = map.elevation.get(25, 25);
    expect(centerElev).toBeLessThan(100);
  });
});

describe('resolution independence', () => {
  it('terrainSuitability is similar at different cell sizes', () => {
    const map10 = makeMap(30, 30, 10);
    const map5 = makeMap(60, 60, 5);
    const b10 = map10.getLayer('terrainSuitability').get(5, 15);
    const b5 = map5.getLayer('terrainSuitability').get(10, 30);
    expect(Math.abs(b10 - b5)).toBeLessThan(0.15);
  });
});

describe('revised land value', () => {
  it('flat ground near center has high value', () => {
    const map = makeMap(60, 60, 5);
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();
    expect(map.landValue.get(30, 30)).toBeGreaterThan(0.7);
  });

  it('flat ground far from center has lower value', () => {
    const map = makeMap(60, 60, 5);
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();
    const center = map.landValue.get(30, 30);
    const far = map.landValue.get(55, 55);
    expect(center).toBeGreaterThan(far);
  });

  it('steep ground far from nucleus has low value', () => {
    const map = new FeatureMap(60, 60, 5);
    const elevation = new Grid2D(60, 60, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(60, 60, { cellSize: 5, fill: 0.35 });
    map.elevation = elevation;
    map.slope = slope;
    map.setLayer('slope', slope);
    const { suitability } = computeTerrainSuitability(elevation, slope, map.waterMask, 0, null);
    map.setLayer('terrainSuitability', suitability);
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();
    expect(map.landValue.get(55, 55)).toBeLessThan(0.5);
  });

  it('sloped cell near nucleus scores higher than sloped cell far away', () => {
    const map = new FeatureMap(120, 120, 5);
    const elevation = new Grid2D(120, 120, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(120, 120, { cellSize: 5, fill: 0.2 });
    map.elevation = elevation;
    map.slope = slope;
    map.setLayer('slope', slope);
    const { suitability } = computeTerrainSuitability(elevation, slope, map.waterMask, 0, null);
    map.setLayer('terrainSuitability', suitability);
    map.nuclei = [{ gx: 60, gz: 60, type: 'market' }];
    map.computeLandValue();
    const nearNucleus = map.landValue.get(62, 60);
    const farFromNucleus = map.landValue.get(5, 5);
    expect(nearNucleus).toBeGreaterThan(farFromNucleus);
  });

  it('water proximity adds bonus to nearby land', () => {
    const map = new FeatureMap(60, 60, 5);
    const elevation = new Grid2D(60, 60, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(60, 60, { cellSize: 5, fill: 0.02 });
    for (let gz = 0; gz < 60; gz++) map.waterMask.set(29, gz, 1);
    map.elevation = elevation;
    map.slope = slope;
    map.setLayer('slope', slope);
    map.setLayer('waterMask', map.waterMask);
    const { suitability, waterDist } = computeTerrainSuitability(elevation, slope, map.waterMask, 0, null);
    map.setLayer('terrainSuitability', suitability);
    map.setLayer('waterDist', waterDist);
    map.waterDist = waterDist;
    map.nuclei = [{ gx: 15, gz: 30, type: 'market' }];
    map.computeLandValue();
    const withBonus = map.landValue.get(20, 30);
    const withoutBonus = map.landValue.get(10, 30);
    expect(withBonus).toBeGreaterThan(withoutBonus);
  });
});

describe('FeatureMap.clone', () => {
  it('creates an independent deep copy with grids and roads', () => {
    const map = new FeatureMap(20, 20, 10, { originX: 50, originZ: 50 });
    const elev = new Grid2D(20, 20, { cellSize: 10 });
    elev.set(5, 5, 100);
    map.elevation = elev;
    map.slope = new Grid2D(20, 20, { cellSize: 10 });

    map.roadNetwork.add(
      [{ x: 50, z: 50 }, { x: 250, z: 50 }],
      { width: 8, hierarchy: 'arterial', source: 'skeleton' }
    );
    map.nuclei = [{ gx: 10, gz: 10, type: 'market', tier: 1, index: 0 }];

    const clone = map.clone();

    expect(clone.width).toBe(20);
    expect(clone.cellSize).toBe(10);
    expect(clone.originX).toBe(50);
    expect(clone.elevation.get(5, 5)).toBe(100);
    expect(clone.roads.length).toBe(1);
    expect(clone.nuclei.length).toBe(1);
    expect(clone.nuclei[0].type).toBe('market');

    // Roads are independent
    clone.roadNetwork.add(
      [{ x: 50, z: 100 }, { x: 250, z: 100 }],
      { width: 6, hierarchy: 'local', source: 'skeleton' }
    );
    expect(clone.roads.length).toBe(2);
    expect(map.roads.length).toBe(1);

    // Nuclei are independent
    clone.nuclei.push({ gx: 5, gz: 5, type: 'suburban', tier: 3, index: 1 });
    expect(map.nuclei.length).toBe(1);
  });
});

describe('layer bag', () => {
  it('stores and retrieves named layers', () => {
    const map = makeMap();
    const grid = new Grid2D(50, 50, { type: 'float32' });
    grid.set(10, 10, 0.5);
    map.setLayer('testLayer', grid);

    expect(map.hasLayer('testLayer')).toBe(true);
    expect(map.getLayer('testLayer').get(10, 10)).toBe(0.5);
    expect(map.hasLayer('nonexistent')).toBe(false);
  });
});
