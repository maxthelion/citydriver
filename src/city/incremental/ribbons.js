/**
 * Ribbons — contour-following streets built as chained street-to-street walks.
 *
 * The current experiment seeds near the sector centroid, then grows in both
 * perpendicular directions by repeatedly:
 * - launching from the exact junction created by the last step
 * - marching a guide with strong local perpendicular bias and a weak local
 *   contour pull from the terrain gradient field until it reaches a new cross
 *   street
 * - then choosing a sampled landing point only on that first-hit street
 *
 * There is intentionally no global street ordering or corridor index in the
 * active walk. Failures are still traced so the renderer can draw them.
 */

import { buildStreetIndexBitmap, lookupStreetIds } from './streetIndexBitmap.js';
import { buildGradientField } from './constructionLines.js';
import { EventSink } from '../../core/EventSink.js';

export function layRibbons(crossStreets, zone, map, params = {}) {
  const {
    eventSink = null,
    eventStepId = 'ribbons',
    eventContext = {},
    ...algoParams
  } = params;
  const p = {
    targetDepth: 35,
    minRibbonLength: 15,
    maxRibbonLength: 200,
    minParcelDepth: 15,
    fallbackMaxAngleOff: Math.PI / 3,
    searchStep: 5,
    maxRowsTotal: 1,
    initialSeedCount: 1,
    edgeMargin: 10,
    nearDuplicateFactor: 0.7,
    tangentSampleWindow: 25,
    tangentMode: 'whole-street-average',
    maxNeighborGuideAngleOff: 50 * Math.PI / 180,
    perpendicularGuideBlend: 1.0,
    contourGuideBlend: 0.24,
    continuationGuideBlend: 0.0,
    guideMarchStep: 2.5,
    guideMarchPerpBlend: 1.15,
    guideMarchContourBlend: 0.4,
    guideMarchContinuationBlend: 0.12,
    guideMarchTargetBlend: 0.95,
    guideMarchMaxFactor: 2.8,
    guideMarchMaxDistance: 220,
    streetIndexRadiusMeters: 5,
    streetSampleStep: 0,
    targetStreetGuideTolerance: 36,
    targetStreetElevationTolerance: 2.5,
    targetStreetElevationWeight: 10,
    targetStreetFallbackElevationWeight: 0.75,
    targetStreetAngleWeight: 18,
    targetStreetGuideWeight: 1.4,
    targetStreetDistanceWeight: 0.08,
    targetStreetLocalBand: 42,
    targetStreetLocalWeight: 0.2,
    landingRepairBand: 85,
    landingRepairGuideFactor: 1.5,
    landingRepairAngleFactor: 1.6,
    landingRepairDistanceFactor: 0.8,
    landingRepairLocalFactor: 0.8,
    parallelReseedRows: false,
    parallelReseedSpacing: 35,
    parallelReseedMaxGeneration: 2,
    parallelMinRoadGap: 0,
    parallelGapMinSin: 0.2,
    parallelKeepSide: false,
    parallelRejectCrossovers: false,
    parallelSideEpsilon: 2,
    parallelMaxAngleDeltaDeg: 180,
    parallelValidateAgainstAllRows: false,
    parallelGlobalCheckCross: true,
    parallelGlobalCheckGap: true,
    parallelGlobalCheckSide: true,
    parallelGlobalCheckAngle: true,
    parallelInheritParentJunctions: false,
    parallelExtendPastParent: false,
    parallelSlotFamilies: false,
    parallelInheritedMidpointGuide: false,
    parallelTruncateViolatingTail: false,
    gapSeedBorrowNearestRow: false,
    fillGapPreferUsedStreet: false,
    parallelInheritedTargetSearchRadius: 0,
    parallelInheritedTargetSearchStep: 0,
    parallelInheritedBaseOffsetWeight: 0.35,
    parallelInheritedParentDirWeight: 14,
    parallelInheritedTurnWeight: 16,
    parallelInheritedApproachWeight: 9,
    fillRemainingStreetGaps: false,
    fillUnusedStreetSeedsOnly: false,
    fillGapThreshold: 0,
    ...algoParams,
  };

  const cs = map.cellSize;
  const W = map.width;
  const H = map.height;
  const ox = map.originX;
  const oz = map.originZ;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;

  const zoneSet = new Set();
  for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

  if (crossStreets.length < 2) return emptyRibbonResult();

  const paramsByStreet = crossStreets.map(street => parameterise(street.points));
  if (!p.streetSampleStep || p.streetSampleStep <= 0) {
    p.streetSampleStep = Math.max(cs * 0.5, 2.5);
  }
  const gradField = buildGradientField(zone, map, zoneSet);
  const streetSampleProfiles = buildStreetSampleProfiles(paramsByStreet, map, p);
  const streetIndex = buildStreetIndexBitmap(crossStreets, map, {
    radiusMeters: p.streetIndexRadiusMeters,
    stepSize: p.guideMarchStep,
  });
  const seedPlan = chooseSeedStreetAndAnchor(paramsByStreet, zone, ox, oz, cs, p);
  const zoneContourDir = contourDirectionFromZone(zone);
  const ctx = createRibbonLayoutContext({
    paramsByStreet,
    streetSampleProfiles,
    zoneSet,
    waterMask,
    streetIndex,
    cs,
    W,
    H,
    ox,
    oz,
    gradField,
    zoneContourDir,
    p,
    eventSink,
    eventStepId,
    eventContext,
  });
  const state = createRibbonLayoutState(paramsByStreet);
  const { rows, rowsById, pendingAnchors, queuedAnchorKeys, usedTsByStreet } = state;
  const failedRibbons = [];
  const failureCounts = {};
  const seedAnchors = [];
  let angleRejects = 0;
  let nextRowId = 0;
  for (const anchorT of buildAnchorSequence(paramsByStreet[seedPlan.streetIdx].totalLength, p, seedPlan.t)) {
    const enqueued = enqueuePendingAnchor(
      pendingAnchors,
      queuedAnchorKeys,
      seedPlan.streetIdx,
      anchorT,
      p,
      {
        source: 'seed-centroid',
        generation: 0,
        parentRowId: null,
      },
    );
    if (enqueued) {
      emitRibbonEvent(ctx, 'anchor-enqueued', buildAnchorEventContext(enqueued), {
        action: 'seed-centroid',
      });
    }
  }

  while (nextRowId < p.maxRowsTotal) {
    if (pendingAnchors.length === 0 && p.fillRemainingStreetGaps) {
      const fillAnchor = findRemainingGapSeedAnchor(paramsByStreet, usedTsByStreet, p);
      if (fillAnchor) {
        const guideRowId = p.gapSeedBorrowNearestRow
          ? findNearestGuideRowOnStreet(rows, fillAnchor.streetIdx, fillAnchor.t)
          : null;
        const enqueued = enqueuePendingAnchor(
          pendingAnchors,
          queuedAnchorKeys,
          fillAnchor.streetIdx,
          fillAnchor.t,
          p,
          {
            source: 'seed-gap',
            generation: 0,
            parentRowId: null,
            guideRowId,
          },
        );
        if (enqueued) {
          emitRibbonEvent(ctx, 'gap-seed-created', buildAnchorEventContext(enqueued), {
            gap: fillAnchor.gap,
            unusedStreet: fillAnchor.unused,
            guideRowId,
          });
          emitRibbonEvent(ctx, 'anchor-enqueued', buildAnchorEventContext(enqueued), {
            action: 'gap-seed',
          });
        }
      }
    }

    if (pendingAnchors.length === 0) break;
    const anchor = pendingAnchors.shift();
    if (!anchor) break;
    if (isTooClose(anchor.t, usedTsByStreet[anchor.streetIdx], p.minParcelDepth * p.nearDuplicateFactor)) {
      continue;
    }

    const anchorPoint = pointAtArcLength(paramsByStreet[anchor.streetIdx], anchor.t);
    const parentRow = anchor.parentRowId !== null ? rowsById.get(anchor.parentRowId) : null;
    const guideRow = anchor.guideRowId !== null && anchor.guideRowId !== undefined
      ? rowsById.get(anchor.guideRowId)
      : null;
    const constructionParentRow = parentRow || guideRow;
    const familyRootRowId = anchor.parentRowId === null
      ? nextRowId
      : (parentRow?.familyRootRowId ?? parentRow?.rowId ?? anchor.parentRowId);
    emitRibbonEvent(
      ctx,
      'anchor-dequeued',
      buildAnchorEventContext(anchor, nextRowId, familyRootRowId),
      {
        guideRowId: anchor.guideRowId ?? null,
      },
    );
    emitRibbonEvent(
      ctx,
      'row-build-start',
      buildAnchorEventContext(anchor, nextRowId, familyRootRowId),
      {
        parentRowId: constructionParentRow?.rowId ?? null,
        parentSource: constructionParentRow?.source ?? null,
      },
    );

    const result = buildAreaRow(
      anchor.streetIdx,
      anchor.t,
      nextRowId,
      constructionParentRow,
      state,
      ctx,
    );
    annotateTraceFailures(result.trace, {
      rowIdAttempt: nextRowId,
      familyRootRowId,
      anchorStreetIdx: anchor.streetIdx,
      anchorT: anchor.t,
      anchorSource: anchor.source,
      anchorGeneration: anchor.generation,
      anchorParentRowId: anchor.parentRowId,
      anchorGuideRowId: anchor.guideRowId ?? null,
      anchorSlotIndex: anchor.slotIndex ?? null,
    });

    angleRejects += result.trace.angleRejects;
    ingestTrace(result.trace, failedRibbons, failureCounts);
    let ribbon = result.ribbon
      ? {
        ...result.ribbon,
        source: anchor.parentRowId === null ? 'seed-string' : 'parallel-string',
        generation: anchor.generation,
        parentRowId: anchor.parentRowId,
        familyRootRowId,
        slotIndex: anchor.slotIndex ?? null,
      }
      : null;

    if (ribbon) {
      let relationCheck = findRibbonRelationFailure(
        ribbon,
        constructionParentRow,
        rows,
        paramsByStreet,
        p,
      );
      if (relationCheck && p.parallelTruncateViolatingTail && constructionParentRow) {
        let truncatePasses = 0;
        while (relationCheck && truncatePasses < ribbon.streetPoints.length) {
          const truncated = truncateRibbonAtRelationFailure(
            ribbon,
            relationCheck,
            anchor.streetIdx,
            anchor.t,
            p,
          );
          if (!truncated) break;
          ribbon = truncated;
          relationCheck = findRibbonRelationFailure(
            ribbon,
            constructionParentRow,
            rows,
            paramsByStreet,
            p,
          );
          truncatePasses++;
        }
      }
      if (relationCheck) {
        addReasonCount(failureCounts, relationCheck.reason);
        emitRibbonEvent(
          ctx,
          'relation-check-failed',
          buildAnchorEventContext(anchor, nextRowId, familyRootRowId),
          {
            rowIdAttempt: nextRowId,
            reason: relationCheck.reason,
            conflictRowId: relationCheck.conflictRowId ?? constructionParentRow?.rowId ?? null,
            streetIdx: relationCheck.streetIdx ?? null,
            estimatedGap: relationCheck.gap ?? null,
            stopPoint: relationCheck.stopPoint || relationCheck.childPoint?.pt || anchorPoint,
          },
        );
        failedRibbons.push(buildIndexedFailure(
          relationCheck.reason,
          anchorPoint,
          ribbon.points,
          {
            fromStreetIdx: relationCheck.streetIdx,
            toStreetIdx: relationCheck.streetIdx,
            stopPoint: relationCheck.stopPoint || relationCheck.childPoint?.pt || anchorPoint,
            projectedPoint: relationCheck.projectedPoint || relationCheck.parentPoint?.pt,
          estimatedGap: relationCheck.gap,
          parentRowId: relationCheck.conflictRowId ?? constructionParentRow?.rowId ?? null,
          rowIdAttempt: nextRowId,
          familyRootRowId,
          anchorStreetIdx: anchor.streetIdx,
          anchorT: anchor.t,
          anchorSource: anchor.source,
          anchorGeneration: anchor.generation,
          anchorParentRowId: anchor.parentRowId,
          anchorGuideRowId: anchor.guideRowId ?? null,
          anchorSlotIndex: anchor.slotIndex ?? null,
        },
      ));
      ribbon = null;
      }
    }

    seedAnchors.push({
      rowId: nextRowId,
      streetIdx: anchor.streetIdx,
      t: anchor.t,
      point: anchorPoint,
      accepted: !!ribbon,
      source: anchor.source,
      generation: anchor.generation,
      parentRowId: anchor.parentRowId,
      guideRowId: anchor.guideRowId ?? null,
      familyRootRowId,
      slotIndex: anchor.slotIndex ?? null,
    });

    if (!ribbon) {
      emitRibbonEvent(
        ctx,
        'row-rejected',
        buildAnchorEventContext(anchor, nextRowId, familyRootRowId),
        {
          reason: primaryTraceReason(result.trace),
          failureCount: result.trace.failedRibbons.length,
        },
      );
      continue;
    }

    emitRibbonEvent(
      ctx,
      'row-accepted',
      buildAnchorEventContext(anchor, nextRowId, familyRootRowId),
      {
        streetCount: ribbon.streetPoints.length,
        length: ribbon.length,
        endpoints: [ribbon.points[0], ribbon.points[ribbon.points.length - 1]],
      },
    );

    rows.push(ribbon);
    rowsById.set(ribbon.rowId, ribbon);
    nextRowId++;
    for (const pointInfo of result.streetPoints) {
      state.usedTsByStreet[pointInfo.streetIdx].push(pointInfo.t);
    }

    if (p.parallelSlotFamilies && anchor.parentRowId === null && nextRowId < p.maxRowsTotal) {
      for (const slotAnchor of deriveFamilySlotAnchors(ribbon, paramsByStreet, state.usedTsByStreet, p)) {
        const enqueued = enqueuePendingAnchor(
          pendingAnchors,
          queuedAnchorKeys,
          slotAnchor.streetIdx,
          slotAnchor.t,
          p,
          {
            source: 'parallel-slot',
            generation: Math.abs(slotAnchor.slotIndex),
            parentRowId: ribbon.rowId,
            slotIndex: slotAnchor.slotIndex,
          },
        );
        if (enqueued) {
          emitRibbonEvent(ctx, 'family-slot-derived', buildAnchorEventContext(enqueued, null, ribbon.familyRootRowId ?? ribbon.rowId), {
            parentRowId: ribbon.rowId,
            slotIndex: slotAnchor.slotIndex,
          });
          emitRibbonEvent(ctx, 'anchor-enqueued', buildAnchorEventContext(enqueued, null, ribbon.familyRootRowId ?? ribbon.rowId), {
            action: 'parallel-slot',
          });
        }
      }
    } else if (p.parallelReseedRows && anchor.generation < p.parallelReseedMaxGeneration && nextRowId < p.maxRowsTotal) {
      for (const reseed of deriveParallelReseedAnchors(ribbon.streetPoints, paramsByStreet, p)) {
        const enqueued = enqueuePendingAnchor(
          pendingAnchors,
          queuedAnchorKeys,
          reseed.streetIdx,
          reseed.t,
          p,
          {
            source: 'parallel-reseed',
            generation: anchor.generation + 1,
            parentRowId: ribbon.rowId,
          },
        );
        if (enqueued) {
          emitRibbonEvent(ctx, 'anchor-enqueued', buildAnchorEventContext(enqueued, null, ribbon.familyRootRowId ?? ribbon.rowId), {
            action: 'parallel-reseed',
          });
        }
      }
    }
  }

  const orderedRows = [...rows].sort((a, b) => a.rowId - b.rowId);
  return {
    ribbons: orderedRows,
    parcels: [],
    angleRejects,
    failedRibbons,
    seedAnchors,
    failureSummary: {
      reasons: failureCounts,
      corridors: [],
    },
  };
}

