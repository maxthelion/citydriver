import { chaikinSmooth, clamp, polygonArea as signedPolygonArea, polygonCentroid as mathPolygonCentroid } from '../../core/math.js';
import { insetPolygon } from '../../core/polygonInset.js';
import { clipPolylineToBounds } from '../../core/clipPolyline.js';

export function arcLengths(polyline) {
  const lengths = [0];
  for (let i = 1; i < polyline.length; i++) {
    lengths.push(lengths[i - 1] + distance(polyline[i - 1], polyline[i]));
  }
  return lengths;
}

export function polylineLength(polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return 0;
  const lengths = arcLengths(polyline);
  return lengths[lengths.length - 1];
}

export function sampleAtDistance(polyline, lengths, distanceAlong) {
  if (!polyline.length) return null;
  const total = lengths[lengths.length - 1];
  if (distanceAlong <= 0) return { ...polyline[0] };
  if (distanceAlong >= total) return { ...polyline[polyline.length - 1] };
  let lo = 0;
  let hi = lengths.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] <= distanceAlong) lo = mid;
    else hi = mid;
  }
  const span = lengths[hi] - lengths[lo];
  const t = span <= 1e-9 ? 0 : (distanceAlong - lengths[lo]) / span;
  return {
    x: polyline[lo].x + (polyline[hi].x - polyline[lo].x) * t,
    z: polyline[lo].z + (polyline[hi].z - polyline[lo].z) * t,
  };
}

export function tangentAtDistance(polyline, lengths, distanceAlong) {
  if (!polyline.length) return null;
  const total = lengths[lengths.length - 1];
  if (polyline.length === 1) return { x: 1, z: 0 };
  if (distanceAlong <= 0) {
    return normalize({
      x: polyline[1].x - polyline[0].x,
      z: polyline[1].z - polyline[0].z,
    }) || { x: 1, z: 0 };
  }
  if (distanceAlong >= total) {
    const last = polyline.length - 1;
    return normalize({
      x: polyline[last].x - polyline[last - 1].x,
      z: polyline[last].z - polyline[last - 1].z,
    }) || { x: 1, z: 0 };
  }
  let lo = 0;
  let hi = lengths.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] <= distanceAlong) lo = mid;
    else hi = mid;
  }
  return normalize({
    x: polyline[hi].x - polyline[lo].x,
    z: polyline[hi].z - polyline[lo].z,
  }) || { x: 1, z: 0 };
}

export function normalAtDistance(polyline, lengths, distanceAlong, hintVector) {
  const tangent = tangentAtDistance(polyline, lengths, distanceAlong) || { x: 1, z: 0 };
  const left = { x: -tangent.z, z: tangent.x };
  const right = { x: tangent.z, z: -tangent.x };
  const hint = normalize(hintVector) || right;
  return dot(left, hint) >= dot(right, hint) ? left : right;
}

export function slicePolyline(polyline, fromDistance, toDistance, spacing = 5) {
  if (!Array.isArray(polyline) || polyline.length < 2) return [];
  const lengths = arcLengths(polyline);
  const total = lengths[lengths.length - 1];
  const start = clamp(fromDistance, 0, total);
  const end = clamp(toDistance, 0, total);
  if (end - start < 1e-6) return [sampleAtDistance(polyline, lengths, start)];
  const points = [sampleAtDistance(polyline, lengths, start)];
  const step = Math.max(1, spacing);
  for (let d = start + step; d < end; d += step) {
    points.push(sampleAtDistance(polyline, lengths, d));
  }
  points.push(sampleAtDistance(polyline, lengths, end));
  return dedupePolyline(points);
}

export function trimPolylineEnds(polyline, trimStart, trimEnd = trimStart, spacing = 5) {
  if (!Array.isArray(polyline) || polyline.length < 2) return [];
  const lengths = arcLengths(polyline);
  const total = lengths[lengths.length - 1];
  const start = clamp(trimStart, 0, total);
  const end = clamp(total - trimEnd, 0, total);
  if (end - start <= 1e-6) return [];
  return slicePolyline(polyline, start, end, spacing);
}

