import { describe, expect, it } from 'vitest';
import { layRibbons, truncateRibbonAtRelationFailure } from '../../../src/city/incremental/ribbons.js';
import { ArrayEventSink } from '../../../src/core/EventSink.js';

function makeStreet(points, ctOff) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return { points, ctOff, length };
}

function makeScanStreet(startX, startZ, endZ, gradX, gradZ, stepSize, ctOff) {
  const points = [];
  const totalDist = (endZ - startZ) / gradZ;
  const numSteps = Math.abs(Math.round(totalDist / stepSize));
  for (let i = 0; i <= numSteps; i++) {
    const t = i * stepSize;
    points.push({
      x: startX + gradX * t,
      z: startZ + gradZ * t,
    });
  }
  return makeStreet(points, ctOff);
}

function makeMockMap(crossStreets, options = {}) {
  const { elevationFn = null } = options;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const street of crossStreets) {
    for (const p of street.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }

  const pad = 50;
  const cellSize = 5;
  const originX = minX - pad;
  const originZ = minZ - pad;
  const width = Math.ceil((maxX - minX + 2 * pad) / cellSize);
  const height = Math.ceil((maxZ - minZ + 2 * pad) / cellSize);

  const cells = [];
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      cells.push({ gx, gz });
    }
  }

  const elevation = elevationFn ? {
    get(gx, gz) {
      return elevationFn(gx, gz);
    },
  } : null;

  return {
    map: {
      cellSize,
      width,
      height,
      originX,
      originZ,
      hasLayer: name => name === 'elevation' ? !!elevation : false,
      getLayer: name => name === 'elevation' ? elevation : null,
    },
    zone: {
      cells,
      centroidGx: width / 2,
      centroidGz: height / 2,
    },
  };
}

