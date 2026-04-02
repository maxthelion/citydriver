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
      meta: { seed: 42, gx: 27, gz: 95, afterStep: 'spatial' },
    });

    const loaded = await loadMapFixture(path);

    expect(loaded.fixtureMeta.seed).toBe(42);
    expect(loaded.fixtureMeta.afterStep).toBe('spatial');
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
});