export function smoothPolylineChaikin(polyline, iterations = 2) {
  if (!Array.isArray(polyline) || polyline.length < 3) return polyline ? [...polyline] : [];
  let current = dedupePolyline(polyline);
  for (let iter = 0; iter < iterations; iter++) {
    if (current.length < 3) break;
    current = dedupePolyline(chaikinSmooth(current));
  }
  return current;
}

export function offsetPolylineWithHint(polyline, offsetDistance, hintVector) {
  if (!Array.isArray(polyline) || polyline.length < 2) return polyline ? [...polyline] : [];
  const hint = normalize(hintVector) || { x: 0, z: 1 };
  return polyline.map((point, index) => {
    const tangent = tangentAtIndex(polyline, index);
    const left = { x: -tangent.z, z: tangent.x };
    const right = { x: tangent.z, z: -tangent.x };
    const chosen = dot(left, hint) >= dot(right, hint) ? left : right;
    return {
      x: point.x + chosen.x * offsetDistance,
      z: point.z + chosen.z * offsetDistance,
    };
  });
}

export function buildPerpendicularCutLine(polyline, fromDistance, depth, hintVector) {
  if (!Array.isArray(polyline) || polyline.length < 2) return [];
  const lengths = arcLengths(polyline);
  const point = sampleAtDistance(polyline, lengths, fromDistance);
  const normal = normalAtDistance(polyline, lengths, fromDistance, hintVector);
  if (!point || !normal) return [];
  return [
    point,
    {
      x: point.x + normal.x * depth,
      z: point.z + normal.z * depth,
    },
  ];
}

export function buildPerpendicularStrip(frontagePolyline, fromDistance, toDistance, depth, hintVector, spacing = 5) {
  if (!Array.isArray(frontagePolyline) || frontagePolyline.length < 2) return null;
  const lengths = arcLengths(frontagePolyline);
  const total = lengths[lengths.length - 1];
  const start = clamp(fromDistance, 0, total);
  const end = clamp(toDistance, 0, total);
  if (end - start < 1e-6) return null;

  const front = [];
  const rear = [];
  const step = Math.max(1, spacing);
  for (let d = start; d <= end + 1e-6; d += step) {
    const clamped = Math.min(d, end);
    const point = sampleAtDistance(frontagePolyline, lengths, clamped);
    const normal = normalAtDistance(frontagePolyline, lengths, clamped, hintVector);
    front.push(point);
    rear.push({
      x: point.x + normal.x * depth,
      z: point.z + normal.z * depth,
    });
    if (clamped === end) break;
  }

  const dedupedFront = dedupePolyline(front);
  const dedupedRear = dedupePolyline(rear);
  if (dedupedFront.length < 2 || dedupedRear.length < 2) return null;
  return {
    frontage: dedupedFront,
    rear: dedupedRear,
    polygon: buildStripPolygon(dedupedFront, dedupedRear),
  };
}

export function sliceClosedPolylineBetween(polyline, distanceA, distanceB, spacing = 5) {
  if (!Array.isArray(polyline) || polyline.length < 3) return [];
  const closed = ensureClosedPolyline(polyline);
  const lengths = arcLengths(closed);
  const total = lengths[lengths.length - 1];
  if (total <= 1e-6) return [];
  const a = modDistance(distanceA, total);
  const b = modDistance(distanceB, total);
  const direct = Math.abs(b - a);
  const wrap = total - direct;

  if (direct <= wrap) {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    return slicePolyline(closed, start, end, spacing);
  }

  const end = Math.max(a, b);
  const start = Math.min(a, b);
  const tail = slicePolyline(closed, end, total, spacing);
  const head = slicePolyline(closed, 0, start, spacing);
  return dedupePolyline([...tail, ...head]);
}

export function sliceClosedPolylineForward(polyline, fromDistance, toDistance, spacing = 5) {
  if (!Array.isArray(polyline) || polyline.length < 3) return [];
  const closed = ensureClosedPolyline(polyline);
  const lengths = arcLengths(closed);
  const total = lengths[lengths.length - 1];
  if (total <= 1e-6) return [];

  const from = modDistance(fromDistance, total);
  const to = modDistance(toDistance, total);
  const points = [sampleAtDistance(closed, lengths, from)];
  const step = Math.max(1, spacing);
  let travelled = 0;
  const forwardDistance = to >= from ? (to - from) : (total - from + to);
  while (travelled + step < forwardDistance - 1e-6) {
    travelled += step;
    points.push(sampleAtDistance(closed, lengths, modDistance(from + travelled, total)));
  }
  points.push(sampleAtDistance(closed, lengths, to));
  return dedupePolyline(points);
}