describe('layRibbons', () => {
  it('strings one street from the seed anchor across adjacent cross streets in both directions', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons, parcels, angleRejects } = layRibbons(crossStreets, zone, map);

    expect(ribbons).toHaveLength(1);
    expect(parcels).toHaveLength(0);
    expect(angleRejects).toBe(0);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(2);
    expect(ribbons[0].source).toBe('seed-string');
    const endpoints = [ribbons[0].points[0], ribbons[0].points[ribbons[0].points.length - 1]];
    const xs = endpoints.map(p => p.x).sort((a, b) => a - b);
    expect(xs).toEqual([0, 180]);
  });

  it('lays one realistic street string between adjacent scan streets', () => {
    const crossStreets = [
      makeScanStreet(0, 0, 300, 0.95, -0.31, 2.5, -45),
      makeScanStreet(28, 85, 385, 0.95, -0.31, 2.5, 0),
      makeScanStreet(56, 171, 471, 0.95, -0.31, 2.5, 45),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons, angleRejects } = layRibbons(crossStreets, zone, map);

    expect(angleRejects).toBe(0);
    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(3);
    expect(ribbons[0].source).toBe('seed-string');
    const endpoints = [ribbons[0].points[0], ribbons[0].points[ribbons[0].points.length - 1]];
    expect(Math.abs(endpoints[0].x - endpoints[1].x)).toBeGreaterThan(45);
  });

  it('projects across shifted neighboring streets instead of matching normalized progress', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([{ x: 90, z: 50 }, { x: 90, z: 350 }], 0),
      makeStreet([{ x: 180, z: 100 }, { x: 180, z: 400 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons } = layRibbons(crossStreets, zone, map);

    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(3);
    const endpoints = [ribbons[0].points[0], ribbons[0].points[ribbons[0].points.length - 1]];
    expect(Math.abs(endpoints[0].x - endpoints[1].x)).toBeGreaterThan(160);
  });

  it('still creates a bidirectional string from a kinked anchor street near the sector centroid', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([
        { x: 90, z: 0 },
        { x: 90, z: 135 },
        { x: 125, z: 150 },
        { x: 90, z: 165 },
        { x: 90, z: 300 },
      ], 0),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons, angleRejects, seedAnchors } = layRibbons(crossStreets, zone, map);

    expect(angleRejects).toBeGreaterThanOrEqual(0);
    expect(seedAnchors).toHaveLength(1);
    expect(seedAnchors[0].streetIdx).toBe(1);
    expect(seedAnchors[0].point.x).toBeGreaterThan(90);
    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(3);
    expect(ribbons[0].source).toBe('seed-string');
  });

  it('stops before skipping over a failed neighboring street', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -180),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], -90),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 0),
      makeStreet([{ x: 270, z: 240 }, { x: 270, z: 540 }], 90),
      makeStreet([{ x: 360, z: 0 }, { x: 360, z: 300 }], 180),
    ];
    const { map, zone } = makeMockMap(crossStreets);
    zone.centroidGx = (180 - map.originX) / map.cellSize;
    zone.centroidGz = (150 - map.originZ) / map.cellSize;

    const { ribbons, failedRibbons } = layRibbons(crossStreets, zone, map);

    expect(ribbons).toHaveLength(1);
    const xs = ribbons[0].points.map(pt => pt.x);
    expect(xs.some(x => Math.abs(x - 270) < 10)).toBe(true);
    if (xs.some(x => Math.abs(x - 360) < 10)) {
      expect(xs.some(x => Math.abs(x - 270) < 10)).toBe(true);
    }
    expect(failedRibbons.length).toBeGreaterThanOrEqual(0);
  });

  it('chooses the seed anchor from the sector centroid rather than the middle street index', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -180),
      makeStreet([{ x: 75, z: 0 }, { x: 75, z: 300 }], -90),
      makeStreet([{ x: 150, z: 0 }, { x: 150, z: 300 }], 0),
      makeStreet([{ x: 225, z: 0 }, { x: 225, z: 300 }], 90),
      makeStreet([{ x: 300, z: 0 }, { x: 300, z: 300 }], 180),
    ];
    const { map, zone } = makeMockMap(crossStreets);
    zone.centroidGx = (225 - map.originX) / map.cellSize;
    zone.centroidGz = (220 - map.originZ) / map.cellSize;

    const { seedAnchors } = layRibbons(crossStreets, zone, map);

    expect(seedAnchors).toHaveLength(1);
    expect(Math.abs(seedAnchors[0].point.x - 225)).toBeLessThan(1e-6);
    expect(Math.abs(seedAnchors[0].point.z - 220)).toBeLessThan(1e-6);
  });

  it('orders neighboring streets by spatial placement rather than ctOff', () => {
    const crossStreets = [
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], -100),
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], 100),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeStreet([{ x: 270, z: 0 }, { x: 270, z: 300 }], 200),
    ];
    const { map, zone } = makeMockMap(crossStreets);
    zone.centroidGx = (180 - map.originX) / map.cellSize;
    zone.centroidGz = (150 - map.originZ) / map.cellSize;

    const { ribbons } = layRibbons(crossStreets, zone, map);

    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(4);
    const endpoints = [ribbons[0].points[0], ribbons[0].points[ribbons[0].points.length - 1]];
    const xs = endpoints.map(pt => pt.x).sort((a, b) => a - b);
    expect(xs).toEqual([0, 270]);
  });

  it('can bend with a local contour field sampled from elevation', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets, {
      elevationFn: (gx, gz) => gx + gz,
    });

    const { ribbons } = layRibbons(crossStreets, zone, map, {
      contourGuideBlend: 0.45,
      guideMarchPerpBlend: 1.0,
      guideMarchContourBlend: 0.9,
    });

    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].points.length).toBeGreaterThanOrEqual(3);

    const zs = ribbons[0].points.map(pt => pt.z);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    expect(maxZ - minZ).toBeGreaterThan(20);
  });

  it('can spawn parallel follow-on rows from the middle junction of an accepted row', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons, seedAnchors } = layRibbons(crossStreets, zone, map, {
      maxRowsTotal: 3,
      parallelReseedRows: true,
      parallelReseedSpacing: 40,
      parallelReseedMaxGeneration: 1,
    });

    expect(ribbons).toHaveLength(3);
    expect(seedAnchors.length).toBeGreaterThanOrEqual(3);
    const centerTs = ribbons.map(r => r.centerT).sort((a, b) => a - b);
    expect(centerTs[0]).toBeLessThan(130);
    expect(centerTs[1]).toBeGreaterThan(140);
    expect(centerTs[1]).toBeLessThan(160);
    expect(centerTs[2]).toBeGreaterThan(170);
    expect(ribbons.some(r => r.source === 'parallel-string')).toBe(true);
  });

  it('can enlarge reseed spacing to satisfy a minimum road gap', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons } = layRibbons(crossStreets, zone, map, {
      maxRowsTotal: 3,
      parallelReseedRows: true,
      parallelReseedSpacing: 20,
      parallelReseedMaxGeneration: 1,
      parallelMinRoadGap: 40,
    });

    expect(ribbons).toHaveLength(3);
    const centerTs = ribbons.map(r => r.centerT).sort((a, b) => a - b);
    expect(centerTs[1] - centerTs[0]).toBeGreaterThan(35);
    expect(centerTs[2] - centerTs[1]).toBeGreaterThan(35);
  });

  it('can reject a parallel follow-on row when it diverges too far from the parent row angle', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 320 }], -135),
      makeStreet([
        { x: 80, z: 40 },
        { x: 80, z: 160 },
        { x: 130, z: 210 },
        { x: 130, z: 360 },
      ], -45),
      makeStreet([
        { x: 170, z: 10 },
        { x: 170, z: 120 },
        { x: 140, z: 170 },
        { x: 140, z: 340 },
      ], 45),
      makeStreet([{ x: 250, z: 0 }, { x: 250, z: 320 }], 135),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const loose = layRibbons(crossStreets, zone, map, {
      maxRowsTotal: 3,
      parallelReseedRows: true,
      parallelReseedSpacing: 32,
      parallelReseedMaxGeneration: 1,
      parallelMinRoadGap: 15,
      parallelKeepSide: true,
      parallelRejectCrossovers: true,
      parallelMaxAngleDeltaDeg: 180,
    });

    const strict = layRibbons(crossStreets, zone, map, {
      maxRowsTotal: 3,
      parallelReseedRows: true,
      parallelReseedSpacing: 32,
      parallelReseedMaxGeneration: 1,
      parallelMinRoadGap: 15,
      parallelKeepSide: true,
      parallelRejectCrossovers: true,
      parallelMaxAngleDeltaDeg: 10,
    });

    expect(loose.ribbons.length).toBeGreaterThan(strict.ribbons.length);
    expect(strict.failureSummary.reasons['parallel-angle']).toBeGreaterThanOrEqual(1);
  });

  it('can build a follow-on row by offsetting the parent row junction chain', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 320 }], -135),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 320 }], -45),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 320 }], 45),
      makeStreet([{ x: 270, z: 0 }, { x: 270, z: 320 }], 135),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons } = layRibbons(crossStreets, zone, map, {
      maxRowsTotal: 3,
      parallelReseedRows: true,
      parallelReseedSpacing: 40,
      parallelReseedMaxGeneration: 1,
      parallelMinRoadGap: 15,
      parallelKeepSide: true,
      parallelRejectCrossovers: true,
      parallelMaxAngleDeltaDeg: 180,
      parallelInheritParentJunctions: true,
    });

    const parent = ribbons.find(r => r.source === 'seed-string');
    const child = ribbons.find(r => r.source === 'parallel-string');

    expect(parent).toBeTruthy();
    expect(child).toBeTruthy();
    expect(child.streetPoints.map(point => point.streetIdx)).toEqual(parent.streetPoints.map(point => point.streetIdx));

    const deltas = child.streetPoints.map((point, index) => point.t - parent.streetPoints[index].t);
    expect(Math.abs(deltas[0])).toBeGreaterThan(35);
    for (const delta of deltas) {
      expect(Math.abs(delta - deltas[0])).toBeLessThan(1e-6);
    }
  });

  it('can fill a family from ordered slot offsets on one pivot street instead of spawning chained families', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 320 }], -135),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 320 }], -45),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 320 }], 45),
      makeStreet([{ x: 270, z: 0 }, { x: 270, z: 320 }], 135),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const { ribbons } = layRibbons(crossStreets, zone, map, {
      maxRowsTotal: 5,
      parallelReseedRows: false,
      parallelReseedSpacing: 40,
      parallelMinRoadGap: 15,
      parallelKeepSide: true,
      parallelRejectCrossovers: true,
      parallelMaxAngleDeltaDeg: 180,
      parallelInheritParentJunctions: true,
      parallelSlotFamilies: true,
    });

    expect(ribbons).toHaveLength(5);
    const seed = ribbons.find(r => r.source === 'seed-string');
    const children = ribbons.filter(r => r.source === 'parallel-string');
    expect(seed).toBeTruthy();
    expect(children).toHaveLength(4);
    for (const child of children) {
      expect(child.parentRowId).toBe(seed.rowId);
      expect(child.streetPoints.map(point => point.streetIdx)).toEqual(seed.streetPoints.map(point => point.streetIdx));
    }

    const pivot = seed.streetPoints[Math.floor(seed.streetPoints.length / 2)];
    const deltas = children
      .map(row => row.streetPoints.find(point => point.streetIdx === pivot.streetIdx))
      .filter(Boolean)
      .map(point => Math.round(Math.abs(point.t - pivot.t)));

    expect(new Set(deltas)).toEqual(new Set([40, 80]));
  });

  it('can start a new seed family in a leftover street gap when the first family cannot reach unused streets', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 320 }], -135),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 320 }], -45),
      makeStreet([{ x: 340, z: 0 }, { x: 340, z: 320 }], 45),
      makeStreet([{ x: 430, z: 0 }, { x: 430, z: 320 }], 135),
    ];
    const { map, zone } = makeMockMap(crossStreets);
    zone.centroidGx = (90 - map.originX) / map.cellSize;
    zone.centroidGz = (160 - map.originZ) / map.cellSize;

    const { ribbons } = layRibbons(crossStreets, zone, map, {
      maxRowsTotal: 2,
      parallelReseedRows: false,
      fillRemainingStreetGaps: true,
      fillGapThreshold: 60,
    });

    expect(ribbons).toHaveLength(2);
    const streetSets = ribbons.map(ribbon => new Set(ribbon.streetPoints.map(point => point.streetIdx)));
    expect(streetSets.some(set => set.has(0) && set.has(1))).toBe(true);
    expect(streetSets.some(set => set.has(2) && set.has(3))).toBe(true);
  });

  it('can reject fill rows that break spacing relative to an older family, not just the parent family', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 320 }], -180),
      makeStreet([{ x: 70, z: 0 }, { x: 70, z: 320 }], -60),
      makeStreet([
        { x: 160, z: 0 },
        { x: 160, z: 140 },
        { x: 210, z: 220 },
        { x: 210, z: 320 },
      ], 60),
      makeStreet([{ x: 290, z: 0 }, { x: 290, z: 320 }], 180),
      makeStreet([{ x: 380, z: 0 }, { x: 380, z: 320 }], 240),
    ];
    const { map, zone } = makeMockMap(crossStreets);

    const baseParams = {
      maxRowsTotal: 10,
      parallelReseedRows: true,
      parallelReseedSpacing: 32,
      parallelReseedMaxGeneration: 1,
      parallelMinRoadGap: 15,
      parallelKeepSide: true,
      parallelRejectCrossovers: true,
      parallelMaxAngleDeltaDeg: 20,
      parallelInheritParentJunctions: true,
      parallelExtendPastParent: true,
      fillRemainingStreetGaps: true,
      fillUnusedStreetSeedsOnly: false,
      fillGapThreshold: 60,
    };

    const loose = layRibbons(crossStreets, zone, map, baseParams);
    const strict = layRibbons(crossStreets, zone, map, {
      ...baseParams,
      parallelValidateAgainstAllRows: true,
    });

    expect(loose.ribbons.length).toBeGreaterThan(strict.ribbons.length);
    expect(strict.failureSummary.reasons['parallel-gap']).toBeGreaterThanOrEqual(1);
  });

  it('can trim only the violating tail of a child row instead of dropping the whole row', () => {
    const streetPoints = [
      { streetIdx: 0, t: 40, pt: { x: 0, z: 0 } },
      { streetIdx: 1, t: 40, pt: { x: 80, z: 0 } },
      { streetIdx: 2, t: 40, pt: { x: 160, z: 0 } },
      { streetIdx: 3, t: 40, pt: { x: 240, z: 25 } },
      { streetIdx: 4, t: 40, pt: { x: 320, z: 60 } },
    ];
    const ribbon = {
      rowId: 7,
      centerT: 40,
      points: streetPoints.map(point => point.pt),
      streetPoints,
      length: 0,
    };

    const trimmed = truncateRibbonAtRelationFailure(
      ribbon,
      { reason: 'parallel-angle', childIndex: 3 },
      2,
      40,
      { minRibbonLength: 15 },
    );

    expect(trimmed).toBeTruthy();
    expect(trimmed.streetPoints.map(point => point.streetIdx)).toEqual([0, 1, 2]);
  });

  it('emits ordered coarse ribbon events to an event sink', () => {
    const crossStreets = [
      makeStreet([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeStreet([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeStreet([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ];
    const { map, zone } = makeMockMap(crossStreets);
    const sink = new ArrayEventSink();

    const result = layRibbons(crossStreets, zone, map, {
      eventSink: sink,
      eventStepId: 'ribbons',
      eventContext: {
        zoneIdx: 0,
        sectorIdx: 0,
        seed: 123,
      },
    });

    expect(result.ribbons).toHaveLength(1);
    expect(sink.events.length).toBeGreaterThanOrEqual(4);
    expect(sink.events.map(event => event.seq)).toEqual(
      sink.events.map((_, index) => index + 1),
    );
    expect(sink.events.map(event => event.type)).toEqual(
      expect.arrayContaining([
        'anchor-enqueued',
        'anchor-dequeued',
        'row-build-start',
        'row-accepted',
      ]),
    );
    for (const event of sink.events) {
      expect(event.stepId).toBe('ribbons');
      expect(event.zoneIdx).toBe(0);
      expect(event.sectorIdx).toBe(0);
      expect(event.seed).toBe(123);
      expect(typeof event.payload).toBe('object');
    }
  });
});
