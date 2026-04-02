import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FeatureMap } from '../../src/core/FeatureMap.js';
import { Grid2D } from '../../src/core/Grid2D.js';
import { saveMapFixture, loadMapFixture } from '../../src/core/featureMapFixture.js';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('FeatureMap fixture save/load', () => {
  it('round-trips grids, structured data, and shared-node road topology', async () => {
    const map = new FeatureMap(16, 16, 5, { originX: 100, originZ: 200 });
    map.elevation = new Grid2D(16, 16, { type: 'float32', cellSize: 5, originX: 100, originZ: 200 });
    map.slope = new Grid2D(16, 16, { type: 'float32', cellSize: 5, originX: 100, originZ: 200 });
    map.waterMask = new Grid2D(16, 16, { type: 'uint8', cellSize: 5, originX: 100, originZ: 200 });
    map.landValue = new Grid2D(16, 16, { type: 'float32', cellSize: 5, originX: 100, originZ: 200 });
    map.railwayGrid = new Grid2D(16, 16, { type: 'uint8', cellSize: 5, originX: 100, originZ: 200 });

    map.elevation.set(3, 4, 123.5);
    map.slope.set(3, 4, 0.27);
    map.waterMask.set(8, 9, 1);
    map.landValue.set(5, 6, 0.81);
    map.railwayGrid.set(7, 3, 1);

    map.setLayer('elevation', map.elevation);
    map.setLayer('slope', map.slope);
    map.setLayer('waterMask', map.waterMask);
    map.setLayer('landValue', map.landValue);

    const horizontal = map.roadNetwork.add(
      [{ x: 100, z: 240 }, { x: 175, z: 240 }],
      { hierarchy: 'residential', source: 'fixture-test' },
    );
    const vertical = map.roadNetwork.add(
      [{ x: 140, z: 200 }, { x: 140, z: 275 }],
      { hierarchy: 'residential', source: 'fixture-test' },
    );
    map.roadNetwork.connectWaysAtPoint(horizontal.id, vertical.id, 140, 240);
    map.setLayer('roadGrid', map.roadNetwork.roadGrid);
    map.setLayer('bridgeGrid', map.roadNetwork.bridgeGrid);

    map.nuclei = [{ gx: 3, gz: 4, type: 'market' }];
    map.developmentZones = [{ id: 1, cells: [{ gx: 1, gz: 1 }, { gx: 1, gz: 2 }], boundary: [{ x: 100, z: 200 }] }];
    map.reservationZones = [{ zoneId: 1, type: 'commercial', cells: [{ gx: 1, gz: 1 }] }];
    map.growthState = {
      tick: 2,
      totalZoneCells: 2,
      nucleusRadii: new Map([[0, 12]]),
      claimedCounts: new Map([[1, 4]]),
      activeSeeds: new Map([['commercial', [{ gx: 2, gz: 2 }]]]),
    };
    map.seaLevel = 0;
    map.prevailingWindAngle = Math.PI / 4;
    map.settlement = { gx: 27, gz: 95, tier: 3 };
    map.regionalSettlements = [{ gx: 27, gz: 95, tier: 3, cityGx: 4, cityGz: 5 }];

    const dir = mkdtempSync(join(tmpdir(), 'feature-map-fixture-'));
    tempDirs.push(dir);
    const path = join(dir, 'seed-42-after-spatial');

    await saveMapFixture(map, path, {
      meta: {
        seed: 42,
        gx: 27,
        gz: 95,
        afterStep: 'spatial',
        lastStepId: 'spatial',
        stepCount: 6,
        archetypeId: 'marketTown',
        commitSha: 'abc123',
      },
    });

    const loaded = await loadMapFixture(path);

    expect(loaded.fixtureMeta.seed).toBe(42);
    expect(loaded.fixtureMeta.afterStep).toBe('spatial');
    expect(loaded.fixtureMeta.lastStepId).toBe('spatial');
    expect(loaded.fixtureMeta.stepCount).toBe(6);
    expect(loaded.fixtureMeta.archetypeId).toBe('marketTown');
    expect(loaded.fixtureMeta.commitSha).toBe('abc123');
    expect(loaded.elevation.get(3, 4)).toBeCloseTo(123.5);
    expect(loaded.slope.get(3, 4)).toBeCloseTo(0.27);
    expect(loaded.waterMask.get(8, 9)).toBe(1);
    expect(loaded.landValue.get(5, 6)).toBeCloseTo(0.81);
    expect(loaded.railwayGrid.get(7, 3)).toBe(1);
    expect(loaded.getLayer('roadGrid')).toBe(loaded.roadNetwork.roadGrid);
    expect(loaded.getLayer('bridgeGrid')).toBe(loaded.roadNetwork.bridgeGrid);

    expect(loaded.roadNetwork.wayCount).toBe(2);
    expect(loaded.roadNetwork.nodes.length).toBe(5);
    const sharedNode = loaded.roadNetwork.ways
      .flatMap(way => way.nodes)
      .find(node => node.x === 140 && node.z === 240);
    expect(sharedNode).toBeTruthy();
    expect(loaded.roadNetwork.graph.degree(sharedNode.id)).toBe(4);

    expect(loaded.nuclei).toEqual(map.nuclei);
    expect(loaded.developmentZones).toEqual(map.developmentZones);
    expect(loaded.reservationZones).toEqual(map.reservationZones);
    expect([...loaded.growthState.nucleusRadii.entries()]).toEqual([[0, 12]]);
    expect([...loaded.growthState.claimedCounts.entries()]).toEqual([[1, 4]]);
    expect([...loaded.growthState.activeSeeds.entries()]).toEqual([['commercial', [{ gx: 2, gz: 2 }]]]);
    expect(loaded.settlement).toEqual(map.settlement);
    expect(loaded.regionalSettlements).toEqual(map.regionalSettlements);
  });

  it('crops grids, roads, zones, and nuclei when requested', async () => {
    const map = new FeatureMap(16, 16, 10, { originX: 1000, originZ: 2000 });
    map.elevation = new Grid2D(16, 16, { type: 'float32', cellSize: 10, originX: 1000, originZ: 2000 });
    map.slope = new Grid2D(16, 16, { type: 'float32', cellSize: 10, originX: 1000, originZ: 2000 });
    map.waterMask = new Grid2D(16, 16, { type: 'uint8', cellSize: 10, originX: 1000, originZ: 2000 });

    for (let gz = 0; gz < 16; gz++) {
      for (let gx = 0; gx < 16; gx++) {
        map.elevation.set(gx, gz, gx + gz * 100);
      }
    }

    map.setLayer('elevation', map.elevation);
    map.setLayer('slope', map.slope);
    map.setLayer('waterMask', map.waterMask);

    map.roadNetwork.add(
      [{ x: 980, z: 2060 }, { x: 1160, z: 2060 }],
      { hierarchy: 'residential', source: 'fixture-test' },
    );
    map.roadNetwork.add(
      [{ x: 1060, z: 1980 }, { x: 1060, z: 2160 }],
      { hierarchy: 'residential', source: 'fixture-test' },
    );
    map.setLayer('roadGrid', map.roadNetwork.roadGrid);
    map.setLayer('bridgeGrid', map.roadNetwork.bridgeGrid);

    map.rivers = [{
      id: 'river-a',
      polyline: [
        { x: 960, z: 2080, width: 8 },
        { x: 1180, z: 2080, width: 8 },
      ],
    }];
    map.nuclei = [
      { gx: 6, gz: 6, type: 'market' },
      { gx: 13, gz: 13, type: 'edge' },
    ];
    map.developmentZones = [
      {
        id: 7,
        cells: [{ gx: 5, gz: 5 }, { gx: 6, gz: 5 }, { gx: 7, gz: 5 }, { gx: 7, gz: 6 }],
        boundary: [{ x: 1050, z: 2050 }, { x: 1080, z: 2060 }],
        centroidGx: 6.25,
        centroidGz: 5.25,
        boundingNodeIds: [1, 2],
        boundingEdgeIds: [3],
      },
      {
        id: 8,
        cells: [{ gx: 13, gz: 13 }, { gx: 14, gz: 13 }],
        centroidGx: 13.5,
        centroidGz: 13,
      },
    ];
    map.reservationZones = [
      { zoneId: 7, type: 'commercial', cells: [{ gx: 6, gz: 5 }] },
      { zoneId: 8, type: 'industrial', cells: [{ gx: 14, gz: 13 }] },
    ];
    map.growthState = {
      tick: 3,
      totalZoneCells: 6,
      nucleusRadii: new Map([[0, 10]]),
      claimedCounts: new Map([[7, 4]]),
      activeSeeds: new Map([
        ['commercial', [{ gx: 6, gz: 5 }, { gx: 14, gz: 13 }]],
      ]),
    };

    const dir = mkdtempSync(join(tmpdir(), 'feature-map-fixture-crop-'));
    tempDirs.push(dir);
    const path = join(dir, 'seed-42-after-spatial-crop');

    await saveMapFixture(map, path, {
      crop: {
        source: 'zone',
        zoneId: 7,
        zoneIndex: 0,
        margin: 1,
        minGx: 4,
        minGz: 4,
        maxGx: 8,
        maxGz: 8,
      },
      meta: { seed: 42, gx: 27, gz: 95, afterStep: 'spatial' },
    });

    const loaded = await loadMapFixture(path);

    expect(loaded.width).toBe(5);
    expect(loaded.height).toBe(5);
    expect(loaded.originX).toBe(1040);
    expect(loaded.originZ).toBe(2040);
    expect(loaded.fixtureMeta.crop).toMatchObject({
      minGx: 4,
      minGz: 4,
      maxGx: 8,
      maxGz: 8,
      source: 'zone',
      zoneId: 7,
    });

    expect(loaded.elevation.get(0, 0)).toBe(404);
    expect(loaded.elevation.get(2, 1)).toBe(506);

    expect(loaded.roadNetwork.wayCount).toBe(2);
    expect(loaded.roadNetwork.ways[0].polyline[0].z).toBeCloseTo(2060);
    expect(loaded.roadNetwork.ways[1].polyline[0].x).toBeCloseTo(1060);

    expect(loaded.rivers).toHaveLength(1);
    expect(loaded.rivers[0].polyline[0].x).toBeCloseTo(1035);
    expect(loaded.rivers[0].polyline.at(-1).x).toBeCloseTo(1085);

    expect(loaded.nuclei).toEqual([{ gx: 2, gz: 2, type: 'market' }]);
    expect(loaded.developmentZones).toHaveLength(1);
    expect(loaded.developmentZones[0].id).toBe(7);
    expect(loaded.developmentZones[0].cells).toEqual([
      { gx: 1, gz: 1 },
      { gx: 2, gz: 1 },
      { gx: 3, gz: 1 },
      { gx: 3, gz: 2 },
    ]);
    expect(loaded.developmentZones[0].centroidGx).toBeCloseTo(2.25);
    expect(loaded.developmentZones[0].centroidGz).toBeCloseTo(1.25);
    expect(loaded.developmentZones[0].boundingNodeIds).toBeUndefined();
    expect(loaded.reservationZones).toEqual([
      { zoneId: 7, type: 'commercial', cells: [{ gx: 2, gz: 1 }] },
    ]);
    expect([...loaded.growthState.activeSeeds.entries()]).toEqual([
      ['commercial', [{ gx: 2, gz: 1 }]],
    ]);
    expect(loaded.growthState.totalZoneCells).toBe(4);
  });
});