function emptyRibbonResult() {
  return {
    ribbons: [],
    parcels: [],
    angleRejects: 0,
    failedRibbons: [],
    seedAnchors: [],
    failureSummary: {
      reasons: {},
      corridors: [],
    },
  };
}

function createRibbonLayoutContext({
  paramsByStreet,
  streetSampleProfiles,
  zoneSet,
  waterMask,
  streetIndex,
  cs,
  W,
  H,
  ox,
  oz,
  gradField,
  zoneContourDir,
  p,
  eventSink = null,
  eventStepId = 'ribbons',
  eventContext = {},
}) {
  return {
    paramsByStreet,
    streetSampleProfiles,
    zoneSet,
    waterMask,
    streetIndex,
    cs,
    W,
    H,
    ox,
    oz,
    gradField,
    zoneContourDir,
    p,
    eventSink: eventSink instanceof EventSink ? eventSink : eventSink || null,
    eventStepId,
    eventContext,
  };
}

function createRibbonLayoutState(paramsByStreet) {
  return {
    rows: [],
    rowsById: new Map(),
    pendingAnchors: [],
    queuedAnchorKeys: new Set(),
    usedTsByStreet: paramsByStreet.map(() => []),
  };
}

function buildAnchorEventContext(anchor, rowIdAttempt = null, familyRootRowId = null) {
  const context = {
    rowIdAttempt,
    familyRootRowId,
    parentRowId: anchor?.parentRowId ?? null,
    anchorStreetIdx: anchor?.streetIdx ?? null,
    anchorT: anchor?.t ?? null,
    anchorSource: anchor?.source ?? null,
    anchorGeneration: anchor?.generation ?? null,
    anchorGuideRowId: anchor?.guideRowId ?? null,
    anchorSlotIndex: anchor?.slotIndex ?? null,
  };
  const sectorIdx = anchor?.sectorIdx ?? null;
  if (sectorIdx !== null && familyRootRowId !== null) {
    context.familyKey = `${sectorIdx}:${familyRootRowId}`;
  }
  return compactObject(context);
}

function emitRibbonEvent(ctx, type, context = {}, payload = {}) {
  const sink = ctx?.eventSink;
  if (!sink || typeof sink.emit !== 'function' || typeof sink.next !== 'function') return;
  sink.emit({
    seq: sink.next(),
    stepId: ctx.eventStepId,
    type,
    ...compactObject(ctx.eventContext || {}),
    ...compactObject(context),
    payload: compactObject(payload),
  });
}

function buildAreaRow(
  anchorStreetIdx,
  anchorT,
  rowId,
  parentRow,
  state,
  ctx,
) {
  const { paramsByStreet, p } = ctx;
  if (parentRow && p.parallelInheritParentJunctions) {
    return buildInheritedParallelRow(
      anchorStreetIdx,
      anchorT,
      rowId,
      parentRow,
      state,
      ctx,
    );
  }

  const trace = createTrace();
  const anchorPoint = {
    streetIdx: anchorStreetIdx,
    t: anchorT,
    pt: pointAtArcLength(paramsByStreet[anchorStreetIdx], anchorT),
  };
  const left = extendStreetDirection(
    -1,
    anchorPoint,
    state,
    ctx,
  );
  const right = extendStreetDirection(
    1,
    anchorPoint,
    state,
    ctx,
  );
  mergeTraceInto(trace, left.trace);
  mergeTraceInto(trace, right.trace);

  const leftPolyline = left.polyline.length > 0
    ? compactPolyline([...left.polyline].reverse())
    : [anchorPoint.pt];
  const rightPolyline = right.polyline.length > 0
    ? compactPolyline(right.polyline)
    : [anchorPoint.pt];
  const combinedPolyline = compactPolyline([
    ...leftPolyline,
    ...rightPolyline.slice(1),
  ]);

  if (combinedPolyline.length < 2 || polylineLength(combinedPolyline) < p.minRibbonLength) {
    return { ribbon: null, streetPoints: [anchorPoint], trace };
  }

  const leftStreetPoints = left.streetPoints.length > 0
    ? [...left.streetPoints].reverse()
    : [anchorPoint];
  const rightStreetPoints = right.streetPoints.length > 0
    ? right.streetPoints
    : [anchorPoint];
  const combinedStreetPoints = [
    ...leftStreetPoints,
    ...rightStreetPoints.slice(1),
  ];

  return {
    ribbon: {
      points: combinedPolyline,
      streetPoints: combinedStreetPoints,
      rowId,
      centerT: anchorT,
      source: 'seed-string',
      length: polylineLength(combinedPolyline),
    },
    streetPoints: combinedStreetPoints,
    trace,
  };
}

function extendStreetDirection(
  direction,
  anchorPoint,
  state,
  ctx,
) {
  const { paramsByStreet, p } = ctx;
  const anchorParam = paramsByStreet[anchorPoint.streetIdx];
  const anchorTan = ribbonTangentAtArcLength(anchorParam, anchorPoint.t, p);
  const anchorNormal = normalize({
    x: -anchorTan.z * direction,
    z: anchorTan.x * direction,
  });
  return extendStreetWalk(
    {
      streetIdx: anchorPoint.streetIdx,
      t: anchorPoint.t,
      pt: anchorPoint.pt,
    },
    new Set([anchorPoint.streetIdx]),
    anchorNormal,
    null,
    state,
    ctx,
  );
}

function extendStreetWalk(
  initialPoint,
  visitedStreetIdx,
  preferredGuideDir,
  rowDir,
  state,
  ctx,
) {
  const { paramsByStreet } = ctx;
  const trace = createTrace();
  let current = {
    streetIdx: initialPoint.streetIdx,
    t: initialPoint.t,
    pt: initialPoint.pt,
  };
  let currentRowDir = rowDir;
  let currentGuideDir = preferredGuideDir;
  const polyline = [current.pt];
  const streetPoints = [current];
  const seenStreetIdx = new Set(visitedStreetIdx || [current.streetIdx]);
  seenStreetIdx.add(current.streetIdx);

  while (true) {
    const currentParam = paramsByStreet[current.streetIdx];

    const attempt = placeNextStreetPoint(
      current,
      currentParam,
      seenStreetIdx,
      currentGuideDir,
      currentRowDir,
      state,
      ctx,
    );
    mergeTraceInto(trace, attempt.trace);
    if (!attempt.point || !attempt.polyline || attempt.polyline.length < 2) break;

    appendPolylineSegment(polyline, attempt.polyline);

    const segmentDir = normalize({
      x: attempt.polyline[attempt.polyline.length - 1].x - attempt.polyline[Math.max(0, attempt.polyline.length - 2)].x,
      z: attempt.polyline[attempt.polyline.length - 1].z - attempt.polyline[Math.max(0, attempt.polyline.length - 2)].z,
    });
    currentRowDir = segmentDir;
    currentGuideDir = segmentDir;
    current = {
      streetIdx: attempt.streetIdx,
      t: attempt.point.t,
      pt: attempt.point.pt,
    };
    seenStreetIdx.add(current.streetIdx);
    streetPoints.push(current);
  }

  return {
    polyline,
    streetPoints,
    trace,
  };
}