export function buildAttachedBoundaryStrip(frontagePolyline, depth, hintVector, spacing = 5) {
  if (!Array.isArray(frontagePolyline) || frontagePolyline.length < 2) return null;
  const lengths = arcLengths(frontagePolyline);
  const total = lengths[lengths.length - 1];
  if (total <= 1e-6) return null;
  return buildPerpendicularStrip(frontagePolyline, 0, total, depth, hintVector, spacing);
}

export function buildAttachedBoundaryQuad(frontagePolyline, fromDistance, toDistance, depth, hintVector) {
  if (!Array.isArray(frontagePolyline) || frontagePolyline.length < 2) return null;
  const lengths = arcLengths(frontagePolyline);
  const total = lengths[lengths.length - 1];
  const start = clamp(fromDistance, 0, total);
  const end = clamp(toDistance, 0, total);
  if (end - start < 1e-6) return null;

  const frontStart = sampleAtDistance(frontagePolyline, lengths, start);
  const frontEnd = sampleAtDistance(frontagePolyline, lengths, end);
  const startNormal = normalAtDistance(frontagePolyline, lengths, start, hintVector);
  const endNormal = normalAtDistance(frontagePolyline, lengths, end, hintVector);
  if (!frontStart || !frontEnd || !startNormal || !endNormal) return null;

  const rearStart = {
    x: frontStart.x + startNormal.x * depth,
    z: frontStart.z + startNormal.z * depth,
  };
  const rearEnd = {
    x: frontEnd.x + endNormal.x * depth,
    z: frontEnd.z + endNormal.z * depth,
  };
  return {
    frontEdge: [frontStart, frontEnd],
    rearEdge: [rearStart, rearEnd],
    sideEdges: [
      [frontStart, rearStart],
      [frontEnd, rearEnd],
    ],
    polygon: [frontStart, frontEnd, rearEnd, rearStart],
  };
}

export function buildRegularizedAttachedBoundaryQuad(frontagePolyline, depth, hintVector) {
  if (!Array.isArray(frontagePolyline) || frontagePolyline.length < 2) return null;
  const frontStart = frontagePolyline[0];
  const frontEnd = frontagePolyline[frontagePolyline.length - 1];
  const normal = normalize(hintVector);
  if (!frontStart || !frontEnd || !normal) return null;
  const rearStart = {
    x: frontStart.x + normal.x * depth,
    z: frontStart.z + normal.z * depth,
  };
  const rearEnd = {
    x: frontEnd.x + normal.x * depth,
    z: frontEnd.z + normal.z * depth,
  };
  return {
    frontEdge: [frontStart, frontEnd],
    rearEdge: [rearStart, rearEnd],
    sideEdges: [
      [frontStart, rearStart],
      [frontEnd, rearEnd],
    ],
    polygon: [frontStart, frontEnd, rearEnd, rearStart],
  };
}

export function buildBoundaryAttachedResidualPolygon(boundaryPolyline, frontEdge, rearEdge, spacing = 5) {
  if (!Array.isArray(boundaryPolyline) || boundaryPolyline.length < 3) return null;
  if (!Array.isArray(frontEdge) || frontEdge.length < 2) return null;
  if (!Array.isArray(rearEdge) || rearEdge.length < 2) return null;

  const closedBoundary = ensureClosedPolyline(boundaryPolyline);
  const frontStart = frontEdge[0];
  const frontEnd = frontEdge[frontEdge.length - 1];
  const rearStart = rearEdge[0];
  const rearEnd = rearEdge[rearEdge.length - 1];
  const startProjection = projectPointOntoPolyline(frontStart, closedBoundary);
  const endProjection = projectPointOntoPolyline(frontEnd, closedBoundary);
  if (!startProjection || !endProjection) return null;

  const forwardA = sliceClosedPolylineForward(
    closedBoundary,
    startProjection.distanceAlong,
    endProjection.distanceAlong,
    spacing,
  );
  const forwardB = sliceClosedPolylineForward(
    closedBoundary,
    endProjection.distanceAlong,
    startProjection.distanceAlong,
    spacing,
  );
  const boundaryReturn = polylineLength(forwardB) >= polylineLength(forwardA)
    ? forwardB
    : [...forwardA].reverse();

  const polygon = dedupePolyline([
    frontStart,
    rearStart,
    rearEnd,
    frontEnd,
    ...boundaryReturn.slice(1, -1),
  ]);
  return polygon.length >= 3 ? polygon : null;
}

