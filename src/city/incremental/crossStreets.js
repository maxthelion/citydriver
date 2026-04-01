/**
 * Cross Streets — Contour-axis sweep with gradient-direction scan.
 *
 * Seeds at ~90m intervals along the contour axis. For each seed,
 * scans along the gradient to find in-zone runs. Each run becomes
 * a cross street. Roads split zones into separate runs.
 *
 * Lines are straight rays in the gradient direction. Skeleton road
 * perpendicular pull is not yet implemented (per-line direction
 * approach preserved spacing but added complexity for little visual gain).
 */

import { EventSink } from '../../core/EventSink.js';

export function layCrossStreets(zone, map, params = {}) {
  const {
    eventSink = null,
    eventStepId = 'cross-streets',
    eventContext = {},
    ...algoParams
  } = params;
  const p = {
    spacing: 90,
    stepSize: 2.5,
    minLength: 20,
    minSeparation: 5,
    phaseOrigin: null,
    phaseOffset: null,
    explicitCtOffsets: null,
    phaseOriginSource: null,
    phaseBorrowPointCount: 0,
    phaseBorrowExplicitCtOffsetCount: 0,
    phaseBorrowBoundarySource: null,
    boundarySnapPoints: null,
    boundarySnapMaxDistance: 25,
    boundarySnapMaxAngleDeltaDeg: 20,
    boundarySnapMinImprovement: 4,
    boundarySnapForceEndpoint: false,
    boundarySnapForceEndpointMaxDistance: 12,
    ...algoParams,
  };

  const cs = map.cellSize;
  const W = map.width, H = map.height;
  const ox = map.originX, oz = map.originZ;

  const zoneSet = new Set();
  for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

  const gradDir = computeZoneGradient(zone, map, zoneSet);
  const contourDir = { x: -gradDir.z, z: gradDir.x };
  const sink = eventSink instanceof EventSink ? eventSink : eventSink || null;

  const waterMask = map.getLayer('waterMask');
  const roadGrid = map.getLayer('roadGrid');

  // Contour-axis sweep
  const phaseOrigin = p.phaseOrigin
    ? { x: p.phaseOrigin.x, z: p.phaseOrigin.z }
    : {
      x: ox + zone.centroidGx * cs,
      z: oz + zone.centroidGz * cs,
    };
  const zoneCx = phaseOrigin.x;
  const zoneCz = phaseOrigin.z;

  let minCt = Infinity, maxCt = -Infinity;
  for (const c of zone.cells) {
    const wx = ox + c.gx * cs;
    const wz = oz + c.gz * cs;
    const projCt = (wx - zoneCx) * contourDir.x + (wz - zoneCz) * contourDir.z;
    if (projCt < minCt) minCt = projCt;
    if (projCt > maxCt) maxCt = projCt;
  }

  emitCrossStreetEvent(sink, eventStepId, eventContext, 'sweep-plan', {
    spacing: p.spacing,
    minLength: p.minLength,
    minSeparation: p.minSeparation,
    gradDir: roundVector(gradDir),
    contourDir: roundVector(contourDir),
    phaseOrigin: roundPoint(phaseOrigin),
    phaseOffset: p.phaseOffset !== null && p.phaseOffset !== undefined ? roundNumber(normalizePhaseOffset(p.phaseOffset, p.spacing)) : undefined,
    phaseOriginSource: p.phaseOriginSource || 'centroid',
    phaseBorrowPointCount: p.phaseBorrowPointCount || undefined,
    phaseBorrowExplicitCtOffsetCount: p.phaseBorrowExplicitCtOffsetCount || undefined,
    phaseBorrowBoundarySource: p.phaseBorrowBoundarySource || undefined,
    ctRange: {
      min: roundNumber(minCt),
      max: roundNumber(maxCt),
    },
  });

  const offsets = [];
  const phaseOffset = p.phaseOffset !== null && p.phaseOffset !== undefined
    ? normalizePhaseOffset(p.phaseOffset, p.spacing)
    : 0;
  const firstCt = phaseOffset + Math.ceil((minCt - phaseOffset) / p.spacing) * p.spacing;
  for (let ct = firstCt; ct <= maxCt + 1e-6; ct += p.spacing) {
    offsets.push(ct);
  }
  if (offsets.length === 0 || offsets[0] - minCt > p.spacing * 0.3) {
    offsets.unshift(minCt);
  }
  if (offsets.length === 0 || maxCt - offsets[offsets.length - 1] > p.spacing * 0.3) {
    offsets.push(maxCt);
  }
  offsets.sort((a, b) => a - b);

  const filtered = mergeContourOffsets(offsets, p.explicitCtOffsets, p.spacing);

  // Scan each offset for zone runs, keep as cross streets
  const allLines = [];
  const scanlineStatsByKey = new Map();
  const debugRejectedStreets = [];
  const debugPrunedStreets = [];
  const debugMissingScanlines = [];

  for (const ctOff of filtered) {
    const seedX = zoneCx + contourDir.x * ctOff;
    const seedZ = zoneCz + contourDir.z * ctOff;
    const scanlineKey = formatCtToken(ctOff);

    emitCrossStreetEvent(sink, eventStepId, eventContext, 'scanline-start', {
      ctOff: roundNumber(ctOff),
      seedPoint: roundPoint({ x: seedX, z: seedZ }),
    });

    const { runs, breaks } = findZoneRuns(
      seedX, seedZ, gradDir, zoneSet, waterMask, roadGrid,
      cs, W, H, ox, oz,
    );

    emitCrossStreetEvent(sink, eventStepId, eventContext, 'scanline-runs', {
      ctOff: roundNumber(ctOff),
      runCount: runs.length,
      runLengths: runs.map(run => run.length),
      breakCount: breaks.length,
      breakReasons: summarizeBreakReasons(breaks),
    });
    scanlineStatsByKey.set(scanlineKey, {
      ctOff: roundNumber(ctOff),
      seedPoint: roundPoint({ x: seedX, z: seedZ }),
      runCount: runs.length,
      breakCount: breaks.length,
      breakReasons: summarizeBreakReasons(breaks),
      candidateCount: 0,
      rejectedCount: 0,
      prunedCount: 0,
      acceptedCount: 0,
      rejectedReasons: {},
      prunedReasons: {},
    });
    for (const breakPoint of breaks) {
      emitCrossStreetEvent(sink, eventStepId, eventContext, 'scanline-break', {
        ctOff: roundNumber(ctOff),
        reason: breakPoint.reason,
        point: roundPoint(breakPoint),
        cell: breakPoint.cell,
        previousRunLength: breakPoint.previousRunLength,
      });
    }

    for (let runIdx = 0; runIdx < runs.length; runIdx++) {
      const run = runs[runIdx];
      const candidateKey = streetCandidateKey(ctOff, runIdx);
      const scanlineStats = scanlineStatsByKey.get(scanlineKey);
      if (run.length < 2) {
        if (scanlineStats) recordReasonCount(scanlineStats.rejectedReasons, 'too-few-samples');
        if (scanlineStats) scanlineStats.rejectedCount += 1;
        debugRejectedStreets.push({
          ctOff: roundNumber(ctOff),
          runIdx,
          candidateKey,
          reason: 'too-few-samples',
          sampleCount: run.length,
          points: run.map(pt => ({ x: pt.x, z: pt.z })),
          snapped: false,
          length: run.length >= 2 ? roundNumber(arcLength(run)) : 0,
        });
        emitCrossStreetEvent(sink, eventStepId, eventContext, 'street-rejected', {
          ctOff: roundNumber(ctOff),
          runIdx,
          candidateKey,
          reason: 'too-few-samples',
          sampleCount: run.length,
          startPoint: roundPoint(run[0]),
          endPoint: roundPoint(run[run.length - 1] || run[0] || null),
        });
        continue;
      }
      const points = run.map(pt => ({ x: pt.x, z: pt.z }));
      const snapped = maybeSnapStreetCandidate({
        points,
        zoneSet,
        waterMask,
        roadGrid,
        cs,
        W,
        H,
        ox,
        oz,
        gradDir,
        params: p,
      });
      const finalPoints = snapped?.points?.length >= 2 ? snapped.points : points;
      const length = arcLength(finalPoints);
      if (scanlineStats) scanlineStats.candidateCount += 1;
      emitCrossStreetEvent(sink, eventStepId, eventContext, 'street-candidate', {
        ctOff: roundNumber(ctOff),
        runIdx,
        candidateKey,
        sampleCount: run.length,
        length: roundNumber(length),
        startPoint: roundPoint(finalPoints[0]),
        endPoint: roundPoint(finalPoints[finalPoints.length - 1]),
        snapped: !!snapped,
      });
      if (snapped) {
        emitCrossStreetEvent(sink, eventStepId, eventContext, 'street-snapped', {
          ctOff: roundNumber(ctOff),
          runIdx,
          snapPoint: roundPoint(snapped.snapPoint),
          originalEndpoint: roundPoint(snapped.originalEndpoint),
          snappedEndpoint: roundPoint(snapped.snappedEndpoint),
          originalDistance: roundNumber(snapped.originalDistance),
          snappedDistance: roundNumber(snapped.snappedDistance),
          midpoint: roundPoint(snapped.midpoint),
          side: snapped.side,
          forcedEndpoint: !!snapped.forcedEndpoint,
        });
      }
      if (length < p.minLength) {
        if (scanlineStats) recordReasonCount(scanlineStats.rejectedReasons, 'too-short');
        if (scanlineStats) scanlineStats.rejectedCount += 1;
        debugRejectedStreets.push({
          ctOff: roundNumber(ctOff),
          runIdx,
          candidateKey,
          reason: 'too-short',
          sampleCount: run.length,
          points: finalPoints,
          snapped: !!snapped,
          length: roundNumber(length),
        });
        emitCrossStreetEvent(sink, eventStepId, eventContext, 'street-rejected', {
          ctOff: roundNumber(ctOff),
          runIdx,
          candidateKey,
          reason: 'too-short',
          sampleCount: run.length,
          length: roundNumber(length),
          startPoint: roundPoint(finalPoints[0]),
          endPoint: roundPoint(finalPoints[finalPoints.length - 1]),
          snapped: !!snapped,
        });
        continue;
      }
      allLines.push({
        candidateKey,
        runIdx,
        points: finalPoints,
        length,
        ctOff,
        snapped: !!snapped,
        snapPoint: snapped?.snapPoint ?? null,
      });
    }
  }

  const { kept, pruned } = pruneConverging(allLines, p.minSeparation);
  for (const line of kept) {
    const scanlineStats = scanlineStatsByKey.get(formatCtToken(line.ctOff));
    if (scanlineStats) scanlineStats.acceptedCount += 1;
    emitCrossStreetEvent(sink, eventStepId, eventContext, 'street-accepted', {
      ctOff: roundNumber(line.ctOff),
      runIdx: line.runIdx,
      candidateKey: line.candidateKey,
      length: roundNumber(line.length),
      startPoint: roundPoint(line.points[0]),
      endPoint: roundPoint(line.points[line.points.length - 1]),
      snapped: !!line.snapped,
    });
  }
  for (const line of pruned) {
    const scanlineStats = scanlineStatsByKey.get(formatCtToken(line.ctOff));
    if (scanlineStats) scanlineStats.prunedCount += 1;
    if (scanlineStats) recordReasonCount(scanlineStats.prunedReasons, line.prunedReason || 'pruned');
    debugPrunedStreets.push({
      candidateKey: line.candidateKey,
      ctOff: roundNumber(line.ctOff),
      runIdx: line.runIdx,
      reason: line.prunedReason || 'pruned',
      points: line.points,
      length: roundNumber(line.length),
      snapped: !!line.snapped,
      conflictCandidateKey: line.conflictCandidateKey,
      conflictCtOff: line.conflictCtOff !== undefined ? roundNumber(line.conflictCtOff) : undefined,
      conflictPoint: line.conflictPoint ? roundPoint(line.conflictPoint) : null,
      conflictDistance: line.conflictDistance !== undefined ? roundNumber(line.conflictDistance) : undefined,
    });
    emitCrossStreetEvent(sink, eventStepId, eventContext, 'street-pruned', {
      ctOff: roundNumber(line.ctOff),
      runIdx: line.runIdx,
      candidateKey: line.candidateKey,
      reason: line.prunedReason || 'pruned',
      length: roundNumber(line.length),
      startPoint: roundPoint(line.points[0]),
      endPoint: roundPoint(line.points[line.points.length - 1]),
      conflictCandidateKey: line.conflictCandidateKey,
      conflictCtOff: line.conflictCtOff !== undefined ? roundNumber(line.conflictCtOff) : undefined,
      conflictPoint: roundPoint(line.conflictPoint),
      conflictDistance: line.conflictDistance !== undefined ? roundNumber(line.conflictDistance) : undefined,
    });
  }
  for (const stats of scanlineStatsByKey.values()) {
    if (stats.acceptedCount > 0) continue;
    debugMissingScanlines.push({
      ctOff: stats.ctOff,
      seedPoint: stats.seedPoint,
      runCount: stats.runCount,
      breakCount: stats.breakCount,
      breakReasons: stats.breakReasons,
      candidateCount: stats.candidateCount,
      rejectedCount: stats.rejectedCount,
      rejectedReasons: stats.rejectedReasons,
      prunedCount: stats.prunedCount,
      prunedReasons: stats.prunedReasons,
      guidePoints: buildScanlineGuidePoints(seedXForStats(zoneCx, contourDir, stats.ctOff), seedZForStats(zoneCz, contourDir, stats.ctOff), gradDir, p.spacing * 0.45),
    });
    emitCrossStreetEvent(sink, eventStepId, eventContext, 'scanline-no-street', {
      ctOff: stats.ctOff,
      seedPoint: stats.seedPoint,
      runCount: stats.runCount,
      breakCount: stats.breakCount,
      breakReasons: stats.breakReasons,
      candidateCount: stats.candidateCount,
      rejectedCount: stats.rejectedCount,
      rejectedReasons: stats.rejectedReasons,
      prunedCount: stats.prunedCount,
      prunedReasons: stats.prunedReasons,
    });
  }
  const crossStreets = kept;
  return {
    crossStreets,
    gradDir,
    contourDir,
    debug: {
      rejectedStreets: debugRejectedStreets,
      prunedStreets: debugPrunedStreets,
      missingScanlines: debugMissingScanlines,
    },
  };
}