function buildInheritedParallelRow(
  anchorStreetIdx,
  anchorT,
  rowId,
  parentRow,
  state,
  ctx,
) {
  const { paramsByStreet, p } = ctx;
  const trace = createTrace();
  const parentAnchor = findParentAnchorStreetPoint(parentRow, anchorStreetIdx, anchorT);
  if (!parentAnchor) {
    return buildAreaRow(
      anchorStreetIdx,
      anchorT,
      rowId,
      null,
      state,
      ctx,
    );
  }

  const anchorPoint = {
    streetIdx: anchorStreetIdx,
    t: anchorT,
    pt: pointAtArcLength(paramsByStreet[anchorStreetIdx], anchorT),
  };
  const deltaT = anchorT - parentAnchor.point.t;

  const left = extendInheritedParallelBranch(
    -1,
    anchorPoint,
    parentRow,
    parentAnchor.index,
    deltaT,
    state,
    ctx,
  );
  const right = extendInheritedParallelBranch(
    1,
    anchorPoint,
    parentRow,
    parentAnchor.index,
    deltaT,
    state,
    ctx,
  );
  mergeTraceInto(trace, left.trace);
  mergeTraceInto(trace, right.trace);

  if (p.parallelExtendPastParent) {
    const inheritedVisited = new Set([
      ...left.streetPoints.map(point => point.streetIdx),
      ...right.streetPoints.map(point => point.streetIdx),
    ]);

    if (left.reachedParentEnd) {
      const extension = extendStreetWalk(
        left.streetPoints[left.streetPoints.length - 1],
        inheritedVisited,
        left.outwardDir,
        left.outwardDir,
        state,
        ctx,
      );
      mergeTraceInto(trace, extension.trace);
      appendPolylineSegment(left.polyline, extension.polyline);
      left.streetPoints.push(...extension.streetPoints.slice(1));
    }

    if (right.reachedParentEnd) {
      const extension = extendStreetWalk(
        right.streetPoints[right.streetPoints.length - 1],
        inheritedVisited,
        right.outwardDir,
        right.outwardDir,
        state,
        ctx,
      );
      mergeTraceInto(trace, extension.trace);
      appendPolylineSegment(right.polyline, extension.polyline);
      right.streetPoints.push(...extension.streetPoints.slice(1));
    }
  }

  const leftPolyline = left.polyline.length > 0
    ? compactPolyline([...left.polyline].reverse())
    : [anchorPoint.pt];
  const rightPolyline = right.polyline.length > 0
    ? compactPolyline(right.polyline)
    : [anchorPoint.pt];
  const combinedPolyline = compactPolyline([
    ...leftPolyline,
    ...rightPolyline.slice(1),
  ]);

  if (combinedPolyline.length < 2 || polylineLength(combinedPolyline) < p.minRibbonLength) {
    return { ribbon: null, streetPoints: [anchorPoint], trace };
  }

  const leftStreetPoints = left.streetPoints.length > 0
    ? [...left.streetPoints].reverse()
    : [anchorPoint];
  const rightStreetPoints = right.streetPoints.length > 0
    ? right.streetPoints
    : [anchorPoint];
  const combinedStreetPoints = [
    ...leftStreetPoints,
    ...rightStreetPoints.slice(1),
  ];

  return {
    ribbon: {
      points: combinedPolyline,
      streetPoints: combinedStreetPoints,
      rowId,
      centerT: anchorT,
      source: 'seed-string',
      length: polylineLength(combinedPolyline),
    },
    streetPoints: combinedStreetPoints,
    trace,
  };
}

function findParentAnchorStreetPoint(parentRow, anchorStreetIdx, anchorT) {
  let best = null;
  for (let i = 0; i < parentRow.streetPoints.length; i++) {
    const point = parentRow.streetPoints[i];
    if (point.streetIdx !== anchorStreetIdx) continue;
    const delta = Math.abs(point.t - anchorT);
    if (!best || delta < best.delta) {
      best = { index: i, point, delta };
    }
  }
  return best;
}

function extendInheritedParallelBranch(
  direction,
  anchorPoint,
  parentRow,
  parentIndex,
  deltaT,
  state,
  ctx,
) {
  const { paramsByStreet, p } = ctx;
  const trace = createTrace();
  const polyline = [anchorPoint.pt];
  const streetPoints = [anchorPoint];
  let current = anchorPoint;
  let currentParentIndex = parentIndex;
  let reachedParentEnd = false;

  while (true) {
    const nextParentIndex = currentParentIndex + direction;
    if (nextParentIndex < 0 || nextParentIndex >= parentRow.streetPoints.length) {
      reachedParentEnd = true;
      break;
    }

    const parentCurrent = parentRow.streetPoints[currentParentIndex];
    const parentTarget = parentRow.streetPoints[nextParentIndex];
    const nextParam = paramsByStreet[parentTarget.streetIdx];
    const targetT = parentTarget.t + deltaT;
    if (targetT < p.edgeMargin || targetT > nextParam.totalLength - p.edgeMargin) break;

    const target = p.parallelInheritedMidpointGuide
      ? resolveInheritedMidpointGuideTarget(
        current,
        parentCurrent,
        parentTarget,
        targetT,
        polyline,
        state,
        ctx,
      )
      : resolveInheritedParallelTarget(
        current,
        parentCurrent,
        parentTarget,
        targetT,
        polyline,
        state,
        ctx,
      );
    const attempt = connectDirectToTargetStreet(
      current,
      target,
      state,
      ctx,
    );
    mergeTraceInto(trace, attempt.trace);
    if (!attempt.point || !attempt.polyline || attempt.polyline.length < 2) break;

    appendPolylineSegment(polyline, attempt.polyline);
    current = {
      streetIdx: attempt.streetIdx,
      t: attempt.point.t,
      pt: attempt.point.pt,
    };
    currentParentIndex = nextParentIndex;
    streetPoints.push(current);
  }

  return {
    polyline,
    streetPoints,
    trace,
    reachedParentEnd,
    outwardDir: segmentDirectionFromPolyline(polyline),
  };
}

function connectDirectToTargetStreet(
  current,
  target,
  state,
  ctx,
) {
  const { paramsByStreet, zoneSet, waterMask, cs, W, H, ox, oz, p } = ctx;
  const { usedTsByStreet } = state;
  const currentIdx = current.streetIdx;
  const currentT = current.t;
  const currentPt = current.pt;
  const trace = createTrace();

  if (isTooClose(target.t, usedTsByStreet[target.streetIdx], p.minParcelDepth * p.nearDuplicateFactor)) {
    addReasonCount(trace.counts, 'too-close');
    trace.failedRibbons.push(buildIndexedFailure(
      'too-close',
      currentPt,
      [currentPt, target.point],
          {
            fromStreetIdx: currentIdx,
            fromStreetT: currentT,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            projectedPoint: target.point,
      },
    ));
    return { streetIdx: null, point: null, polyline: null, trace };
  }

  const finalPolyline = compactPolyline([currentPt, target.point]);
  const finalLength = polylineLength(finalPolyline);
  if (finalLength < p.minRibbonLength) {
    addReasonCount(trace.counts, 'too-short');
    trace.failedRibbons.push(buildIndexedFailure(
      'too-short',
      currentPt,
      finalPolyline,
          {
            fromStreetIdx: currentIdx,
            fromStreetT: currentT,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            projectedPoint: target.point,
      },
    ));
    return { streetIdx: null, point: null, polyline: null, trace };
  }
  if (finalLength > p.maxRibbonLength) {
    addReasonCount(trace.counts, 'too-long');
    trace.failedRibbons.push(buildIndexedFailure(
      'too-long',
      currentPt,
      finalPolyline,
          {
            fromStreetIdx: currentIdx,
            fromStreetT: currentT,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            projectedPoint: target.point,
      },
    ));
    return { streetIdx: null, point: null, polyline: null, trace };
  }

  const validity = validateRibbonPolyline(finalPolyline, zoneSet, waterMask, cs, W, H, ox, oz);
  if (!validity.ok) {
    addReasonCount(trace.counts, validity.reason);
    trace.failedRibbons.push(buildIndexedFailure(
      validity.reason,
      currentPt,
      finalPolyline,
          {
            fromStreetIdx: currentIdx,
            fromStreetT: currentT,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            projectedPoint: target.point,
      },
    ));
    return { streetIdx: null, point: null, polyline: null, trace };
  }

  const nextParam = paramsByStreet[target.streetIdx];
  const nextTan = ribbonTangentAtArcLength(nextParam, target.t, p);
  const finalStep = finalPolyline[finalPolyline.length - 2];
  const approachAngle = perpendicularAngleError(finalStep, target.point, nextTan);
  if (approachAngle > p.fallbackMaxAngleOff) {
    trace.angleRejects++;
    addReasonCount(trace.counts, 'angle');
    trace.failedRibbons.push(buildIndexedFailure(
      'angle',
      currentPt,
      finalPolyline,
          {
            fromStreetIdx: currentIdx,
            fromStreetT: currentT,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            projectedPoint: target.point,
      },
    ));
    return { streetIdx: null, point: null, polyline: null, trace };
  }

  return {
    streetIdx: target.streetIdx,
    point: { t: target.t, pt: target.point },
    polyline: finalPolyline,
    trace,
  };
}

function resolveInheritedParallelTarget(
  current,
  parentCurrent,
  parentTarget,
  baseTargetT,
  polyline,
  state,
  ctx,
) {
  const { paramsByStreet, p } = ctx;
  const { usedTsByStreet } = state;
  const nextParam = paramsByStreet[parentTarget.streetIdx];
  const edgeMin = p.edgeMargin;
  const edgeMax = nextParam.totalLength - p.edgeMargin;
  const baseTarget = {
    streetIdx: parentTarget.streetIdx,
    t: baseTargetT,
    point: pointAtArcLength(nextParam, baseTargetT),
  };
  const searchRadius = p.parallelInheritedTargetSearchRadius || 0;
  const searchStep = p.parallelInheritedTargetSearchStep || 0;
  if (searchRadius <= 0 || searchStep <= 0) return baseTarget;

  const previousDir = segmentDirectionFromPolyline(polyline);
  const parentStepDir = normalize({
    x: parentTarget.pt.x - parentCurrent.pt.x,
    z: parentTarget.pt.z - parentCurrent.pt.z,
  });
  const minSeparation = p.minParcelDepth * p.nearDuplicateFactor;
  let best = null;
  const visitedTs = new Set();

  for (let offset = -searchRadius; offset <= searchRadius + 1e-6; offset += searchStep) {
    const candidateT = clamp(baseTargetT + offset, edgeMin, edgeMax);
    const key = Math.round(candidateT * 1000);
    if (visitedTs.has(key)) continue;
    visitedTs.add(key);
    if (isTooClose(candidateT, usedTsByStreet[parentTarget.streetIdx], minSeparation)) continue;

    const point = pointAtArcLength(nextParam, candidateT);
    const candidateDir = normalize({
      x: point.x - current.pt.x,
      z: point.z - current.pt.z,
    });
    if (!candidateDir) continue;

    const nextTan = ribbonTangentAtArcLength(nextParam, candidateT, p);
    const score =
      Math.abs(candidateT - baseTargetT) * p.parallelInheritedBaseOffsetWeight +
      directionAngleError(candidateDir, parentStepDir) * p.parallelInheritedParentDirWeight +
      directionAngleError(candidateDir, previousDir) * p.parallelInheritedTurnWeight +
      perpendicularAngleError(current.pt, point, nextTan) * p.parallelInheritedApproachWeight;

    if (!best || score < best.score) {
      best = {
        streetIdx: parentTarget.streetIdx,
        t: candidateT,
        point,
        score,
      };
    }
  }

  return best || baseTarget;
}

function resolveInheritedMidpointGuideTarget(
  current,
  parentCurrent,
  parentTarget,
  baseTargetT,
  polyline,
  state,
  ctx,
) {
  const { paramsByStreet, streetSampleProfiles, p } = ctx;
  const { usedTsByStreet } = state;
  const nextParam = paramsByStreet[parentTarget.streetIdx];
  const parentStepDir = normalize({
    x: parentTarget.pt.x - parentCurrent.pt.x,
    z: parentTarget.pt.z - parentCurrent.pt.z,
  });
  if (!parentStepDir) {
    return resolveInheritedParallelTarget(
      current,
      parentCurrent,
      parentTarget,
      baseTargetT,
      polyline,
      state,
      ctx,
    );
  }

  const offsetFromParent = {
    x: current.pt.x - parentCurrent.pt.x,
    z: current.pt.z - parentCurrent.pt.z,
  };
  const signedOffset = signedCross2(parentStepDir, offsetFromParent);
  const side = signedOffset < 0 ? -1 : 1;
  const spacing = Math.abs(signedOffset);
  const spacerNormal = { x: -parentStepDir.z * side, z: parentStepDir.x * side };
  const spacerPoint = {
    x: (parentCurrent.pt.x + parentTarget.pt.x) * 0.5 + spacerNormal.x * spacing,
    z: (parentCurrent.pt.z + parentTarget.pt.z) * 0.5 + spacerNormal.z * spacing,
  };
  const guideDir = normalize({
    x: spacerPoint.x - current.pt.x,
    z: spacerPoint.z - current.pt.z,
  });
  if (!guideDir) {
    return resolveInheritedParallelTarget(
      current,
      parentCurrent,
      parentTarget,
      baseTargetT,
      polyline,
      state,
      ctx,
    );
  }

  const rayHit = firstRayHitOnStreet(nextParam, current.pt, guideDir, p.edgeMargin);
  if (!rayHit) {
    return resolveInheritedParallelTarget(
      current,
      parentCurrent,
      parentTarget,
      baseTargetT,
      polyline,
      state,
      ctx,
    );
  }

  const landing = chooseLandingSampleOnStreet(
    current,
    spacerPoint,
    guideDir,
    parentTarget.streetIdx,
    rayHit,
    state,
    ctx,
  );

  return {
    streetIdx: parentTarget.streetIdx,
    t: landing.t,
    point: landing.point,
  };
}

