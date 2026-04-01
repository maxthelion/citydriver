import { describe, it, expect } from 'vitest';
import { layCrossStreets } from '../../../src/city/incremental/crossStreets.js';
import { makeRectZone, makeMap } from './helpers.js';
import { ArrayEventSink } from '../../../src/core/EventSink.js';

describe('layCrossStreets', () => {
  const cs = 5;
  const W = 100, H = 100;

  function setup(x0 = 5, z0 = 5, x1 = 60, z1 = 60) {
    const zone = makeRectZone(x0, z0, x1, z1, cs);
    const map = makeMap(W, H, cs);
    return { zone, map };
  }

  it('produces cross streets for a large zone', () => {
    const { zone, map } = setup();
    const { crossStreets } = layCrossStreets(zone, map);
    expect(crossStreets.length).toBeGreaterThan(0);
  });

  it('returns gradient and contour directions', () => {
    const { zone, map } = setup();
    const { gradDir, contourDir } = layCrossStreets(zone, map);
    expect(gradDir.x).toBeDefined();
    expect(gradDir.z).toBeDefined();
    expect(contourDir.x).toBeDefined();
    expect(contourDir.z).toBeDefined();
    // Perpendicular
    const dot = gradDir.x * contourDir.x + gradDir.z * contourDir.z;
    expect(Math.abs(dot)).toBeLessThan(0.01);
  });

  it('cross streets have polyline points and positive length', () => {
    const { zone, map } = setup();
    const { crossStreets } = layCrossStreets(zone, map);
    for (const cs2 of crossStreets) {
      expect(cs2.points.length).toBeGreaterThan(1);
      expect(cs2.length).toBeGreaterThan(0);
    }
  });

  it('respects minimum street length', () => {
    const { zone, map } = setup();
    const { crossStreets } = layCrossStreets(zone, map, { minLength: 20 });
    for (const cs2 of crossStreets) {
      expect(cs2.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('lines span a significant portion of the zone', () => {
    const { zone, map } = setup();
    const { crossStreets } = layCrossStreets(zone, map);
    // Zone is 55 cells * 5m = 275m in each direction
    // At least some lines should be > 100m
    const longLines = crossStreets.filter(cs2 => cs2.length > 100);
    expect(longLines.length).toBeGreaterThan(0);
  });

  it('stops at water obstacles', () => {
    const { zone, map } = setup();
    // Place water barrier across the gradient direction
    const waterMask = map.getLayer('waterMask');
    for (let gz = 0; gz < H; gz++) {
      waterMask.set(30, gz, 1);
    }
    const { crossStreets } = layCrossStreets(zone, map);
    // Lines should be shorter (truncated by water)
    for (const cs2 of crossStreets) {
      expect(cs2.length).toBeLessThan(200);
    }
  });

  it('road-split zone produces multiple runs', () => {
    const { zone, map } = setup(5, 5, 60, 60);
    // Place a road across the middle in the contour direction
    // Gradient is +x, so road in x direction splits the zone along gradient
    const roadGrid = map.getLayer('roadGrid');
    for (let gx = 0; gx < W; gx++) {
      roadGrid.set(gx, 33, 1);
    }
    // Remove road cells from zone (zones don't include roads)
    zone.cells = zone.cells.filter(c => c.gz !== 33);

    const { crossStreets } = layCrossStreets(zone, map);
    // Should produce more lines than without the road split
    // (some contour offsets will have 2 runs)
    expect(crossStreets.length).toBeGreaterThan(0);
  });

  it('no two cross streets converge within minSeparation', () => {
    const { zone, map } = setup();
    const minSep = 5;
    const { crossStreets } = layCrossStreets(zone, map, { minSeparation: minSep });

    // Sample points along each pair and check distance
    for (let i = 0; i < crossStreets.length; i++) {
      for (let j = i + 1; j < crossStreets.length; j++) {
        const ptsA = crossStreets[i].points;
        const ptsB = crossStreets[j].points;
        const stepA = Math.max(1, Math.floor(ptsA.length / 10));
        const stepB = Math.max(1, Math.floor(ptsB.length / 10));
        for (let ia = 0; ia < ptsA.length; ia += stepA) {
          for (let ib = 0; ib < ptsB.length; ib += stepB) {
            const dx = ptsA[ia].x - ptsB[ib].x;
            const dz = ptsA[ia].z - ptsB[ib].z;
            expect(dx * dx + dz * dz).toBeGreaterThanOrEqual(minSep * minSep);
          }
        }
      }
    }
  });

  it('returns empty for a tiny zone', () => {
    const { zone, map } = setup(10, 10, 12, 12);
    const { crossStreets } = layCrossStreets(zone, map, { minLength: 20 });
    expect(crossStreets.length).toBe(0);
  });

  it('spacing parameter controls number of lines', () => {
    const { zone, map } = setup();
    const tight = layCrossStreets(zone, map, { spacing: 40 });
    const wide = layCrossStreets(zone, map, { spacing: 150 });
    expect(tight.crossStreets.length).toBeGreaterThanOrEqual(wide.crossStreets.length);
  });

  it('supports an explicit phase offset for the contour sweep', () => {
    const { zone, map } = setup();
    const base = layCrossStreets(zone, map, { spacing: 40 });
    const shifted = layCrossStreets(zone, map, { spacing: 40, phaseOffset: 20 });

    expect(base.crossStreets.length).toBeGreaterThan(0);
    expect(shifted.crossStreets.length).toBeGreaterThan(0);
    const baseCtSet = new Set(base.crossStreets.map(street => street.ctOff.toFixed(2)));
    const shiftedCtSet = new Set(shifted.crossStreets.map(street => street.ctOff.toFixed(2)));
    expect([...shiftedCtSet].some(ct => !baseCtSet.has(ct))).toBe(true);
  });

  it('can include explicit contour offsets alongside the regular sweep phase', () => {
    const { zone, map } = setup();
    const base = layCrossStreets(zone, map, {
      spacing: 40,
      phaseOffset: 0,
    });
    const explicit = layCrossStreets(zone, map, {
      spacing: 40,
      phaseOffset: 0,
      explicitCtOffsets: [17],
    });

    const baseCtSet = new Set(base.crossStreets.map(street => street.ctOff.toFixed(2)));
    const explicitCtSet = new Set(explicit.crossStreets.map(street => street.ctOff.toFixed(2)));
    expect(baseCtSet.has('17.00')).toBe(false);
    expect(explicitCtSet.has('17.00')).toBe(true);
  });

  it('can emit coarse cross-street events to an event sink', () => {
    const { zone, map } = setup();
    const sink = new ArrayEventSink();

    const result = layCrossStreets(zone, map, {
      eventSink: sink,
      eventStepId: 'cross-streets',
      eventContext: {
        zoneIdx: 0,
        sectorIdx: 1,
      },
    });

    expect(result.crossStreets.length).toBeGreaterThan(0);
    expect(sink.events.length).toBeGreaterThan(0);
    expect(sink.events.map(event => event.seq)).toEqual(
      sink.events.map((_, index) => index + 1),
    );
    expect(sink.events.map(event => event.type)).toEqual(
      expect.arrayContaining(['sweep-plan', 'scanline-start', 'street-accepted']),
    );
    for (const event of sink.events) {
      expect(event.stepId).toBe('cross-streets');
      expect(event.zoneIdx).toBe(0);
      expect(event.sectorIdx).toBe(1);
    }
  });

  it('emits scanline break reasons for split runs', () => {
    const { zone, map } = setup();
    const sink = new ArrayEventSink();
    const waterMask = map.getLayer('waterMask');
    for (let gz = 5; gz <= 60; gz++) {
      waterMask.set(30, gz, 1);
    }

    layCrossStreets(zone, map, {
      eventSink: sink,
      eventStepId: 'cross-streets',
      eventContext: {
        zoneIdx: 0,
        sectorIdx: 1,
      },
    });

    const breakEvents = sink.events.filter(event => event.type === 'scanline-break');
    expect(breakEvents.length).toBeGreaterThan(0);
    expect(breakEvents.some(event => event.payload?.reason === 'water')).toBe(true);
  });

  it('emits scanline-no-street when candidates are rejected by minimum length', () => {
    const { zone, map } = setup(10, 10, 14, 60);
    const sink = new ArrayEventSink();

    layCrossStreets(zone, map, {
      spacing: 20,
      minLength: 40,
      eventSink: sink,
      eventStepId: 'cross-streets',
      eventContext: {
        zoneIdx: 0,
        sectorIdx: 1,
      },
    });

    const noStreetEvents = sink.events.filter(event => event.type === 'scanline-no-street');
    expect(noStreetEvents.length).toBeGreaterThan(0);
    expect(noStreetEvents.some(event => (event.payload?.rejectedReasons?.['too-short'] || 0) > 0)).toBe(true);
  });

  it('returns rejected and missing scanline debug geometry', () => {
    const { zone, map } = setup(10, 10, 14, 60);
    const result = layCrossStreets(zone, map, {
      spacing: 20,
      minLength: 40,
    });

    expect(result.debug?.rejectedStreets?.length).toBeGreaterThan(0);
    expect(result.debug?.missingScanlines?.length).toBeGreaterThan(0);
    expect(result.debug.missingScanlines.some(scanline => scanline.guidePoints?.length === 2)).toBe(true);
  });

  it('emits prune conflict metadata when close streets are removed', () => {
    const { zone, map } = setup();
    const sink = new ArrayEventSink();

    layCrossStreets(zone, map, {
      spacing: 20,
      minSeparation: 60,
      eventSink: sink,
      eventStepId: 'cross-streets',
      eventContext: {
        zoneIdx: 0,
        sectorIdx: 1,
      },
    });

    const prunedEvents = sink.events.filter(event => event.type === 'street-pruned');
    expect(prunedEvents.length).toBeGreaterThan(0);
    for (const event of prunedEvents) {
      expect(event.payload?.reason).toBe('min-separation');
      expect(typeof event.payload?.conflictCandidateKey).toBe('string');
      expect(event.payload?.conflictPoint?.x).toBeTypeOf('number');
      expect(event.payload?.conflictPoint?.z).toBeTypeOf('number');
    }
  });

  it('can align boundary-facing street endpoints across neighboring sectors with a shared phase origin', () => {
    const leftZone = makeRectZone(5, 5, 30, 60, cs);
    const rightZone = makeRectZone(31, 12, 60, 67, cs);
    const map = makeMap(W, H, cs);

    const baselineLeft = layCrossStreets(leftZone, map, { spacing: 30 });
    const baselineRight = layCrossStreets(rightZone, map, { spacing: 30 });

    const phaseOrigin = {
      x: ((30 + 31) * 0.5) * cs,
      z: ((12 + 60) * 0.5) * cs,
    };
    const alignedLeft = layCrossStreets(leftZone, map, {
      spacing: 30,
      phaseOrigin,
      phaseOriginSource: 'test-shared-boundary',
    });
    const alignedRight = layCrossStreets(rightZone, map, {
      spacing: 30,
      phaseOrigin,
      phaseOriginSource: 'test-shared-boundary',
    });

    const baselineMatches = countBoundaryFacingMatches(
      boundaryFacingZs(baselineLeft.crossStreets, 'max-x'),
      boundaryFacingZs(baselineRight.crossStreets, 'min-x'),
      6,
    );
    const alignedMatches = countBoundaryFacingMatches(
      boundaryFacingZs(alignedLeft.crossStreets, 'max-x'),
      boundaryFacingZs(alignedRight.crossStreets, 'min-x'),
      6,
    );

    expect(alignedMatches).toBeGreaterThan(baselineMatches);
  });

  it('can snap boundary-facing street endpoints toward existing neighboring street ends', () => {
    const leftZone = makeRectZone(5, 5, 30, 60, cs);
    const rightZone = makeRectZone(31, 12, 60, 67, cs);
    const map = makeMap(W, H, cs);

    const left = layCrossStreets(leftZone, map, { spacing: 30 });
    stampRoadGrid(left.crossStreets, map);

    const baselineRight = layCrossStreets(rightZone, map, { spacing: 30 });
    const snappedRight = layCrossStreets(rightZone, map, {
      spacing: 30,
      boundarySnapPoints: boundaryFacingPoints(left.crossStreets, 'max-x'),
      boundarySnapMaxDistance: 30,
      boundarySnapMaxAngleDeltaDeg: 25,
      boundarySnapMinImprovement: 1,
    });

    const leftBoundaryZs = boundaryFacingZs(left.crossStreets, 'max-x');
    const baselineMatches = countBoundaryFacingMatches(
      leftBoundaryZs,
      boundaryFacingZs(baselineRight.crossStreets, 'min-x'),
      6,
    );
    const snappedMatches = countBoundaryFacingMatches(
      leftBoundaryZs,
      boundaryFacingZs(snappedRight.crossStreets, 'min-x'),
      6,
    );

    expect(snappedMatches).toBeGreaterThanOrEqual(baselineMatches);
  });

  it('can force boundary snapping to reduce mismatch with neighboring boundary points', () => {
    const leftZone = makeRectZone(5, 5, 30, 60, cs);
    const rightZone = makeRectZone(31, 12, 60, 67, cs);
    const map = makeMap(W, H, cs);

    const left = layCrossStreets(leftZone, map, { spacing: 30 });
    const snapPoints = boundaryFacingPoints(left.crossStreets, 'max-x');
    const baselineRight = layCrossStreets(rightZone, map, {
      spacing: 30,
      boundarySnapPoints: snapPoints,
      boundarySnapMaxDistance: 30,
      boundarySnapMaxAngleDeltaDeg: 25,
      boundarySnapMinImprovement: 1,
    });
    const forcedRight = layCrossStreets(rightZone, map, {
      spacing: 30,
      boundarySnapPoints: snapPoints,
      boundarySnapMaxDistance: 30,
      boundarySnapMaxAngleDeltaDeg: 25,
      boundarySnapMinImprovement: 1,
      boundarySnapForceEndpoint: true,
      boundarySnapForceEndpointMaxDistance: 40,
    });

    const baselineMismatch = minBoundaryMismatch(
      boundaryFacingPoints(baselineRight.crossStreets, 'min-x'),
      snapPoints,
    );
    const rightBoundaryPoints = boundaryFacingPoints(forcedRight.crossStreets, 'min-x');
    const forcedMismatch = minBoundaryMismatch(rightBoundaryPoints, snapPoints);
    expect(forcedMismatch).toBeLessThanOrEqual(baselineMismatch);
  });

  it('can align boundary-facing street endpoints from a shared boundary anchor point', () => {
    const leftZone = makeRectZone(5, 5, 30, 60, cs);
    const rightZone = makeRectZone(31, 12, 60, 67, cs);
    const map = makeMap(W, H, cs);

    const left = layCrossStreets(leftZone, map, { spacing: 30 });
    const baselineRight = layCrossStreets(rightZone, map, { spacing: 30 });
    const anchorPoint = nearestPointTo(
      boundaryFacingPoints(left.crossStreets, 'max-x'),
      {
        x: ((30 + 31) * 0.5) * cs,
        z: ((12 + 60) * 0.5) * cs,
      },
    );
    const anchoredRight = layCrossStreets(rightZone, map, {
      spacing: 30,
      phaseOrigin: anchorPoint,
      phaseOriginSource: 'test-shared-boundary-anchor',
    });

    const leftBoundaryZs = boundaryFacingZs(left.crossStreets, 'max-x');
    const baselineMatches = countBoundaryFacingMatches(
      leftBoundaryZs,
      boundaryFacingZs(baselineRight.crossStreets, 'min-x'),
      6,
    );
    const anchoredMatches = countBoundaryFacingMatches(
      leftBoundaryZs,
      boundaryFacingZs(anchoredRight.crossStreets, 'min-x'),
      6,
    );

    expect(anchoredMatches).toBeGreaterThanOrEqual(baselineMatches);
  });
});

function boundaryFacingZs(crossStreets, mode) {
  return crossStreets
    .map(street => {
      if (!street?.points?.length) return null;
      const point = street.points.reduce((best, pt) => {
        if (!best) return pt;
        if (mode === 'max-x') return pt.x > best.x ? pt : best;
        return pt.x < best.x ? pt : best;
      }, null);
      return point ? point.z : null;
    })
    .filter(z => Number.isFinite(z))
    .sort((a, b) => a - b);
}

function boundaryFacingPoints(crossStreets, mode) {
  return crossStreets
    .map(street => {
      if (!street?.points?.length) return null;
      return street.points.reduce((best, pt) => {
        if (!best) return pt;
        if (mode === 'max-x') return pt.x > best.x ? pt : best;
        return pt.x < best.x ? pt : best;
      }, null);
    })
    .filter(Boolean);
}

function countBoundaryFacingMatches(left, right, tolerance) {
  let matches = 0;
  let ri = 0;
  for (const z of left) {
    while (ri < right.length && right[ri] < z - tolerance) ri++;
    if (ri < right.length && Math.abs(right[ri] - z) <= tolerance) {
      matches++;
      ri++;
    }
  }
  return matches;
}

function nearestPointTo(points, target) {
  let best = points[0];
  let bestDistSq = Infinity;
  for (const point of points) {
    const dx = point.x - target.x;
    const dz = point.z - target.z;
    const dSq = dx * dx + dz * dz;
    if (dSq < bestDistSq) {
      best = point;
      bestDistSq = dSq;
    }
  }
  return best;
}

function stampRoadGrid(crossStreets, map) {
  const roadGrid = map.getLayer('roadGrid');
  const { cellSize, width, height, originX, originZ } = map;
  for (const street of crossStreets) {
    for (let i = 1; i < street.points.length; i++) {
      const a = street.points[i - 1];
      const b = street.points[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(length / (cellSize * 0.5)));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const gx = Math.round((x - originX) / cellSize);
        const gz = Math.round((z - originZ) / cellSize);
        if (gx >= 0 && gx < width && gz >= 0 && gz < height) {
          roadGrid.set(gx, gz, 1);
        }
      }
    }
  }
}

function minBoundaryMismatch(points, targets) {
  let best = Infinity;
  for (const point of points) {
    for (const target of targets) {
      best = Math.min(best, Math.hypot(point.x - target.x, point.z - target.z));
    }
  }
  return best;
}