function computeZoneGradient(zone, map, zoneSet) {
  const cs = map.cellSize;
  const W = map.width;
  const elev = map.getLayer('elevation');

  let sumDx = 0, sumDz = 0, count = 0;
  if (elev) {
    for (const c of zone.cells) {
      const eC = elev.get(c.gx, c.gz);
      const eE = zoneSet.has(c.gz * W + (c.gx + 1)) ? elev.get(c.gx + 1, c.gz) : eC;
      const eW = zoneSet.has(c.gz * W + (c.gx - 1)) ? elev.get(c.gx - 1, c.gz) : eC;
      const eS = zoneSet.has((c.gz + 1) * W + c.gx) ? elev.get(c.gx, c.gz + 1) : eC;
      const eN = zoneSet.has((c.gz - 1) * W + c.gx) ? elev.get(c.gx, c.gz - 1) : eC;
      sumDx += (eE - eW) / (2 * cs);
      sumDz += (eS - eN) / (2 * cs);
      count++;
    }
  }

  let gx = count > 0 ? sumDx / count : 0;
  let gz = count > 0 ? sumDz / count : 0;
  const mag = Math.sqrt(gx * gx + gz * gz);

  if (mag < 1e-6) {
    if (zone.slopeDir && (zone.slopeDir.x !== 0 || zone.slopeDir.z !== 0)) {
      return { x: zone.slopeDir.x, z: zone.slopeDir.z };
    }
    return { x: 1, z: 0 };
  }
  return { x: gx / mag, z: gz / mag };
}