function segmentDirectionFromPolyline(polyline) {
  if (!polyline || polyline.length < 2) return null;
  return normalize({
    x: polyline[polyline.length - 1].x - polyline[polyline.length - 2].x,
    z: polyline[polyline.length - 1].z - polyline[polyline.length - 2].z,
  });
}

function placeNextStreetPoint(current, currentParam, visitedStreetIdx, preferredGuideDir, rowDir, state, ctx) {
  const { paramsByStreet, streetSampleProfiles, gradField, zoneContourDir, p } = ctx;
  const trace = createTrace();
  const baseGuideDir = preferredGuideDir
    ? normalize(preferredGuideDir)
    : normalize(tangentNormalAtArcLength(currentParam, current.t, p));
  const localContourDir = contourDirectionAtPoint(current.pt, gradField, zoneContourDir);
  const guideDir = buildGuideDirection(baseGuideDir, rowDir, localContourDir, p);
  const marched = marchGuideToAnyStreet(
    current,
    visitedStreetIdx,
    guideDir,
    state,
    ctx,
    ({ candidate, approachPoint }) => chooseLandingSampleOnStreet(
      current,
      approachPoint,
      baseGuideDir,
      candidate.streetIdx,
      candidate.projected,
      state,
      ctx,
    ),
  );
  mergeTraceInto(trace, marched.trace);
  return {
    streetIdx: marched.streetIdx,
    point: marched.point,
    polyline: marched.polyline,
    trace,
  };
}