export function buildBoundaryClaimsResidualPolygon(boundaryPolyline, claims = [], spacing = 5) {
  if (!Array.isArray(boundaryPolyline) || boundaryPolyline.length < 3) return null;
  const closedBoundary = ensureClosedPolyline(boundaryPolyline);
  const usableClaims = (claims || [])
    .filter(claim => claim && Array.isArray(claim.replacementPath) && claim.replacementPath.length >= 2)
    .map(claim => {
      const startProjection = projectPointOntoPolyline(claim.replacementPath[0], closedBoundary);
      const endProjection = projectPointOntoPolyline(claim.replacementPath[claim.replacementPath.length - 1], closedBoundary);
      if (!startProjection || !endProjection) return null;
      const fromDistance = Math.min(startProjection.distanceAlong, endProjection.distanceAlong);
      const toDistance = Math.max(startProjection.distanceAlong, endProjection.distanceAlong);
      return {
        ...claim,
        fromDistance,
        toDistance,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.fromDistance - b.fromDistance);

  if (usableClaims.length === 0) return dedupePolyline(closedBoundary.slice(0, -1));

  const polygon = [];
  for (let i = 0; i < usableClaims.length; i++) {
    const claim = usableClaims[i];
    if (polygon.length === 0) {
      polygon.push(...claim.replacementPath);
    } else {
      const prev = usableClaims[i - 1];
      const gap = sliceClosedPolylineForward(closedBoundary, prev.toDistance, claim.fromDistance, spacing);
      polygon.push(...gap.slice(1));
      polygon.push(...claim.replacementPath.slice(1));
    }
  }

  const first = usableClaims[0];
  const last = usableClaims[usableClaims.length - 1];
  const closingGap = sliceClosedPolylineForward(closedBoundary, last.toDistance, first.fromDistance, spacing);
  polygon.push(...closingGap.slice(1));

  return dedupePolyline(polygon);
}

export function buildStripPolygon(frontagePolyline, rearPolyline) {
  return [
    ...frontagePolyline.map(point => ({ x: point.x, z: point.z })),
    ...[...rearPolyline].reverse().map(point => ({ x: point.x, z: point.z })),
  ];
}

export function buildCornerCutPolygon(corner, edgeDirA, edgeDirB, distanceA, distanceB) {
  const dirA = normalize(edgeDirA);
  const dirB = normalize(edgeDirB);
  if (!dirA || !dirB) return [];
  return [
    { x: corner.x, z: corner.z },
    {
      x: corner.x + dirA.x * distanceA,
      z: corner.z + dirA.z * distanceA,
    },
    {
      x: corner.x + dirB.x * distanceB,
      z: corner.z + dirB.z * distanceB,
    },
  ];
}

export function ensureClosedPolyline(polyline) {
  if (!Array.isArray(polyline) || polyline.length === 0) return [];
  const closed = [...polyline];
  if (distance(closed[0], closed[closed.length - 1]) > 1e-6) {
    closed.push({ ...closed[0] });
  }
  return closed;
}

export function splitDistanceRange(start, end, cutRanges = [], minLength = 0) {
  const cuts = [];
  for (const range of cutRanges) {
    const from = Math.max(start, Math.min(end, range.from));
    const to = Math.max(start, Math.min(end, range.to));
    if (to > from) cuts.push({ from, to });
  }
  cuts.sort((a, b) => a.from - b.from);
  const segments = [];
  let cursor = start;
  for (const cut of cuts) {
    if (cut.from - cursor >= minLength) segments.push({ from: cursor, to: cut.from });
    cursor = Math.max(cursor, cut.to);
  }
  if (end - cursor >= minLength) segments.push({ from: cursor, to: end });
  return segments;
}

export function subdivideDistanceRange(start, end, targetLength, minLength = 0) {
  const total = end - start;
  if (total <= 0) return [];
  if (!Number.isFinite(targetLength) || targetLength <= 0 || total <= targetLength * 1.35) {
    return total >= minLength ? [{ from: start, to: end }] : [];
  }
  const count = Math.max(1, Math.round(total / targetLength));
  const segments = [];
  for (let i = 0; i < count; i++) {
    const from = start + (total * i) / count;
    const to = start + (total * (i + 1)) / count;
    if (to - from >= minLength) segments.push({ from, to });
  }
  return segments;
}

export function projectPointOntoPolyline(point, polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return null;
  let best = null;
  let bestDistSq = Infinity;
  const lengths = arcLengths(polyline);
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const proj = projectPointOntoSegment(point, a, b);
    if (!proj) continue;
    const distSq = (proj.x - point.x) ** 2 + (proj.z - point.z) ** 2;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = {
        ...proj,
        segmentIndex: i,
        distanceAlong: lengths[i] + distance(a, proj),
      };
    }
  }
  return best;
}