function findZoneRuns(targetX, targetZ, gradDir, zoneSet, waterMask, roadGrid, cs, W, H, ox, oz) {
  const step = cs * 0.5;
  const maxScan = 500;

  const allPoints = [];
  for (let si = -maxScan; si <= maxScan; si++) {
    const wx = targetX + gradDir.x * si * step;
    const wz = targetZ + gradDir.z * si * step;
    const cgx = Math.round((wx - ox) / cs);
    const cgz = Math.round((wz - oz) / cs);
    const inBounds = cgx >= 0 && cgx < W && cgz >= 0 && cgz < H;
    if (!inBounds) {
      allPoints.push({
        x: wx,
        z: wz,
        cgx,
        cgz,
        inBounds: false,
        inZone: false,
        isWater: false,
        isRoad: false,
      });
      continue;
    }

    const inZone = zoneSet.has(cgz * W + cgx);
    const isWater = waterMask && waterMask.get(cgx, cgz) > 0;
    const isRoad = roadGrid && roadGrid.get(cgx, cgz) > 0;

    allPoints.push({ x: wx, z: wz, cgx, cgz, inBounds, inZone, isWater, isRoad });
  }

  const runs = [];
  const breaks = [];
  let curRun = [];

  for (const pt of allPoints) {
    if (pt.inZone && !pt.isWater) {
      curRun.push(pt);
    } else if (pt.isRoad && curRun.length > 0) {
      breaks.push({
        x: pt.x,
        z: pt.z,
        reason: 'road',
        cell: pt.inBounds ? { gx: pt.cgx, gz: pt.cgz } : null,
        previousRunLength: curRun.length,
      });
      curRun.push(pt);
      runs.push(curRun);
      curRun = [];
    } else {
      if (curRun.length > 0) {
        breaks.push({
          x: pt.x,
          z: pt.z,
          reason: classifyBreakReason(pt),
          cell: pt.inBounds ? { gx: pt.cgx, gz: pt.cgz } : null,
          previousRunLength: curRun.length,
        });
      }
      if (curRun.length > 0) runs.push(curRun);
      curRun = [];
    }
  }
  if (curRun.length > 0) runs.push(curRun);

  runs.sort((a, b) => b.length - a.length);
  return { runs, breaks };
}

function arcLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.sqrt(
      (points[i].x - points[i - 1].x) ** 2 +
      (points[i].z - points[i - 1].z) ** 2,
    );
  }
  return len;
}

function pruneConverging(lines, minSeparation) {
  if (lines.length < 2) return { kept: lines, pruned: [] };
  const keep = new Array(lines.length).fill(true);
  const minDistSq = minSeparation * minSeparation;

  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (!keep[j]) continue;
      const convergence = findPolylineConvergence(lines[i].points, lines[j].points, minDistSq);
      if (convergence) {
        if (lines[i].length < lines[j].length) {
          annotatePrunedLine(lines[i], lines[j], convergence);
          keep[i] = false;
          break;
        } else {
          annotatePrunedLine(lines[j], lines[i], convergence);
          keep[j] = false;
        }
      }
    }
  }

  return {
    kept: lines.filter((_, i) => keep[i]),
    pruned: lines.filter((_, i) => !keep[i]),
  };
}

function findPolylineConvergence(ptsA, ptsB, minDistSq) {
  const stepA = Math.max(1, Math.floor(ptsA.length / 20));
  const stepB = Math.max(1, Math.floor(ptsB.length / 20));

  for (let ia = 0; ia < ptsA.length; ia += stepA) {
    for (let ib = 0; ib < ptsB.length; ib += stepB) {
      const dx = ptsA[ia].x - ptsB[ib].x;
      const dz = ptsA[ia].z - ptsB[ib].z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq < minDistSq) {
        return {
          pointA: ptsA[ia],
          pointB: ptsB[ib],
          distanceSq,
        };
      }
    }
  }
  return null;
}

