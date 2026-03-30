/**
 * Ribbons — contour-following streets built as chained street-to-street walks.
 *
 * The current experiment seeds near the sector centroid, then grows in both
 * perpendicular directions by repeatedly:
 * - launching from the exact junction created by the last step
 * - marching a guide with strong local perpendicular bias and a weak local
 *   contour pull from the terrain gradient field
 * - accepting the first new cross street that the guide actually hits
 *
 * There is intentionally no global street ordering or corridor index in the
 * active walk. Failures are still traced so the renderer can draw them.
 */

import { buildStreetIndexBitmap, lookupStreetIds } from './streetIndexBitmap.js';
import { buildGradientField } from './constructionLines.js';

export function layRibbons(crossStreets, zone, map, params = {}) {
  const p = {
    targetDepth: 35,
    minRibbonLength: 15,
    maxRibbonLength: 200,
    minParcelDepth: 15,
    preferredMaxAngleOff: Math.PI / 6,
    fallbackMaxAngleOff: Math.PI / 3,
    maxGuideAngleOff: Math.PI / 4,
    guideLineTolerance: 18,
    searchStep: 5,
    neighborSearchBand: 42,
    maxSearchPerNeighbor: 14,
    maxRowsTotal: 1,
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
    guideMarchMaxFactor: 2.8,
    guideMarchMaxDistance: 220,
    streetIndexRadiusMeters: 5,
    ...params,
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
  const gradField = buildGradientField(zone, map, zoneSet);
  const streetIndex = buildStreetIndexBitmap(crossStreets, map, {
    radiusMeters: p.streetIndexRadiusMeters,
    stepSize: p.guideMarchStep,
  });
  const seedPlan = chooseSeedStreetAndAnchor(paramsByStreet, zone, ox, oz, cs, p);
  const zoneContourDir = contourDirectionFromZone(zone);
  const rows = [];
  const failedRibbons = [];
  const failureCounts = {};
  const seedAnchors = [];
  const usedTsByStreet = paramsByStreet.map(() => []);
  let angleRejects = 0;
  let nextRowId = 0;

  for (const anchorT of buildAnchorSequence(paramsByStreet[seedPlan.streetIdx].totalLength, p, seedPlan.t)) {
    if (isTooClose(anchorT, usedTsByStreet[seedPlan.streetIdx], p.minParcelDepth * p.nearDuplicateFactor)) {
      continue;
    }

    const anchorPoint = pointAtArcLength(paramsByStreet[seedPlan.streetIdx], anchorT);

    const result = buildAreaRow(
      seedPlan.streetIdx,
      anchorT,
      nextRowId,
      paramsByStreet,
      usedTsByStreet,
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
    );

    angleRejects += result.trace.angleRejects;
    ingestTrace(result.trace, failedRibbons, failureCounts);
    seedAnchors.push({
      rowId: nextRowId,
      streetIdx: seedPlan.streetIdx,
      t: anchorT,
      point: anchorPoint,
      accepted: !!result.ribbon,
    });

    if (!result.ribbon) continue;

    rows.push(result.ribbon);
    nextRowId++;
    for (const pointInfo of result.streetPoints) {
      usedTsByStreet[pointInfo.streetIdx].push(pointInfo.t);
    }
  }

  const orderedRows = [...rows].sort((a, b) => a.centerT - b.centerT);
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

function buildAreaRow(
  anchorStreetIdx,
  anchorT,
  rowId,
  paramsByStreet,
  usedTsByStreet,
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
) {
  const trace = createTrace();
  const anchorPoint = {
    streetIdx: anchorStreetIdx,
    t: anchorT,
    pt: pointAtArcLength(paramsByStreet[anchorStreetIdx], anchorT),
  };
  const left = extendStreetDirection(
    -1,
    anchorPoint,
    paramsByStreet,
    usedTsByStreet,
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
  );
  const right = extendStreetDirection(
    1,
    anchorPoint,
    paramsByStreet,
    usedTsByStreet,
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
  paramsByStreet,
  usedTsByStreet,
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
) {
  const trace = createTrace();
  const anchorParam = paramsByStreet[anchorPoint.streetIdx];
  const anchorTan = ribbonTangentAtArcLength(anchorParam, anchorPoint.t, p);
  const anchorNormal = normalize({
    x: -anchorTan.z * direction,
    z: anchorTan.x * direction,
  });
  let current = {
    streetIdx: anchorPoint.streetIdx,
    t: anchorPoint.t,
    pt: anchorPoint.pt,
  };
  let rowDir = null;
  let preferredGuideDir = anchorNormal;
  const polyline = [current.pt];
  const streetPoints = [current];
  const visitedStreetIdx = new Set([anchorPoint.streetIdx]);

  while (true) {
    const currentParam = paramsByStreet[current.streetIdx];

    const attempt = placeNextStreetPoint(
      current.streetIdx,
      current.t,
      current.pt,
      currentParam,
      paramsByStreet,
      usedTsByStreet,
      visitedStreetIdx,
      zoneSet,
      waterMask,
      streetIndex,
      cs,
      W,
      H,
      ox,
      oz,
      gradField,
      preferredGuideDir,
      rowDir,
      zoneContourDir,
      p,
    );
    mergeTraceInto(trace, attempt.trace);
    if (!attempt.point || !attempt.polyline || attempt.polyline.length < 2) break;

    appendPolylineSegment(polyline, attempt.polyline);

    const segmentDir = normalize({
      x: attempt.polyline[attempt.polyline.length - 1].x - attempt.polyline[Math.max(0, attempt.polyline.length - 2)].x,
      z: attempt.polyline[attempt.polyline.length - 1].z - attempt.polyline[Math.max(0, attempt.polyline.length - 2)].z,
    });
    rowDir = segmentDir;
    preferredGuideDir = segmentDir;
    current = {
      streetIdx: attempt.streetIdx,
      t: attempt.point.t,
      pt: attempt.point.pt,
    };
    visitedStreetIdx.add(current.streetIdx);
    streetPoints.push(current);
  }

  return {
    polyline,
    streetPoints,
    trace,
  };
}

function placeNextStreetPoint(
  currentIdx,
  currentT,
  currentPt,
  currentParam,
  paramsByStreet,
  usedTsByStreet,
  visitedStreetIdx,
  zoneSet,
  waterMask,
  streetIndex,
  cs,
  W,
  H,
  ox,
  oz,
  gradField,
  preferredGuideDir,
  rowDir,
  zoneContourDir,
  p,
) {
  const trace = createTrace();
  const baseGuideDir = preferredGuideDir
    ? normalize(preferredGuideDir)
    : normalize(tangentNormalAtArcLength(currentParam, currentT, p));
  const localContourDir = contourDirectionAtPoint(currentPt, gradField, zoneContourDir);
  const guideDir = buildGuideDirection(baseGuideDir, rowDir, localContourDir, p);
  const marched = marchGuideToAnyStreet(
    currentIdx,
    currentPt,
    paramsByStreet,
    usedTsByStreet,
    visitedStreetIdx,
    guideDir,
    gradField,
    zoneContourDir,
    zoneSet,
    waterMask,
    streetIndex,
    cs,
    W,
    H,
    ox,
    oz,
    p,
  );
  mergeTraceInto(trace, marched.trace);
  return {
    streetIdx: marched.streetIdx,
    point: marched.point,
    polyline: marched.polyline,
    trace,
  };
}

function marchGuideToAnyStreet(
  currentIdx,
  currentPt,
  paramsByStreet,
  usedTsByStreet,
  visitedStreetIdx,
  guideDir,
  gradField,
  zoneContourDir,
  zoneSet,
  waterMask,
  streetIndex,
  cs,
  W,
  H,
  ox,
  oz,
  p,
) {
  const trace = createTrace();
  const path = [{ x: currentPt.x, z: currentPt.z }];
  const maxDistance = p.guideMarchMaxDistance;
  const stepSize = Math.max(cs * 0.35, p.guideMarchStep);
  const minTravel = Math.max(cs, p.minRibbonLength * 0.5);
  const maxSteps = Math.max(1, Math.ceil(maxDistance / stepSize));

  let marchDir = normalize(guideDir);
  let current = currentPt;
  let travelled = 0;

  for (let step = 0; step < maxSteps; step++) {
    const localContourDir = contourDirectionAtPoint(current, gradField, zoneContourDir);
    const contourStepDir = localContourDir ? orientLike(localContourDir, marchDir) : null;
    marchDir = blendUnitVectors([
      { dir: normalize(guideDir), weight: p.guideMarchPerpBlend },
      { dir: marchDir, weight: p.guideMarchContinuationBlend },
      contourStepDir ? { dir: contourStepDir, weight: p.guideMarchContourBlend } : null,
    ]);

    const nextPt = {
      x: current.x + marchDir.x * stepSize,
      z: current.z + marchDir.z * stepSize,
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
      if (isTooClose(projected.t, usedTsByStreet[nextIdx], p.minParcelDepth * p.nearDuplicateFactor)) {
        addReasonCount(trace.counts, 'too-close');
        trace.failedRibbons.push(buildIndexedFailure(
          'too-close',
          currentPt,
          compactPolyline(path),
          {
            fromStreetIdx: currentIdx,
            toStreetIdx: nextIdx,
            stopPoint: projected.point,
            stopCell: { gx, gz },
            projectedPoint: projected.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      const finalPolyline = compactPolyline([...path.slice(0, -1), projected.point]);
      const finalLength = polylineLength(finalPolyline);
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
            stopPoint: projected.point,
            stopCell: { gx, gz },
            projectedPoint: projected.point,
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
            stopPoint: projected.point,
            stopCell: { gx, gz },
            projectedPoint: projected.point,
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
            stopPoint: projected.point,
            stopCell: { gx, gz },
            projectedPoint: projected.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      const nextParam = paramsByStreet[nextIdx];
      const nextTan = ribbonTangentAtArcLength(nextParam, projected.t, p);
      const finalStep = finalPolyline[finalPolyline.length - 2];
      const approachAngle = perpendicularAngleError(finalStep, projected.point, nextTan);
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
            stopPoint: projected.point,
            stopCell: { gx, gz },
            projectedPoint: projected.point,
            hitStreetIds: ids,
          },
        ));
        return { streetIdx: null, point: null, polyline: null, trace };
      }

      return {
        streetIdx: nextIdx,
        point: { t: projected.t, pt: projected.point },
        polyline: finalPolyline,
        trace,
      };
    }

    current = nextPt;
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

function chooseAdjacentCandidate(
  currentPt,
  currentT,
  currentTan,
  nextParam,
  candidateTs,
  pairWidth,
  maxAngleOff,
  guidePoint,
  guideNormal,
  targetPoint,
  usedTs,
  zoneSet,
  waterMask,
  cs,
  W,
  H,
  ox,
  oz,
  p,
) {
  const trace = createTrace();
  let best = null;
  let bestScore = Infinity;
  let bestFailed = null;

  for (const t of candidateTs) {
    const pt = pointAtArcLength(nextParam, t);
    const nextTan = smoothedTangentAtArcLength(nextParam, t, p.tangentSampleWindow);
    const guideAngle = guideAngleError(currentPt, pt, guideNormal);
    const guideOffset = pointLineDistance(pt, guidePoint, guideNormal);
    const alongGuide = dot2(
      { x: pt.x - currentPt.x, z: pt.z - currentPt.z },
      guideNormal,
    );
    const widthError = Math.abs(alongGuide - pairWidth);
    const sample = {
      points: [currentPt, pt],
      guideLine: [currentPt, targetPoint],
      source: 'adjacent-search',
    };

    let rejection = null;
    let score = 0;

    if (isTooClose(t, usedTs, p.minParcelDepth * p.nearDuplicateFactor)) {
      rejection = 'too-close';
      score = 2000 + closestDistanceTo(t, usedTs);
    } else if (alongGuide < p.minRibbonLength * 0.5) {
      rejection = 'guide-side';
      score = 1500 + Math.abs(alongGuide);
    } else if (guideAngle > p.maxGuideAngleOff) {
      rejection = 'guide-direction';
      score = guideAngle * 1000 + widthError * 5;
    } else if (guideOffset > p.guideLineTolerance) {
      rejection = 'guide-offset';
      score = guideOffset * 100 + widthError * 2;
    } else {
      const len = dist(currentPt, pt);
      const maxLen = Math.min(p.maxRibbonLength, Math.max(pairWidth * 2.2, p.minRibbonLength * 2));
      const minLen = p.minRibbonLength;

      if (len < minLen) {
        rejection = 'too-short';
        score = minLen - len;
      } else if (len > maxLen) {
        rejection = 'too-long';
        score = len - maxLen;
      } else {
        const angleA = perpendicularAngleError(currentPt, pt, currentTan);
        const angleB = perpendicularAngleError(pt, currentPt, nextTan);
        if (angleA > maxAngleOff || angleB > maxAngleOff) {
          rejection = 'angle';
          trace.angleRejects++;
          score = (angleA + angleB) * 500;
        } else {
          const validity = validateRibbon(currentPt, pt, zoneSet, waterMask, cs, W, H, ox, oz);
          if (!validity.ok) {
            rejection = validity.reason;
            score = 500 + guideOffset * 10 + widthError;
          } else {
            score =
              guideAngle * 320 +
              guideOffset * 14 +
              widthError * 1.8 +
              Math.abs(t - currentT) * 0.15;

            if (score < bestScore) {
              bestScore = score;
              best = { t, pt };
            }
          }
        }
      }
    }

    if (rejection) {
      if (!bestFailed || score < bestFailed.score) {
        bestFailed = {
          reason: rejection,
          score,
          sample,
        };
      }
    }
  }

  if (!best && bestFailed) {
    addReasonCount(trace.counts, bestFailed.reason);
    trace.failedRibbons.push({
      ...bestFailed.sample,
      reason: bestFailed.reason,
    });
  }

  return { point: best, trace };
}

function buildAnchorSequence(totalLength, p, centerT = totalLength * 0.5) {
  const anchors = [];
  const mid = clamp(centerT, p.edgeMargin, totalLength - p.edgeMargin);
  for (let step = 0; step < p.maxRowsTotal; step++) {
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

function buildNeighborCandidates(param, range, guessedT, usedTs, guidePoint, guideNormal, targetPoint, pairWidth, p) {
  return sampleRange(range.start, range.end, p.searchStep, guessedT)
    .filter(t => !isTooClose(t, usedTs, p.minParcelDepth * p.nearDuplicateFactor))
    .map(t => {
      const pt = pointAtArcLength(param, t);
      const alongGuide = dot2(
        { x: pt.x - guidePoint.x, z: pt.z - guidePoint.z },
        guideNormal,
      );
      const widthError = Math.abs(alongGuide - pairWidth);
      const sidePenalty = alongGuide < 0 ? 400 : 0;
      return {
        t,
        score:
          pointLineDistance(pt, guidePoint, guideNormal) * 4 +
          widthError * 1.5 +
          dist(pt, targetPoint) * 0.15 +
          Math.abs(t - guessedT) * 0.2 +
          sidePenalty,
      };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, p.maxSearchPerNeighbor)
    .map(entry => entry.t);
}

function findGuideTargetArcLength(
  param,
  range,
  fallbackT,
  guidePoint,
  guideNormal,
  targetPoint,
  pairWidth,
  currentT,
  currentTotalLength,
  p,
) {
  let bestT = fallbackT;
  let bestScore = Infinity;
  for (const t of sampleRange(range.start, range.end, p.searchStep, fallbackT)) {
    const pt = pointAtArcLength(param, t);
    const alongGuide = dot2(
      { x: pt.x - guidePoint.x, z: pt.z - guidePoint.z },
      guideNormal,
    );
    const widthError = Math.abs(alongGuide - pairWidth);
    const currentProgress = currentTotalLength > 0 ? currentT / currentTotalLength : 0.5;
    const nextProgress = param.totalLength > 0 ? t / param.totalLength : 0.5;
    const sidePenalty = alongGuide < 0 ? 600 : 0;
    const score =
      pointLineDistance(pt, guidePoint, guideNormal) * 6 +
      widthError * 2.5 +
      dist(pt, targetPoint) * 0.2 +
      Math.abs(nextProgress - currentProgress) * 30 +
      sidePenalty;
    if (score < bestScore) {
      bestScore = score;
      bestT = t;
    }
  }
  return bestT;
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

function rotateUnitVector(dir, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return normalize({
    x: dir.x * c - dir.z * s,
    z: dir.x * s + dir.z * c,
  });
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

function guideAngleError(ptA, ptB, guideNormal) {
  const dir = normalize({ x: ptB.x - ptA.x, z: ptB.z - ptA.z });
  const dot = clamp(Math.abs(dir.x * guideNormal.x + dir.z * guideNormal.z), 0, 1);
  return Math.acos(dot);
}

function guideOffsetError(ptA, ptB, guidePoint, guideNormal) {
  return (
    pointLineDistance(ptA, guidePoint, guideNormal) +
    pointLineDistance(ptB, guidePoint, guideNormal)
  ) * 0.5;
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