export function polygonArea(polygon) {
  return Math.abs(signedPolygonArea(polygon));
}

export function polygonCentroid(polygon) {
  return mathPolygonCentroid(polygon);
}

export function polygonBounds(polygon) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of polygon || []) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return { minX, maxX, minZ, maxZ };
}

export function rectanglePolygon(minX, minZ, maxX, maxZ) {
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
}

export function orientedRectanglePolygon(center, tangent, normal, length, depth) {
  const t = normalize(tangent);
  const n = normalize(normal);
  if (!t || !n) return [];
  const halfLength = length * 0.5;
  const halfDepth = depth * 0.5;
  return [
    {
      x: center.x - t.x * halfLength - n.x * halfDepth,
      z: center.z - t.z * halfLength - n.z * halfDepth,
    },
    {
      x: center.x + t.x * halfLength - n.x * halfDepth,
      z: center.z + t.z * halfLength - n.z * halfDepth,
    },
    {
      x: center.x + t.x * halfLength + n.x * halfDepth,
      z: center.z + t.z * halfLength + n.z * halfDepth,
    },
    {
      x: center.x - t.x * halfLength + n.x * halfDepth,
      z: center.z - t.z * halfLength + n.z * halfDepth,
    },
  ];
}

export function polygonEdgeMidpoints(polygon) {
  const midpoints = [];
  for (let i = 0; i < (polygon?.length || 0); i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    midpoints.push({
      x: (a.x + b.x) * 0.5,
      z: (a.z + b.z) * 0.5,
      edgeIndex: i,
    });
  }
  return midpoints;
}

export function insetPolygonUniform(polygon, distance) {
  return insetPolygon(polygon, distance);
}

export function clipPolylineToRect(polyline, bounds) {
  return clipPolylineToBounds(polyline, bounds);
}

export function dedupePolyline(polyline) {
  const result = [];
  for (const point of polyline || []) {
    if (result.length === 0) {
      result.push(point);
      continue;
    }
    const last = result[result.length - 1];
    if (distance(last, point) <= 1e-6) continue;
    result.push(point);
  }
  return result;
}

function tangentAtIndex(polyline, index) {
  const prev = polyline[Math.max(0, index - 1)];
  const next = polyline[Math.min(polyline.length - 1, index + 1)];
  return normalize({
    x: next.x - prev.x,
    z: next.z - prev.z,
  }) || { x: 1, z: 0 };
}

function projectPointOntoSegment(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-9) return null;
  const t = clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / lenSq, 0, 1);
  return {
    x: a.x + dx * t,
    z: a.z + dz * t,
    t,
  };
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function dot(a, b) {
  return a.x * b.x + a.z * b.z;
}

function normalize(vector) {
  const len = Math.hypot(vector.x, vector.z);
  if (len < 1e-9) return null;
  return { x: vector.x / len, z: vector.z / len };
}

function modDistance(value, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const mod = value % total;
  return mod < 0 ? mod + total : mod;
}