function annotatePrunedLine(line, conflictLine, convergence) {
  line.prunedReason = 'min-separation';
  line.conflictCandidateKey = conflictLine.candidateKey;
  line.conflictCtOff = conflictLine.ctOff;
  line.conflictPoint = {
    x: (convergence.pointA.x + convergence.pointB.x) * 0.5,
    z: (convergence.pointA.z + convergence.pointB.z) * 0.5,
  };
  line.conflictDistance = Math.sqrt(convergence.distanceSq);
}

function classifyBreakReason(point) {
  if (!point?.inBounds) return 'off-map';
  if (point.isWater) return 'water';
  if (point.isRoad) return 'road';
  return 'out-of-sector';
}

function summarizeBreakReasons(breaks) {
  const counts = {};
  for (const breakPoint of breaks) {
    counts[breakPoint.reason] = (counts[breakPoint.reason] || 0) + 1;
  }
  return counts;
}

function mergeContourOffsets(baseOffsets, explicitOffsets, spacing) {
  const merged = [];
  for (const ct of baseOffsets || []) {
    if (!Number.isFinite(ct)) continue;
    merged.push({ ct, explicit: false });
  }
  for (const ct of explicitOffsets || []) {
    if (!Number.isFinite(ct)) continue;
    merged.push({ ct, explicit: true });
  }
  if (merged.length === 0) return [];

  merged.sort((a, b) => {
    if (a.ct !== b.ct) return a.ct - b.ct;
    return Number(b.explicit) - Number(a.explicit);
  });

  const threshold = Math.max((spacing || 0) * 0.3, 1e-6);
  const kept = [merged[0]];
  for (let i = 1; i < merged.length; i++) {
    const current = merged[i];
    const previous = kept[kept.length - 1];
    if (current.ct - previous.ct < threshold) {
      if (current.explicit && !previous.explicit) kept[kept.length - 1] = current;
      continue;
    }
    kept.push(current);
  }

  return kept.map(entry => entry.ct);
}