function marchGuideToTargetStreet(current, target, guideDir, state, ctx) {
  const { paramsByStreet, zoneSet, waterMask, streetIndex, cs, W, H, ox, oz, gradField, zoneContourDir, p } = ctx;
  const { usedTsByStreet } = state;
  const currentIdx = current.streetIdx;
  const currentPt = current.pt;
  const trace = createTrace();
  const path = [{ x: currentPt.x, z: currentPt.z }];
  const directDistance = dist(currentPt, target.point);
  const maxDistance = Math.min(
    p.guideMarchMaxDistance,
    Math.max(directDistance * 1.7, p.minRibbonLength * 2),
  );
  const stepSize = Math.max(cs * 0.35, p.guideMarchStep);
  const minTravel = Math.max(cs, p.minRibbonLength * 0.5);
  const maxSteps = Math.max(1, Math.ceil(maxDistance / stepSize));

  let marchDir = normalize(guideDir);
  let cursor = currentPt;
  let travelled = 0;

  for (let step = 0; step < maxSteps; step++) {
    const localContourDir = contourDirectionAtPoint(cursor, gradField, zoneContourDir);
    const targetDir = normalize({
      x: target.point.x - cursor.x,
      z: target.point.z - cursor.z,
    });
    const contourStepDir = localContourDir ? orientLike(localContourDir, targetDir) : null;
    marchDir = blendUnitVectors([
      { dir: normalize(guideDir), weight: p.guideMarchPerpBlend },
      { dir: targetDir, weight: p.guideMarchTargetBlend },
      { dir: marchDir, weight: p.guideMarchContinuationBlend },
      contourStepDir ? { dir: contourStepDir, weight: p.guideMarchContourBlend } : null,
    ]);

    const nextPt = {
      x: cursor.x + marchDir.x * stepSize,
      z: cursor.z + marchDir.z * stepSize,
    };
    path.push(nextPt);
    travelled += stepSize;

    const gx = Math.round((nextPt.x - ox) / cs);
    const gz = Math.round((nextPt.z - oz) / cs);
    if (gx < 0 || gx >= W || gz < 0 || gz >= H) {
      addReasonCount(trace.counts, 'off-map');
      trace.failedRibbons.push(buildIndexedFailure(
        'off-map',
        currentPt,
        compactPolyline(path),
        {
          fromStreetIdx: currentIdx,
          toStreetIdx: target.streetIdx,
          stopPoint: nextPt,
          stopCell: { gx, gz },
          projectedPoint: target.point,
        },
      ));
      return { streetIdx: null, point: null, polyline: null, trace };
    }

    if (waterMask && waterMask.get(gx, gz) > 0) {
      addReasonCount(trace.counts, 'water');
      trace.failedRibbons.push(buildIndexedFailure(
        'water',
        currentPt,
        compactPolyline(path),
        {
          fromStreetIdx: currentIdx,
          toStreetIdx: target.streetIdx,
          stopPoint: nextPt,
          stopCell: { gx, gz },
          projectedPoint: target.point,
        },
      ));
      return { streetIdx: null, point: null, polyline: null, trace };
    }

    const ids = lookupStreetIds(streetIndex, gx, gz);
    const wrongStreetHit = ids.find(streetIdx => streetIdx !== currentIdx && streetIdx !== target.streetIdx);
    if (travelled >= minTravel && wrongStreetHit !== undefined) {
      addReasonCount(trace.counts, 'wrong-street');
      trace.failedRibbons.push(buildIndexedFailure(
        'wrong-street',
        currentPt,
        compactPolyline(path),
        {
          fromStreetIdx: currentIdx,
          toStreetIdx: target.streetIdx,
          stopPoint: nextPt,
          stopCell: { gx, gz },
          projectedPoint: target.point,
          hitStreetIds: ids,
        },
      ));
      return { streetIdx: null, point: null, polyline: null, trace };
    }

    const closeToTarget = dist(nextPt, target.point) <= Math.max(stepSize * 1.5, p.streetIndexRadiusMeters + cs * 0.5);
    if (travelled >= minTravel && (ids.includes(target.streetIdx) || closeToTarget)) {
      if (isTooClose(target.t, usedTsByStreet[target.streetIdx], p.minParcelDepth * p.nearDuplicateFactor)) {
        addReasonCount(trace.counts, 'too-close');
        trace.failedRibbons.push(buildIndexedFailure(
          'too-close',
          currentPt,
          compactPolyline(path),
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            stopCell: { gx, gz },
            projectedPoint: target.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      const finalPolyline = compactPolyline([...path.slice(0, -1), target.point]);
      const finalLength = polylineLength(finalPolyline);
      if (finalLength < p.minRibbonLength) {
        addReasonCount(trace.counts, 'too-short');
        trace.failedRibbons.push(buildIndexedFailure(
          'too-short',
          currentPt,
          finalPolyline,
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            stopCell: { gx, gz },
            projectedPoint: target.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }
      if (finalLength > p.maxRibbonLength) {
        addReasonCount(trace.counts, 'too-long');
        trace.failedRibbons.push(buildIndexedFailure(
          'too-long',
          currentPt,
          finalPolyline,
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            stopCell: { gx, gz },
            projectedPoint: target.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      const validity = validateRibbonPolyline(finalPolyline, zoneSet, waterMask, cs, W, H, ox, oz);
      if (!validity.ok) {
        addReasonCount(trace.counts, validity.reason);
        trace.failedRibbons.push(buildIndexedFailure(
          validity.reason,
          currentPt,
          finalPolyline,
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            stopCell: { gx, gz },
            projectedPoint: target.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      const nextParam = paramsByStreet[target.streetIdx];
      const nextTan = ribbonTangentAtArcLength(nextParam, target.t, p);
      const finalStep = finalPolyline[finalPolyline.length - 2];
      const approachAngle = perpendicularAngleError(finalStep, target.point, nextTan);
      if (approachAngle > p.fallbackMaxAngleOff) {
        trace.angleRejects++;
        addReasonCount(trace.counts, 'angle');
        trace.failedRibbons.push(buildIndexedFailure(
          'angle',
          currentPt,
          finalPolyline,
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: target.streetIdx,
            stopPoint: target.point,
            stopCell: { gx, gz },
            projectedPoint: target.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      return {
        streetIdx: target.streetIdx,
        point: { t: target.t, pt: target.point },
        polyline: finalPolyline,
        trace,
      };
    }

    cursor = nextPt;
  }

  addReasonCount(trace.counts, 'ray-miss');
  trace.failedRibbons.push(buildIndexedFailure(
    'ray-miss',
    currentPt,
    compactPolyline(path),
    {
      fromStreetIdx: currentIdx,
      toStreetIdx: target.streetIdx,
      stopPoint: path[path.length - 1],
      projectedPoint: target.point,
      travelled,
    },
  ));
  return { streetIdx: null, point: null, polyline: null, trace };
}

function marchGuideToAnyStreet(current, visitedStreetIdx, guideDir, state, ctx, chooseLandingPoint = null) {
  const { paramsByStreet, streetSampleProfiles, zoneSet, waterMask, streetIndex, cs, W, H, ox, oz, gradField, zoneContourDir, p } = ctx;
  const { usedTsByStreet } = state;
  const currentIdx = current.streetIdx;
  const currentT = current.t;
  const currentPt = current.pt;
  const trace = createTrace();
  const path = [{ x: currentPt.x, z: currentPt.z }];
  const maxDistance = p.guideMarchMaxDistance;
  const stepSize = Math.max(cs * 0.35, p.guideMarchStep);
  const minTravel = Math.max(cs, p.minRibbonLength * 0.5);
  const maxSteps = Math.max(1, Math.ceil(maxDistance / stepSize));

  let marchDir = normalize(guideDir);
  let cursor = currentPt;
  let travelled = 0;

  for (let step = 0; step < maxSteps; step++) {
    const localContourDir = contourDirectionAtPoint(cursor, gradField, zoneContourDir);
    const contourStepDir = localContourDir ? orientLike(localContourDir, marchDir) : null;
    marchDir = blendUnitVectors([
      { dir: normalize(guideDir), weight: p.guideMarchPerpBlend },
      { dir: marchDir, weight: p.guideMarchContinuationBlend },
      contourStepDir ? { dir: contourStepDir, weight: p.guideMarchContourBlend } : null,
    ]);

    const nextPt = {
      x: cursor.x + marchDir.x * stepSize,
      z: cursor.z + marchDir.z * stepSize,
    };
    path.push(nextPt);
    travelled += stepSize;

    const gx = Math.round((nextPt.x - ox) / cs);
    const gz = Math.round((nextPt.z - oz) / cs);
    if (gx < 0 || gx >= W || gz < 0 || gz >= H) {
      addReasonCount(trace.counts, 'off-map');
      trace.failedRibbons.push(buildIndexedFailure(
        'off-map',
        currentPt,
        compactPolyline(path),
        {
          fromStreetIdx: currentIdx,
          stopPoint: nextPt,
          stopCell: { gx, gz },
        },
      ));
      return { point: null, polyline: null, trace };
    }

    if (waterMask && waterMask.get(gx, gz) > 0) {
      addReasonCount(trace.counts, 'water');
      trace.failedRibbons.push(buildIndexedFailure(
        'water',
        currentPt,
        compactPolyline(path),
        {
          fromStreetIdx: currentIdx,
          stopPoint: nextPt,
          stopCell: { gx, gz },
        },
      ));
      return { point: null, polyline: null, trace };
    }

    const ids = lookupStreetIds(streetIndex, gx, gz);
    const candidate = travelled >= minTravel
      ? chooseFirstHitStreet(
        currentIdx,
        currentPt,
        nextPt,
        guideDir,
        ids,
        paramsByStreet,
        visitedStreetIdx,
        p,
      )
      : null;

    if (candidate) {
      const { streetIdx: nextIdx, projected } = candidate;
      const landing = chooseLandingPoint
        ? chooseLandingPoint({ candidate, samplePoint: nextPt, approachPoint: cursor })
        : null;
      const resolvedLanding = landing && landing.streetIdx === nextIdx
        ? landing
        : {
          streetIdx: nextIdx,
          t: projected.t,
          point: projected.point,
        };
      if (isTooClose(resolvedLanding.t, usedTsByStreet[nextIdx], p.minParcelDepth * p.nearDuplicateFactor)) {
        addReasonCount(trace.counts, 'too-close');
        trace.failedRibbons.push(buildIndexedFailure(
          'too-close',
          currentPt,
          compactPolyline(path),
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: nextIdx,
            stopPoint: resolvedLanding.point,
            stopCell: { gx, gz },
            projectedPoint: resolvedLanding.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      const pathPrefix = path.slice(0, -1);
      let finalLanding = resolvedLanding;
      let finalPolyline = compactPolyline([...pathPrefix, finalLanding.point]);
      let finalLength = polylineLength(finalPolyline);
      const maxLength = p.maxRibbonLength;
      if (finalLength < p.minRibbonLength) {
        addReasonCount(trace.counts, 'too-short');
        trace.failedRibbons.push(buildIndexedFailure(
          'too-short',
          currentPt,
          finalPolyline,
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: nextIdx,
            stopPoint: resolvedLanding.point,
            stopCell: { gx, gz },
            projectedPoint: resolvedLanding.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }
      if (finalLength > maxLength) {
        addReasonCount(trace.counts, 'too-long');
        trace.failedRibbons.push(buildIndexedFailure(
          'too-long',
          currentPt,
          finalPolyline,
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: nextIdx,
            stopPoint: resolvedLanding.point,
            stopCell: { gx, gz },
            projectedPoint: resolvedLanding.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      const validity = validateRibbonPolyline(finalPolyline, zoneSet, waterMask, cs, W, H, ox, oz);
      if (!validity.ok) {
        addReasonCount(trace.counts, validity.reason);
        trace.failedRibbons.push(buildIndexedFailure(
          validity.reason,
          currentPt,
          finalPolyline,
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: nextIdx,
            stopPoint: resolvedLanding.point,
            stopCell: { gx, gz },
            projectedPoint: resolvedLanding.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      const nextParam = paramsByStreet[nextIdx];
      let nextTan = ribbonTangentAtArcLength(nextParam, finalLanding.t, p);
      let finalStep = finalPolyline[finalPolyline.length - 2];
      let approachAngle = perpendicularAngleError(finalStep, finalLanding.point, nextTan);
      if (approachAngle > p.fallbackMaxAngleOff) {
        const repaired = repairLandingOnStreet(
          current,
          nextIdx,
          projected,
          finalLanding,
          pathPrefix,
          guideDir,
          state,
          ctx,
        );
        if (repaired) {
          finalLanding = repaired.landing;
          finalPolyline = repaired.finalPolyline;
          finalLength = repaired.length;
          nextTan = repaired.nextTan;
          finalStep = repaired.finalStep;
          approachAngle = repaired.approachAngle;
        }
      }
      if (approachAngle > p.fallbackMaxAngleOff) {
        trace.angleRejects++;
        addReasonCount(trace.counts, 'angle');
        trace.failedRibbons.push(buildIndexedFailure(
          'angle',
          currentPt,
          finalPolyline,
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: nextIdx,
            stopPoint: finalLanding.point,
            stopCell: { gx, gz },
            projectedPoint: finalLanding.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      return {
        streetIdx: nextIdx,
        point: { t: finalLanding.t, pt: finalLanding.point },
        polyline: finalPolyline,
        trace,
      };
    }

    cursor = nextPt;
  }

  addReasonCount(trace.counts, 'ray-miss');
  trace.failedRibbons.push(buildIndexedFailure(
    'ray-miss',
    currentPt,
    compactPolyline(path),
    {
      fromStreetIdx: currentIdx,
      stopPoint: path[path.length - 1],
      travelled,
    },
  ));
  return { streetIdx: null, point: null, polyline: null, trace };
}

function chooseFirstHitStreet(
  currentIdx,
  currentPt,
  samplePt,
  guideDir,
  streetIds,
  paramsByStreet,
  visitedStreetIdx,
  p,
) {
  let best = null;

  for (const streetIdx of streetIds) {
    if (streetIdx === currentIdx) continue;
    if (visitedStreetIdx.has(streetIdx)) continue;

    const projected = closestArcLengthToPoint(paramsByStreet[streetIdx], samplePt, p.edgeMargin);
    const delta = {
      x: projected.point.x - currentPt.x,
      z: projected.point.z - currentPt.z,
    };
    const forward = dot2(delta, guideDir);
    if (forward < p.minRibbonLength * 0.5) continue;

    const score =
      pointLineDistance(projected.point, currentPt, guideDir) * 6 +
      Math.abs(dist(projected.point, currentPt) - dist(samplePt, currentPt)) * 0.5;

    if (!best || score < best.score) {
      best = {
        streetIdx,
        projected,
        score,
      };
    }
  }

  return best;
}

function chooseLandingSampleOnStreet(current, approachPoint, guideDir, targetStreetIdx, referenceHit, state, ctx) {
  const { paramsByStreet, streetSampleProfiles, p } = ctx;
  const { usedTsByStreet } = state;
  const currentIdx = current.streetIdx;
  const currentT = current.t;
  const currentPt = current.pt;
  const currentElevation = sampleStreetElevationAtT(streetSampleProfiles[currentIdx], currentT);
  const nextParam = paramsByStreet[targetStreetIdx];
  const samples = streetSampleProfiles[targetStreetIdx] || [];
  const localBand = Math.max(p.targetStreetLocalBand, p.streetSampleStep * 2);
  let bestMatched = null;
  let bestFallback = null;

  for (const sample of samples) {
    if (Math.abs(sample.t - referenceHit.t) > localBand) continue;
    if (dist(sample.point, referenceHit.point) > localBand * 1.4) continue;
    if (isTooClose(sample.t, usedTsByStreet[targetStreetIdx], p.minParcelDepth * p.nearDuplicateFactor)) continue;

    const delta = {
      x: sample.point.x - currentPt.x,
      z: sample.point.z - currentPt.z,
    };
    const forward = dot2(delta, guideDir);
    if (forward < p.minRibbonLength * 0.5) continue;

    const distance = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
    if (distance > p.maxRibbonLength) continue;

    const guideOffset = pointLineDistance(sample.point, currentPt, guideDir);
    if (guideOffset > p.targetStreetGuideTolerance) continue;

    const guideAngle = guideAngleError(currentPt, sample.point, guideDir);
    const nextTan = ribbonTangentAtArcLength(nextParam, sample.t, p);
    const arrivalAngle = perpendicularAngleError(approachPoint || currentPt, sample.point, nextTan);
    const localOffset = dist(sample.point, referenceHit.point);
    const elevDiff =
      currentElevation !== null && sample.elevation !== null
        ? Math.abs(sample.elevation - currentElevation)
        : null;

    const commonScore =
      (guideAngle + arrivalAngle * 0.75) * p.targetStreetAngleWeight +
      guideOffset * p.targetStreetGuideWeight +
      distance * p.targetStreetDistanceWeight +
      localOffset * p.targetStreetLocalWeight;

    const candidate = {
      streetIdx: targetStreetIdx,
      t: sample.t,
      point: sample.point,
      elevation: sample.elevation,
    };

    const fallbackScore = commonScore + (elevDiff ?? 0) * p.targetStreetFallbackElevationWeight;
    if (!bestFallback || fallbackScore < bestFallback.score) {
      bestFallback = { ...candidate, score: fallbackScore };
    }

    if (elevDiff !== null && elevDiff <= p.targetStreetElevationTolerance) {
      const matchedScore = commonScore + elevDiff * p.targetStreetElevationWeight;
      if (!bestMatched || matchedScore < bestMatched.score) {
        bestMatched = { ...candidate, score: matchedScore };
      }
    }
  }

  return bestMatched || bestFallback || {
    streetIdx: targetStreetIdx,
    t: referenceHit.t,
    point: referenceHit.point,
    elevation: sampleStreetElevationAtT(streetSampleProfiles[targetStreetIdx], referenceHit.t),
  };
}

function repairLandingOnStreet(current, targetStreetIdx, referenceHit, initialLanding, pathPrefix, guideDir, state, ctx) {
  const { paramsByStreet, streetSampleProfiles, zoneSet, waterMask, cs, W, H, ox, oz, p } = ctx;
  const { usedTsByStreet } = state;
  const currentIdx = current.streetIdx;
  const currentT = current.t;
  const currentPt = current.pt;
  const currentElevation = sampleStreetElevationAtT(streetSampleProfiles[currentIdx], currentT);
  const nextParam = paramsByStreet[targetStreetIdx];
  const samples = streetSampleProfiles[targetStreetIdx] || [];
  const repairBand = Math.max(p.landingRepairBand, p.streetSampleStep * 4);
  let best = null;

  for (const sample of samples) {
    const deltaT = Math.min(
      Math.abs(sample.t - referenceHit.t),
      Math.abs(sample.t - initialLanding.t),
    );
    if (deltaT > repairBand) continue;
    if (
      dist(sample.point, referenceHit.point) > repairBand * 1.8 &&
      dist(sample.point, initialLanding.point) > repairBand * 1.8
    ) {
      continue;
    }
    if (isTooClose(sample.t, usedTsByStreet[targetStreetIdx], p.minParcelDepth * p.nearDuplicateFactor)) continue;

    const delta = {
      x: sample.point.x - currentPt.x,
      z: sample.point.z - currentPt.z,
    };
    const forward = dot2(delta, guideDir);
    if (forward < p.minRibbonLength * 0.5) continue;

    const guideOffset = pointLineDistance(sample.point, currentPt, guideDir);
    if (guideOffset > p.targetStreetGuideTolerance * p.landingRepairGuideFactor) continue;

    const finalPolyline = compactPolyline([...pathPrefix, sample.point]);
    const length = polylineLength(finalPolyline);
    if (length < p.minRibbonLength || length > p.maxRibbonLength) continue;

    const validity = validateRibbonPolyline(finalPolyline, zoneSet, waterMask, cs, W, H, ox, oz);
    if (!validity.ok) continue;

    const nextTan = ribbonTangentAtArcLength(nextParam, sample.t, p);
    const finalStep = finalPolyline[finalPolyline.length - 2];
    const approachAngle = perpendicularAngleError(finalStep, sample.point, nextTan);
    if (approachAngle > p.fallbackMaxAngleOff) continue;

    const guideAngle = guideAngleError(currentPt, sample.point, guideDir);
    const localOffset = Math.min(
      dist(sample.point, referenceHit.point),
      dist(sample.point, initialLanding.point),
    );
    const elevDiff =
      currentElevation !== null && sample.elevation !== null
        ? Math.abs(sample.elevation - currentElevation)
        : null;

    const score =
      approachAngle * p.targetStreetAngleWeight * p.landingRepairAngleFactor +
      guideAngle * p.targetStreetAngleWeight * 0.6 +
      guideOffset * p.targetStreetGuideWeight * p.landingRepairGuideFactor +
      localOffset * p.targetStreetLocalWeight * p.landingRepairLocalFactor +
      length * p.targetStreetDistanceWeight * p.landingRepairDistanceFactor +
      (elevDiff ?? 0) * p.targetStreetFallbackElevationWeight;

    if (!best || score < best.score) {
      best = {
        landing: {
          streetIdx: targetStreetIdx,
          t: sample.t,
          point: sample.point,
          elevation: sample.elevation,
        },
        finalPolyline,
        finalStep,
        nextTan,
        approachAngle,
        length,
        score,
      };
    }
  }

  return best;
}

function buildStreetSampleProfiles(paramsByStreet, map, p) {
  const elevation = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
  return paramsByStreet.map(param => buildStreetSampleProfile(param, elevation, map, p));
}

function buildStreetSampleProfile(param, elevation, map, p) {
  if (!param || param.totalLength <= 1e-9) return [];

  const margin = Math.min(p.edgeMargin, param.totalLength * 0.5);
  const startT = margin;
  const endT = Math.max(startT, param.totalLength - margin);
  const samples = [];
  for (const t of sampleRange(startT, endT, p.streetSampleStep, endT)) {
    const point = pointAtArcLength(param, t);
    samples.push({
      t,
      point,
      elevation: sampleElevationAtWorld(elevation, map, point),
    });
  }
  return samples;
}

function sampleStreetElevationAtT(profile, t) {
  if (!profile || profile.length === 0) return null;
  let best = profile[0];
  let bestDelta = Math.abs(profile[0].t - t);
  for (let i = 1; i < profile.length; i++) {
    const delta = Math.abs(profile[i].t - t);
    if (delta < bestDelta) {
      best = profile[i];
      bestDelta = delta;
    }
  }
  return best.elevation ?? null;
}

function sampleElevationAtWorld(elevation, map, point) {
  if (!elevation || !point) return null;
  if (typeof elevation.sampleWorld === 'function') {
    return elevation.sampleWorld(point.x, point.z);
  }
  if (typeof elevation.get === 'function') {
    const gx = Math.round((point.x - map.originX) / map.cellSize);
    const gz = Math.round((point.z - map.originZ) / map.cellSize);
    return elevation.get(gx, gz);
  }
  return null;
}

function buildAnchorSequence(totalLength, p, centerT = totalLength * 0.5) {
  const anchors = [];
  const mid = clamp(centerT, p.edgeMargin, totalLength - p.edgeMargin);
  const seedCount = Math.max(1, p.initialSeedCount ?? 1);
  for (let step = 0; step < seedCount; step++) {
    const delta = step * p.targetDepth;
    if (step === 0) {
      if (mid >= p.edgeMargin && mid <= totalLength - p.edgeMargin) anchors.push(mid);
      continue;
    }
    const up = mid + delta;
    const down = mid - delta;
    if (up <= totalLength - p.edgeMargin) anchors.push(up);
    if (down >= p.edgeMargin) anchors.push(down);
    if (up > totalLength - p.edgeMargin && down < p.edgeMargin) break;
  }
  return anchors;
}

function enqueuePendingAnchor(queue, queuedAnchorKeys, streetIdx, t, p, meta = {}) {
  if (!Number.isFinite(t)) return null;
  const quant = Math.max(1, p.streetSampleStep || p.searchStep || 1);
  const key = `${streetIdx}:${Math.round(t / quant)}`;
  if (queuedAnchorKeys.has(key)) return null;
  queuedAnchorKeys.add(key);
  const anchor = {
    streetIdx,
    t,
    ...meta,
  };
  queue.push(anchor);
  return anchor;
}

function findRemainingGapSeedAnchor(paramsByStreet, usedTsByStreet, p) {
  const minGap = p.fillGapThreshold > 0
    ? p.fillGapThreshold
    : Math.max(p.parallelReseedSpacing, p.targetDepth) * 1.35;

  let bestUnused = null;
  let bestAny = null;

  for (let streetIdx = 0; streetIdx < paramsByStreet.length; streetIdx++) {
    const param = paramsByStreet[streetIdx];
    if (!param || param.totalLength <= p.edgeMargin * 2) continue;

    const usedTs = [...(usedTsByStreet[streetIdx] || [])]
      .filter(t => Number.isFinite(t) && t >= p.edgeMargin && t <= param.totalLength - p.edgeMargin)
      .sort((a, b) => a - b);
    const gaps = findStreetAnchorGaps(param.totalLength, usedTs, p);
    for (const gap of gaps) {
      if (gap.length < minGap) continue;
      const candidate = {
        streetIdx,
        t: gap.mid,
        gap: gap.length,
        unused: usedTs.length === 0,
      };
      if (candidate.unused) {
        if (!bestUnused || candidate.gap > bestUnused.gap) bestUnused = candidate;
      } else if (!bestAny || candidate.gap > bestAny.gap) {
        bestAny = candidate;
      }
    }
  }

  if (p.fillUnusedStreetSeedsOnly) return bestUnused;
  if (p.fillGapPreferUsedStreet) return bestAny || bestUnused;
  return bestUnused || bestAny;
}

function findNearestGuideRowOnStreet(rows, streetIdx, targetT) {
  let best = null;
  for (const row of rows) {
    if (!row?.streetPoints?.length) continue;
    for (const point of row.streetPoints) {
      if (point.streetIdx !== streetIdx) continue;
      const delta = Math.abs(point.t - targetT);
      if (!best || delta < best.delta) {
        best = { delta, rowId: row.rowId };
      }
    }
  }
  return best?.rowId ?? null;
}

function findStreetAnchorGaps(totalLength, usedTs, p) {
  const bounds = [
    p.edgeMargin,
    ...usedTs,
    totalLength - p.edgeMargin,
  ].sort((a, b) => a - b);

  const gaps = [];
  for (let i = 1; i < bounds.length; i++) {
    const start = bounds[i - 1];
    const end = bounds[i];
    const length = end - start;
    if (length <= 1e-6) continue;
    gaps.push({
      start,
      end,
      length,
      mid: start + length * 0.5,
    });
  }
  return gaps;
}

function deriveParallelReseedAnchors(streetPoints, paramsByStreet, p) {
  const spacingInfo = computeParallelSpacingInfo(streetPoints, paramsByStreet, p);
  if (!spacingInfo) return [];
  const { pivot, spacing, param } = spacingInfo;
  const anchors = [];
  for (const sign of [-1, 1]) {
    const shiftedT = clamp(pivot.point.t + sign * spacing, p.edgeMargin, param.totalLength - p.edgeMargin);
    if (Math.abs(shiftedT - pivot.point.t) < Math.max(1, p.streetSampleStep || 1)) continue;
    anchors.push({
      streetIdx: pivot.point.streetIdx,
      t: shiftedT,
    });
  }
  return anchors;
}

function deriveFamilySlotAnchors(baseRow, paramsByStreet, usedTsByStreet, p) {
  const spacingInfo = computeParallelSpacingInfo(baseRow.streetPoints, paramsByStreet, p);
  if (!spacingInfo) return [];
  const { pivot, spacing, param } = spacingInfo;
  const minSeparation = Math.max(1, p.streetSampleStep || p.searchStep || 1);
  const maxPositive = Math.floor((param.totalLength - p.edgeMargin - pivot.point.t) / spacing);
  const maxNegative = Math.floor((pivot.point.t - p.edgeMargin) / spacing);
  const anchors = [];

  for (let step = 1; step <= Math.max(maxPositive, maxNegative); step++) {
    if (step <= maxNegative) {
      const shiftedT = pivot.point.t - step * spacing;
      if (!isTooClose(shiftedT, usedTsByStreet[pivot.point.streetIdx], minSeparation)) {
        anchors.push({
          streetIdx: pivot.point.streetIdx,
          t: shiftedT,
          slotIndex: -step,
        });
      }
    }
    if (step <= maxPositive) {
      const shiftedT = pivot.point.t + step * spacing;
      if (!isTooClose(shiftedT, usedTsByStreet[pivot.point.streetIdx], minSeparation)) {
        anchors.push({
          streetIdx: pivot.point.streetIdx,
          t: shiftedT,
          slotIndex: step,
        });
      }
    }
  }

  return anchors;
}

function computeParallelSpacingInfo(streetPoints, paramsByStreet, p) {
  if (!streetPoints || streetPoints.length === 0) return null;
  const pivot = chooseParallelPivotStreetPoint(streetPoints);
  if (!pivot) return null;
  const param = paramsByStreet[pivot.point.streetIdx];
  if (!param || param.totalLength <= 1e-9) return null;

  let spacing = p.parallelReseedSpacing > 0 ? p.parallelReseedSpacing : p.targetDepth;
  if (p.parallelMinRoadGap > 0) {
    const rowDir = estimateStreetPointDirection(streetPoints, pivot.index);
    const streetTan = ribbonTangentAtArcLength(param, pivot.point.t, p);
    const sin = rowDir ? crossMagnitude2(rowDir, streetTan) : 1;
    const requiredSpacing = p.parallelMinRoadGap / Math.max(sin, p.parallelGapMinSin);
    spacing = Math.max(spacing, requiredSpacing);
  }

  return { pivot, spacing, param };
}

function chooseParallelPivotStreetPoint(streetPoints) {
  if (!streetPoints || streetPoints.length === 0) return null;
  const index = Math.floor(streetPoints.length / 2);
  return {
    point: streetPoints[index] || streetPoints[streetPoints.length - 1],
    index,
  };
}

function validateParallelChildRow(ribbon, parentRow, paramsByStreet, p) {
  const shared = buildParallelSharedPoints(ribbon, parentRow);

  if (p.parallelRejectCrossovers) {
    const crossing = findParallelRowCrossover(ribbon, parentRow);
    if (crossing) {
      return {
        ok: false,
        reason: 'parallel-cross',
        streetIdx: crossing.streetIdx,
        childSegmentEndIndex: crossing.childSegmentEndIndex,
        stopPoint: crossing.point,
        projectedPoint: crossing.point,
      };
    }
  }

  if (p.parallelKeepSide) {
    const sideCheck = validateParallelRowSide(shared, p);
    if (!sideCheck.ok) return sideCheck;
  }

  if (p.parallelMaxAngleDeltaDeg < 180) {
    const angleCheck = validateParallelRowAngle(shared, p);
    if (!angleCheck.ok) return angleCheck;
  }

  if (p.parallelMinRoadGap > 0) {
    const gapCheck = validateParallelRowGap(shared, paramsByStreet, p);
    if (!gapCheck.ok) return gapCheck;
  }

  return { ok: true };
}

function findRibbonRelationFailure(ribbon, parentRow, existingRows, paramsByStreet, p) {
  if (parentRow) {
    const relationCheck = validateParallelChildRow(ribbon, parentRow, paramsByStreet, p);
    if (!relationCheck.ok) {
      return {
        ...relationCheck,
        conflictRowId: parentRow.rowId,
      };
    }
  }

  if (!p.parallelValidateAgainstAllRows) return null;

  for (const existingRow of existingRows) {
    if (!existingRow || existingRow.rowId === parentRow?.rowId) continue;
    const relationCheck = validateGlobalRibbonRelation(ribbon, existingRow, paramsByStreet, p);
    if (!relationCheck.ok) {
      return {
        ...relationCheck,
        conflictRowId: existingRow.rowId,
      };
    }
  }

  return null;
}

function validateGlobalRibbonRelation(ribbon, existingRow, paramsByStreet, p) {
  const shared = buildParallelSharedPoints(ribbon, existingRow);

  if (p.parallelGlobalCheckCross && p.parallelRejectCrossovers) {
    const crossing = findParallelRowCrossover(ribbon, existingRow);
    if (crossing) {
      return {
        ok: false,
        reason: 'parallel-cross',
        streetIdx: crossing.streetIdx,
        childSegmentEndIndex: crossing.childSegmentEndIndex,
        stopPoint: crossing.point,
        projectedPoint: crossing.point,
      };
    }
  }

  if (p.parallelGlobalCheckSide && p.parallelKeepSide) {
    const sideCheck = validateParallelRowSide(shared, p);
    if (!sideCheck.ok) return sideCheck;
  }

  if (p.parallelGlobalCheckAngle && p.parallelMaxAngleDeltaDeg < 180) {
    const angleCheck = validateParallelRowAngle(shared, p);
    if (!angleCheck.ok) return angleCheck;
  }

  if (p.parallelGlobalCheckGap && p.parallelMinRoadGap > 0) {
    const gapCheck = validateParallelRowGap(shared, paramsByStreet, p);
    if (!gapCheck.ok) return gapCheck;
  }

  return { ok: true };
}

export function truncateRibbonAtRelationFailure(ribbon, relationCheck, anchorStreetIdx, anchorT, p) {
  if (!ribbon?.streetPoints || ribbon.streetPoints.length < 2 || !relationCheck) return null;

  const anchorIndex = findRibbonAnchorIndex(ribbon.streetPoints, anchorStreetIdx, anchorT);
  if (anchorIndex < 0) return null;

  let keepStart = 0;
  let keepEnd = ribbon.streetPoints.length - 1;

  if (Number.isInteger(relationCheck.childIndex)) {
    if (relationCheck.childIndex > anchorIndex) {
      keepEnd = relationCheck.childIndex - 1;
    } else if (relationCheck.childIndex < anchorIndex) {
      keepStart = relationCheck.childIndex + 1;
    } else {
      return null;
    }
  } else if (Number.isInteger(relationCheck.childSegmentEndIndex)) {
    if (relationCheck.childSegmentEndIndex > anchorIndex) {
      keepEnd = relationCheck.childSegmentEndIndex - 1;
    } else if (relationCheck.childSegmentEndIndex <= anchorIndex) {
      keepStart = relationCheck.childSegmentEndIndex;
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (keepStart > anchorIndex || keepEnd < anchorIndex) return null;
  if (keepEnd - keepStart + 1 < 2) return null;

  const streetPoints = ribbon.streetPoints.slice(keepStart, keepEnd + 1);
  const points = compactPolyline(streetPoints.map(point => point.pt));
  const length = polylineLength(points);
  if (points.length < 2 || length < p.minRibbonLength) return null;

  return {
    ...ribbon,
    points,
    streetPoints,
    length,
    centerT: anchorT,
  };
}

function findRibbonAnchorIndex(streetPoints, anchorStreetIdx, anchorT) {
  let bestIndex = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < streetPoints.length; i++) {
    const point = streetPoints[i];
    if (point.streetIdx !== anchorStreetIdx) continue;
    const delta = Math.abs(point.t - anchorT);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function buildParallelSharedPoints(ribbon, parentRow) {
  const parentByStreet = new Map();
  for (let i = 0; i < parentRow.streetPoints.length; i++) {
    parentByStreet.set(parentRow.streetPoints[i].streetIdx, {
      point: parentRow.streetPoints[i],
      index: i,
    });
  }

  const shared = [];
  for (let i = 0; i < ribbon.streetPoints.length; i++) {
    const childPoint = ribbon.streetPoints[i];
    const parentMatch = parentByStreet.get(childPoint.streetIdx);
    if (!parentMatch) continue;
    shared.push({
      streetIdx: childPoint.streetIdx,
      childPoint,
      childIndex: i,
      parentPoint: parentMatch.point,
      parentIndex: parentMatch.index,
      childRowPoints: ribbon.streetPoints,
      parentRowPoints: parentRow.streetPoints,
    });
  }
  return shared;
}

function validateParallelRowGap(shared, paramsByStreet, p) {
  let worst = null;
  for (const match of shared) {
    const { childPoint, childIndex, parentPoint, parentIndex, streetIdx } = match;
    const streetTan = ribbonTangentAtArcLength(paramsByStreet[childPoint.streetIdx], childPoint.t, p);
    const childDir = estimateStreetPointDirection(match.childRowPoints, childIndex);
    const parentDir = estimateStreetPointDirection(match.parentRowPoints, parentIndex);
    const sinChild = childDir ? crossMagnitude2(childDir, streetTan) : 1;
    const sinParent = parentDir ? crossMagnitude2(parentDir, streetTan) : sinChild;
    const spacingFactor = Math.max(p.parallelGapMinSin, (sinChild + sinParent) * 0.5);
    const gap = Math.abs(childPoint.t - parentPoint.t) * spacingFactor;

    if (!worst || gap < worst.gap) {
      worst = {
        ok: gap >= p.parallelMinRoadGap,
        gap,
        reason: 'parallel-gap',
        streetIdx,
        childIndex,
        parentIndex,
        childPoint,
        parentPoint,
      };
    }
  }

  return worst || { ok: true, gap: Infinity };
}

function validateParallelRowAngle(shared, p) {
  const maxAngle = p.parallelMaxAngleDeltaDeg * Math.PI / 180;
  let worst = null;

  for (const match of shared) {
    const childDir = estimateStreetPointDirectionFromShared(match, 'child');
    const parentDir = estimateStreetPointDirectionFromShared(match, 'parent');
    if (!childDir || !parentDir) continue;

    const dot = clamp(Math.abs(childDir.x * parentDir.x + childDir.z * parentDir.z), 0, 1);
    const angle = Math.acos(dot);
    if (!worst || angle > worst.angle) {
      worst = {
        ok: angle <= maxAngle,
        reason: 'parallel-angle',
        angle,
        streetIdx: match.streetIdx,
        childIndex: match.childIndex,
        parentIndex: match.parentIndex,
        childPoint: match.childPoint,
        parentPoint: match.parentPoint,
        stopPoint: match.childPoint.pt,
        projectedPoint: match.parentPoint.pt,
      };
    }
  }

  return worst || { ok: true, angle: 0 };
}

function validateParallelRowSide(shared, p) {
  let referenceSign = 0;
  let reference = null;

  for (const match of shared) {
    const parentDir = estimateStreetPointDirectionFromShared(match, 'parent');
    if (!parentDir) continue;
    const offset = {
      x: match.childPoint.pt.x - match.parentPoint.pt.x,
      z: match.childPoint.pt.z - match.parentPoint.pt.z,
    };
    const signedSide = signedCross2(parentDir, offset);
    if (Math.abs(signedSide) < p.parallelSideEpsilon) continue;
    const sign = Math.sign(signedSide);
    if (referenceSign === 0) {
      referenceSign = sign;
      reference = match;
      continue;
    }
    if (sign !== referenceSign) {
      return {
        ok: false,
        reason: 'parallel-side-flip',
        streetIdx: match.streetIdx,
        childIndex: match.childIndex,
        parentIndex: match.parentIndex,
        childPoint: match.childPoint,
        parentPoint: match.parentPoint,
        stopPoint: match.childPoint.pt,
        projectedPoint: reference?.childPoint?.pt || match.parentPoint.pt,
      };
    }
  }

  return { ok: true };
}

function findParallelRowCrossover(ribbon, parentRow) {
  const eps = 1e-6;
  for (let i = 1; i < ribbon.points.length; i++) {
    const a1 = ribbon.points[i - 1];
    const a2 = ribbon.points[i];
    for (let j = 1; j < parentRow.points.length; j++) {
      const b1 = parentRow.points[j - 1];
      const b2 = parentRow.points[j];
      const hit = properSegmentIntersection(a1, a2, b1, b2, eps);
      if (hit) {
        return {
          point: hit,
          streetIdx: nearestSharedStreetIdxForCrossover(ribbon, parentRow, hit),
          childSegmentEndIndex: nearestStreetPointIndexForPoint(ribbon.streetPoints, hit, i),
        };
      }
    }
  }
  return null;
}

function properSegmentIntersection(a1, a2, b1, b2, eps = 1e-6) {
  const dx1 = a2.x - a1.x;
  const dz1 = a2.z - a1.z;
  const dx2 = b2.x - b1.x;
  const dz2 = b2.z - b1.z;
  const denom = dx1 * dz2 - dz1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;

  const dx3 = b1.x - a1.x;
  const dz3 = b1.z - a1.z;
  const t = (dx3 * dz2 - dz3 * dx2) / denom;
  const u = (dx3 * dz1 - dz3 * dx1) / denom;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;

  return {
    x: a1.x + t * dx1,
    z: a1.z + t * dz1,
  };
}

function nearestSharedStreetIdxForCrossover(ribbon, parentRow, point) {
  const shared = buildParallelSharedPoints(ribbon, parentRow);
  let best = null;
  for (const match of shared) {
    const d = dist(match.childPoint.pt, point);
    if (!best || d < best.d) {
      best = { d, streetIdx: match.streetIdx };
    }
  }
  return best?.streetIdx ?? null;
}

function nearestStreetPointIndexForPoint(streetPoints, point, fallback = 0) {
  let best = null;
  for (let i = 0; i < streetPoints.length; i++) {
    const d = dist(streetPoints[i].pt, point);
    if (!best || d < best.d) {
      best = { d, i };
    }
  }
  return best?.i ?? fallback;
}

function estimateStreetPointDirectionFromShared(match, which) {
  const points = which === 'parent'
    ? match.parentRowPoints
    : match.childRowPoints;
  if (points) return estimateStreetPointDirection(points, which === 'parent' ? match.parentIndex : match.childIndex);
  return null;
}

function estimateStreetPointDirection(streetPoints, index) {
  const current = streetPoints[index]?.pt;
  if (!current) return null;
  const prev = index > 0 ? streetPoints[index - 1]?.pt : null;
  const next = index + 1 < streetPoints.length ? streetPoints[index + 1]?.pt : null;
  if (prev && next) {
    return normalize({
      x: next.x - prev.x,
      z: next.z - prev.z,
    });
  }
  if (prev) {
    return normalize({
      x: current.x - prev.x,
      z: current.z - prev.z,
    });
  }
  if (next) {
    return normalize({
      x: next.x - current.x,
      z: next.z - current.z,
    });
  }
  return null;
}

function chooseSeedStreetAndAnchor(paramsByStreet, zone, ox, oz, cs, p) {
  const targetPoint = {
    x: ox + zone.centroidGx * cs,
    z: oz + zone.centroidGz * cs,
  };

  let best = null;
  for (let streetIdx = 0; streetIdx < paramsByStreet.length; streetIdx++) {
    const hit = closestArcLengthToPoint(paramsByStreet[streetIdx], targetPoint, p.edgeMargin);
    const score = dist(hit.point, targetPoint);
    if (!best || score < best.score) {
      best = {
        streetIdx,
        t: hit.t,
        point: hit.point,
        score,
      };
    }
  }

  if (best) return best;

  const fallbackStreetIdx = Math.floor(paramsByStreet.length / 2);
  const fallbackT = clamp(paramsByStreet[fallbackStreetIdx].totalLength * 0.5, p.edgeMargin, paramsByStreet[fallbackStreetIdx].totalLength - p.edgeMargin);
  return {
    streetIdx: fallbackStreetIdx,
    t: fallbackT,
    point: pointAtArcLength(paramsByStreet[fallbackStreetIdx], fallbackT),
    score: 0,
  };
}

function buildGuideDirection(baseGuideDir, rowDir, contourDir, p) {
  const dirs = [{ dir: normalize(baseGuideDir), weight: p.perpendicularGuideBlend }];
  if (rowDir) dirs.push({
    dir: orientLike(rowDir, baseGuideDir),
    weight: p.continuationGuideBlend,
  });
  if (contourDir) dirs.push({
    dir: orientLike(contourDir, baseGuideDir),
    weight: p.contourGuideBlend,
  });
  return blendUnitVectors(dirs);
}

function contourDirectionFromZone(zone) {
  if (!zone || !zone.slopeDir) return null;
  const slopeLen = Math.sqrt(zone.slopeDir.x * zone.slopeDir.x + zone.slopeDir.z * zone.slopeDir.z);
  if (slopeLen < 1e-6) return null;
  return normalize({
    x: -zone.slopeDir.z,
    z: zone.slopeDir.x,
  });
}

function contourDirectionAtPoint(point, gradField, fallbackContourDir) {
  if (gradField?.getGradWorld && point) {
    const grad = gradField.getGradWorld(point.x, point.z);
    const mag = Math.sqrt(grad.x * grad.x + grad.z * grad.z);
    if (mag > 1e-6) {
      return normalize({
        x: -grad.z,
        z: grad.x,
      });
    }
  }
  return fallbackContourDir || null;
}

function orientLike(dir, referenceDir) {
  const nDir = normalize(dir);
  const nRef = normalize(referenceDir);
  return dot2(nDir, nRef) >= 0
    ? nDir
    : { x: -nDir.x, z: -nDir.z };
}

function blendUnitVectors(weightedDirs) {
  let x = 0;
  let z = 0;
  let total = 0;
  for (const entry of weightedDirs) {
    if (!entry || !entry.dir || !Number.isFinite(entry.weight) || entry.weight <= 0) continue;
    x += entry.dir.x * entry.weight;
    z += entry.dir.z * entry.weight;
    total += entry.weight;
  }
  if (total <= 0) return { x: 1, z: 0 };
  return normalize({ x, z });
}

function isTooClose(t, usedTs, minDelta) {
  return usedTs.some(other => Math.abs(other - t) < minDelta);
}

function closestDistanceTo(t, usedTs) {
  if (usedTs.length === 0) return Infinity;
  let best = Infinity;
  for (const other of usedTs) best = Math.min(best, Math.abs(other - t));
  return best;
}

function ingestTrace(trace, failedRibbons, failureCounts) {
  mergeCounts(failureCounts, trace.counts);
  failedRibbons.push(...trace.failedRibbons);
}

function annotateTraceFailures(trace, meta = {}) {
  if (!trace?.failedRibbons?.length) return;
  for (const failure of trace.failedRibbons) {
    Object.assign(failure, meta);
  }
}

function createTrace() {
  return {
    counts: {},
    failedRibbons: [],
    angleRejects: 0,
  };
}

function buildIndexedFailure(reason, startPoint, points, extras = {}) {
  const attemptPath = compactPolyline(points);
  return {
    points: attemptPath,
    attemptPath,
    reason,
    source: 'indexed-guide',
    guideLine: attemptPath,
    startPoint,
    ...extras,
  };
}

function primaryTraceReason(trace) {
  if (!trace) return 'build-failed';
  if (trace.failedRibbons?.length) {
    return trace.failedRibbons[trace.failedRibbons.length - 1].reason;
  }
  let bestReason = 'build-failed';
  let bestCount = 0;
  for (const [reason, count] of Object.entries(trace.counts || {})) {
    if (count > bestCount) {
      bestReason = reason;
      bestCount = count;
    }
  }
  return bestReason;
}

function mergeTraceInto(target, source) {
  mergeCounts(target.counts, source.counts);
  target.failedRibbons.push(...source.failedRibbons);
  target.angleRejects += source.angleRejects;
}

function mergeCounts(target, counts) {
  for (const [reason, count] of Object.entries(counts)) {
    target[reason] = (target[reason] || 0) + count;
  }
}

function addReasonCount(target, reason) {
  target[reason] = (target[reason] || 0) + 1;
}

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  );
}

function guideAngleError(ptA, ptB, guideNormal) {
  const dir = normalize({ x: ptB.x - ptA.x, z: ptB.z - ptA.z });
  const dot = clamp(Math.abs(dir.x * guideNormal.x + dir.z * guideNormal.z), 0, 1);
  return Math.acos(dot);
}

function directionAngleError(a, b) {
  if (!a || !b) return 0;
  const dot = clamp(a.x * b.x + a.z * b.z, -1, 1);
  return Math.acos(dot);
}

function pointLineDistance(pt, linePoint, lineDir) {
  const dx = pt.x - linePoint.x;
  const dz = pt.z - linePoint.z;
  return Math.abs(dx * lineDir.z - dz * lineDir.x);
}

function perpendicularAngleError(ptA, ptB, tangentA) {
  const ribbonDx = ptB.x - ptA.x;
  const ribbonDz = ptB.z - ptA.z;
  const ribbonLen = Math.sqrt(ribbonDx * ribbonDx + ribbonDz * ribbonDz);
  if (ribbonLen < 1e-6) return Infinity;

  const normalX = -tangentA.z;
  const normalZ = tangentA.x;
  const dot = (ribbonDx / ribbonLen) * normalX + (ribbonDz / ribbonLen) * normalZ;
  return Math.acos(Math.min(1, Math.abs(dot)));
}

function validateRibbon(ptA, ptB, zoneSet, waterMask, cs, W, H, ox, oz) {
  const steps = Math.ceil(dist(ptA, ptB) / (cs * 0.5));
  if (steps <= 0) return { ok: false, reason: 'too-short' };

  let inZoneCount = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wx = ptA.x + (ptB.x - ptA.x) * t;
    const wz = ptA.z + (ptB.z - ptA.z) * t;
    const gx = Math.round((wx - ox) / cs);
    const gz = Math.round((wz - oz) / cs);

    if (gx < 0 || gx >= W || gz < 0 || gz >= H) return { ok: false, reason: 'off-map' };
    if (waterMask && waterMask.get(gx, gz) > 0) return { ok: false, reason: 'water' };
    if (zoneSet.has(gz * W + gx)) inZoneCount++;
  }

  if (inZoneCount / (steps + 1) < 0.5) return { ok: false, reason: 'out-of-zone' };
  return { ok: true };
}

function validateRibbonPolyline(points, zoneSet, waterMask, cs, W, H, ox, oz) {
  if (!points || points.length < 2) return { ok: false, reason: 'too-short' };

  let inZoneCount = 0;
  let totalCount = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.max(1, Math.ceil(dist(a, b) / (cs * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const wx = a.x + (b.x - a.x) * t;
      const wz = a.z + (b.z - a.z) * t;
      const gx = Math.round((wx - ox) / cs);
      const gz = Math.round((wz - oz) / cs);

      if (gx < 0 || gx >= W || gz < 0 || gz >= H) return { ok: false, reason: 'off-map' };
      if (waterMask && waterMask.get(gx, gz) > 0) return { ok: false, reason: 'water' };
      if (zoneSet.has(gz * W + gx)) inZoneCount++;
      totalCount++;
    }
  }

  if (totalCount <= 0) return { ok: false, reason: 'too-short' };
  if (inZoneCount / totalCount < 0.5) return { ok: false, reason: 'out-of-zone' };
  return { ok: true };
}

function parameterise(points) {
  const cumLen = [0];
  for (let i = 1; i < points.length; i++) {
    cumLen.push(cumLen[i - 1] + dist(points[i - 1], points[i]));
  }
  return {
    points,
    cumLen,
    totalLength: cumLen[cumLen.length - 1],
    averageTangent: averageTangentForPoints(points),
  };
}

function pointAtArcLength(param, t) {
  const { points, cumLen, totalLength } = param;
  if (t <= 0) return { x: points[0].x, z: points[0].z };
  if (t >= totalLength) return { x: points[points.length - 1].x, z: points[points.length - 1].z };

  let lo = 0;
  let hi = cumLen.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] <= t) lo = mid;
    else hi = mid;
  }

  const segLen = cumLen[hi] - cumLen[lo];
  if (segLen < 1e-9) return { x: points[lo].x, z: points[lo].z };

  const frac = (t - cumLen[lo]) / segLen;
  return {
    x: points[lo].x + (points[hi].x - points[lo].x) * frac,
    z: points[lo].z + (points[hi].z - points[lo].z) * frac,
  };
}

function closestArcLengthToPoint(param, targetPoint, edgeMargin = 0) {
  const { points, cumLen, totalLength } = param;
  if (points.length === 0) {
    return { t: 0, point: { x: targetPoint.x, z: targetPoint.z } };
  }
  if (points.length === 1 || totalLength <= 1e-9) {
    return {
      t: 0,
      point: { x: points[0].x, z: points[0].z },
    };
  }

  let bestT = clamp(totalLength * 0.5, edgeMargin, totalLength - edgeMargin);
  let bestPoint = pointAtArcLength(param, bestT);
  let bestDistSq = distSq(bestPoint, targetPoint);

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segDx = b.x - a.x;
    const segDz = b.z - a.z;
    const segLenSq = segDx * segDx + segDz * segDz;
    if (segLenSq < 1e-9) continue;

    let frac = ((targetPoint.x - a.x) * segDx + (targetPoint.z - a.z) * segDz) / segLenSq;
    frac = clamp(frac, 0, 1);

    let t = cumLen[i - 1] + frac * Math.sqrt(segLenSq);
    t = clamp(t, edgeMargin, totalLength - edgeMargin);
    const pt = pointAtArcLength(param, t);
    const dSq = distSq(pt, targetPoint);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestT = t;
      bestPoint = pt;
    }
  }

  return { t: bestT, point: bestPoint };
}

function firstRayHitOnStreet(param, origin, dir, edgeMargin = 0) {
  const { points, cumLen, totalLength } = param;
  let best = null;
  const eps = 1e-9;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = { x: b.x - a.x, z: b.z - a.z };
    const denom = signedCross2(dir, seg);
    if (Math.abs(denom) < eps) continue;

    const delta = { x: a.x - origin.x, z: a.z - origin.z };
    const s = signedCross2(delta, seg) / denom;
    const u = signedCross2(delta, dir) / denom;
    if (s < 0 || u < 0 || u > 1) continue;

    const segLen = Math.hypot(seg.x, seg.z);
    const t = clamp(cumLen[i - 1] + u * segLen, edgeMargin, totalLength - edgeMargin);
    if (t < edgeMargin || t > totalLength - edgeMargin) continue;
    const point = pointAtArcLength(param, t);
    if (!best || s < best.s) {
      best = { s, t, point };
    }
  }

  return best ? { t: best.t, point: best.point } : null;
}

function tangentAtArcLength(param, t) {
  const { points, cumLen, totalLength } = param;
  t = clamp(t, 0, totalLength);

  let lo = 0;
  let hi = cumLen.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] <= t) lo = mid;
    else hi = mid;
  }

  const dx = points[hi].x - points[lo].x;
  const dz = points[hi].z - points[lo].z;
  const segLen = Math.sqrt(dx * dx + dz * dz);
  if (segLen < 1e-9) return { x: 1, z: 0 };
  return { x: dx / segLen, z: dz / segLen };
}

function smoothedTangentAtArcLength(param, t, window) {
  if (!Number.isFinite(window) || window <= 0) return tangentAtArcLength(param, t);
  const startT = clamp(t - window, 0, param.totalLength);
  const endT = clamp(t + window, 0, param.totalLength);
  if (endT - startT < 1e-3) return tangentAtArcLength(param, t);
  const a = pointAtArcLength(param, startT);
  const b = pointAtArcLength(param, endT);
  return normalize({ x: b.x - a.x, z: b.z - a.z });
}

function ribbonTangentAtArcLength(param, t, p) {
  if (p.tangentMode === 'whole-street-average' && param.averageTangent) {
    return param.averageTangent;
  }
  if (p.tangentMode === 'local-segment') {
    return tangentAtArcLength(param, t);
  }
  return smoothedTangentAtArcLength(param, t, p.tangentSampleWindow);
}

function tangentNormalAtArcLength(param, t, p) {
  const tangent = ribbonTangentAtArcLength(param, t, p);
  return normalize({ x: -tangent.z, z: tangent.x });
}

function averageTangentForPoints(points) {
  if (!points || points.length < 2) return { x: 0, z: 1 };

  let sumX = 0;
  let sumZ = 0;
  let ref = null;

  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 1e-9) continue;

    let dir = { x: dx / segLen, z: dz / segLen };
    if (!ref) ref = dir;
    dir = orientLike(dir, ref);
    sumX += dir.x * segLen;
    sumZ += dir.z * segLen;
  }

  if (Math.abs(sumX) < 1e-6 && Math.abs(sumZ) < 1e-6) {
    const start = points[0];
    const end = points[points.length - 1];
    return normalize({ x: end.x - start.x, z: end.z - start.z });
  }

  return normalize({ x: sumX, z: sumZ });
}

function sampleRange(start, end, step, target) {
  const samples = [];
  const seen = new Set();

  for (let t = start; t <= end + 1e-6; t += step) {
    const rounded = Math.round(Math.min(t, end) * 1000) / 1000;
    if (!seen.has(rounded)) {
      seen.add(rounded);
      samples.push(rounded);
    }
  }

  if (target >= start - 1e-6 && target <= end + 1e-6) {
    const rounded = Math.round(target * 1000) / 1000;
    if (!seen.has(rounded)) samples.push(rounded);
  }

  return samples;
}

function normalize(v) {
  const len = Math.sqrt(v.x * v.x + v.z * v.z);
  if (len < 1e-9) return { x: 0, z: 1 };
  return { x: v.x / len, z: v.z / len };
}

function dot2(a, b) {
  return a.x * b.x + a.z * b.z;
}

function crossMagnitude2(a, b) {
  return Math.abs(a.x * b.z - a.z * b.x);
}

function signedCross2(a, b) {
  return a.x * b.z - a.z * b.x;
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

function compactPolyline(points, epsilon = 0.5) {
  if (!points || points.length === 0) return [];
  const out = [{ x: points[0].x, z: points[0].z }];
  const epsSq = epsilon * epsilon;
  for (let i = 1; i < points.length; i++) {
    if (distSq(points[i], out[out.length - 1]) <= epsSq) continue;
    out.push({ x: points[i].x, z: points[i].z });
  }
  return out;
}

function appendPolylineSegment(target, segment) {
  if (!segment || segment.length === 0) return;
  const startIdx = target.length > 0 && distSq(target[target.length - 1], segment[0]) < 1e-6 ? 1 : 0;
  for (let i = startIdx; i < segment.length; i++) {
    target.push({ x: segment[i].x, z: segment[i].z });
  }
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