function maybeSnapStreetCandidate({
  points,
  zoneSet,
  waterMask,
  roadGrid,
  cs,
  W,
  H,
  ox,
  oz,
  gradDir,
  params,
}) {
  if (!Array.isArray(params.boundarySnapPoints) || params.boundarySnapPoints.length === 0) return null;
  if (!points || points.length < 2) return null;

  const midpoint = pointAtArcFraction(points, 0.5);
  const originalDir = normalize2({
    x: points[points.length - 1].x - points[0].x,
    z: points[points.length - 1].z - points[0].z,
  });
  if (!midpoint || !originalDir) return null;

  const maxDistSq = (params.boundarySnapMaxDistance ?? 25) ** 2;
  const cosMaxAngle = Math.cos(((params.boundarySnapMaxAngleDeltaDeg ?? 20) * Math.PI) / 180);
  const minImprovement = params.boundarySnapMinImprovement ?? 4;
  const forceEndpoint = !!params.boundarySnapForceEndpoint;
  const forceEndpointMaxDistanceSq = (params.boundarySnapForceEndpointMaxDistance ?? 12) ** 2;

  let best = null;

  for (const snapPoint of params.boundarySnapPoints) {
    if (!snapPoint) continue;
    const startDistSq = distSq(points[0], snapPoint);
    const endDistSq = distSq(points[points.length - 1], snapPoint);
    const side = startDistSq <= endDistSq ? 'start' : 'end';
    const originalEndpoint = side === 'start' ? points[0] : points[points.length - 1];
    const originalDistanceSq = Math.min(startDistSq, endDistSq);
    if (originalDistanceSq > maxDistSq) continue;

    const snappedDir = normalize2({
      x: midpoint.x - snapPoint.x,
      z: midpoint.z - snapPoint.z,
    });
    if (!snappedDir) continue;
    if (Math.abs(dot2(originalDir, snappedDir)) < cosMaxAngle) continue;

    const runs = findZoneRuns(
      midpoint.x,
      midpoint.z,
      snappedDir,
      zoneSet,
      waterMask,
      roadGrid,
      cs,
      W,
      H,
      ox,
      oz,
    );
    const snappedRun = selectRunForSnap(runs, midpoint, snapPoint, cs);
    if (!snappedRun || snappedRun.length < 2) continue;
    const snappedPoints = snappedRun.map(pt => ({ x: pt.x, z: pt.z }));
    let forcedEndpoint = false;
    if (forceEndpoint) {
      const startSnapDistSq = distSq(snappedPoints[0], snapPoint);
      const endSnapDistSq = distSq(snappedPoints[snappedPoints.length - 1], snapPoint);
      if (startSnapDistSq <= forceEndpointMaxDistanceSq || endSnapDistSq <= forceEndpointMaxDistanceSq) {
        if (startSnapDistSq <= endSnapDistSq) {
          snappedPoints[0] = { x: snapPoint.x, z: snapPoint.z };
        } else {
          snappedPoints[snappedPoints.length - 1] = { x: snapPoint.x, z: snapPoint.z };
        }
        forcedEndpoint = true;
      }
    }
    const snappedDistanceSq = Math.min(
      distSq(snappedPoints[0], snapPoint),
      distSq(snappedPoints[snappedPoints.length - 1], snapPoint),
    );
    if (Math.sqrt(originalDistanceSq) - Math.sqrt(snappedDistanceSq) < minImprovement) continue;

    const score = snappedDistanceSq + originalDistanceSq * 0.15;
    if (!best || score < best.score) {
      best = {
        score,
        points: snappedPoints,
        snapPoint,
        midpoint,
        originalEndpoint,
        snappedEndpoint: distSq(snappedPoints[0], snapPoint) <= distSq(snappedPoints[snappedPoints.length - 1], snapPoint)
          ? snappedPoints[0]
          : snappedPoints[snappedPoints.length - 1],
        originalDistance: Math.sqrt(originalDistanceSq),
        snappedDistance: Math.sqrt(snappedDistanceSq),
        side,
        forcedEndpoint,
      };
    }
  }

  return best;
}

function selectRunForSnap(runs, midpoint, snapPoint, cs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const seedTolSq = (cs * 1.5) ** 2;
  let best = null;
  let bestScore = Infinity;

  for (const run of runs) {
    if (!run || run.length < 2) continue;
    const seedDistSq = minDistanceSqToPoint(run, midpoint);
    const snapDistSq = Math.min(distSq(run[0], snapPoint), distSq(run[run.length - 1], snapPoint));
    const score = snapDistSq + seedDistSq * (seedDistSq <= seedTolSq ? 0.1 : 10);
    if (score < bestScore) {
      bestScore = score;
      best = run;
    }
  }

  return best;
}

function pointAtArcFraction(points, fraction) {
  if (!points || points.length === 0) return null;
  if (points.length === 1) return points[0];
  const total = arcLength(points);
  if (total <= 1e-6) return points[Math.floor(points.length / 2)];
  const target = total * fraction;
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const segmentLength = Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].z - points[i - 1].z,
    );
    if (travelled + segmentLength >= target) {
      const t = (target - travelled) / Math.max(segmentLength, 1e-6);
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        z: points[i - 1].z + (points[i].z - points[i - 1].z) * t,
      };
    }
    travelled += segmentLength;
  }
  return points[points.length - 1];
}

function minDistanceSqToPoint(points, point) {
  let best = Infinity;
  for (const candidate of points) {
    const dSq = distSq(candidate, point);
    if (dSq < best) best = dSq;
  }
  return best;
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function normalize2(vector) {
  const mag = Math.hypot(vector.x, vector.z);
  if (mag < 1e-9) return null;
  return { x: vector.x / mag, z: vector.z / mag };
}

function dot2(a, b) {
  return a.x * b.x + a.z * b.z;
}

function emitCrossStreetEvent(sink, stepId, context, type, payload) {
  if (!sink || typeof sink.emit !== 'function' || typeof sink.next !== 'function') return;
  sink.emit({
    seq: sink.next(),
    stepId,
    type,
    ...compactObject(context || {}),
    payload: compactObject(payload || {}),
  });
}

function streetCandidateKey(ctOff, runIdx) {
  return `ct:${formatCtToken(ctOff)}:run:${runIdx}`;
}

function formatCtToken(value) {
  return roundNumber(value).toFixed(2);
}

function recordReasonCount(counts, reason) {
  counts[reason] = (counts[reason] || 0) + 1;
}

function normalizePhaseOffset(offset, spacing) {
  if (!Number.isFinite(offset) || !Number.isFinite(spacing) || spacing <= 0) return 0;
  const mod = offset % spacing;
  return mod < 0 ? mod + spacing : mod;
}

function buildScanlineGuidePoints(seedX, seedZ, gradDir, halfLength) {
  return [
    {
      x: seedX - gradDir.x * halfLength,
      z: seedZ - gradDir.z * halfLength,
    },
    {
      x: seedX + gradDir.x * halfLength,
      z: seedZ + gradDir.z * halfLength,
    },
  ];
}

function seedXForStats(zoneCx, contourDir, ctOff) {
  return zoneCx + contourDir.x * ctOff;
}

function seedZForStats(zoneCz, contourDir, ctOff) {
  return zoneCz + contourDir.z * ctOff;
}

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  );
}

function roundNumber(value) {
  return Math.round(value * 100) / 100;
}

function roundPoint(point) {
  if (!point) return null;
  return {
    x: roundNumber(point.x),
    z: roundNumber(point.z),
  };
}

function roundVector(vector) {
  if (!vector) return null;
  return {
    x: roundNumber(vector.x),
    z: roundNumber(vector.z),
  };
}
