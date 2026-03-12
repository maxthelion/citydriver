import { chaikinSmooth } from '../core/math.js';

export const CONTOUR_SLOPE_THRESHOLD = 0.1;

const CROSS_STREET_INTERVAL = 90;  // meters between cross streets
const MIN_STREET_LENGTH = 20;      // meters — skip streets shorter than this
const CONTOUR_SAMPLE_INTERVAL = 5; // meters between samples along street
const CONTOUR_TOLERANCE = 1;       // meters — max elevation deviation

/**
 * Compute the ribbon (street) orientation for a zone.
 * Returns a unit direction vector for the streets.
 *
 * - Slope > 0.1: contour-following (perpendicular to gradient)
 * - Slope <= 0.1: bearing toward nucleus
 *
 * @param {Object} zone - Zone with avgSlope, slopeDir, centroidGx, centroidGz
 * @param {Object} nucleus - { gx, gz }
 * @param {number} _cellSize - unused, kept for API compatibility
 * @returns {{ dx: number, dz: number }} Unit direction vector for streets
 */
export function computeRibbonOrientation(zone, nucleus, _cellSize) {
  if (zone.avgSlope > CONTOUR_SLOPE_THRESHOLD && (zone.slopeDir.x !== 0 || zone.slopeDir.z !== 0)) {
    // Contour-following: streets perpendicular to slope direction
    const dx = -zone.slopeDir.z;
    const dz = zone.slopeDir.x;
    const len = Math.sqrt(dx * dx + dz * dz);
    return { dx: dx / len, dz: dz / len };
  }

  // Flat ground: bearing from zone centroid toward nucleus
  const bearX = nucleus.gx - zone.centroidGx;
  const bearZ = nucleus.gz - zone.centroidGz;
  const len = Math.sqrt(bearX * bearX + bearZ * bearZ);

  if (len < 0.01) {
    return { dx: 0, dz: 1 };
  }

  return { dx: bearX / len, dz: bearZ / len };
}

/**
 * Compute ribbon spacing based on distance from nucleus.
 */
function ribbonSpacing(distFromNucleus) {
  if (distFromNucleus < 100) return 30;
  if (distFromNucleus < 300) return 40;
  return 50;
}

/**
 * Clip a line segment to a (possibly concave) polygon.
 * Returns an array of clipped segments. Each segment is [start, end].
 */
function clipLineToPolygon(p1, p2, polygon) {
  const dx = p2.x - p1.x, dz = p2.z - p1.z;
  const n = polygon.length;
  const intersections = [];

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const edx = b.x - a.x, edz = b.z - a.z;
    const denom = dx * edz - dz * edx;
    if (Math.abs(denom) < 1e-10) continue;

    const t = ((a.x - p1.x) * edz - (a.z - p1.z) * edx) / denom;
    const u = ((a.x - p1.x) * dz - (a.z - p1.z) * dx) / denom;

    if (u >= 0 && u <= 1 && t >= 0 && t <= 1) {
      intersections.push(t);
    }
  }

  if (intersections.length < 2) {
    const mx = (p1.x + p2.x) / 2, mz = (p1.z + p2.z) / 2;
    if (pointInPoly(mx, mz, polygon)) return [[p1, p2]];
    return [];
  }

  intersections.sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < intersections.length - 1; i += 2) {
    const t0 = intersections[i];
    const t1 = intersections[i + 1];
    if (t1 - t0 < 1e-6) continue;
    segments.push([
      { x: p1.x + t0 * dx, z: p1.z + t0 * dz },
      { x: p1.x + t1 * dx, z: p1.z + t1 * dz },
    ]);
  }

  return segments;
}

function pointInPoly(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Layout parallel streets within a development zone.
 *
 * @param {Object} zone - Zone with boundary polygon, centroid, distFromNucleus
 * @param {{ dx: number, dz: number }} direction - Street direction (unit vector)
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 * @returns {{ spine: Array, parallel: Array<Array>, cross: Array<Array>, spacing: number }}
 */
export function layoutRibbonStreets(zone, direction, cellSize, originX, originZ) {
  const boundary = zone.boundary;
  if (!boundary || boundary.length < 3) return { spine: [], parallel: [], cross: [], spacing: 30 };

  const spacing = ribbonSpacing(zone.distFromNucleus);
  const { dx, dz } = direction;
  const px = -dz, pz = dx;

  const cx = originX + zone.centroidGx * cellSize;
  const cz = originZ + zone.centroidGz * cellSize;

  // Find zone extent along perpendicular and street axes
  let minPerp = Infinity, maxPerp = -Infinity;
  let minAlong = Infinity, maxAlong = -Infinity;
  for (const pt of boundary) {
    const projPerp = (pt.x - cx) * px + (pt.z - cz) * pz;
    if (projPerp < minPerp) minPerp = projPerp;
    if (projPerp > maxPerp) maxPerp = projPerp;
    const projAlong = (pt.x - cx) * dx + (pt.z - cz) * dz;
    if (projAlong < minAlong) minAlong = projAlong;
    if (projAlong > maxAlong) maxAlong = projAlong;
  }

  const parallel = [];
  let spine = null;

  for (let offset = 0; offset <= maxPerp + spacing; offset += spacing) {
    for (const sign of [1, -1]) {
      if (offset === 0 && sign === -1) continue;
      const actualOffset = offset * sign;
      if (actualOffset < minPerp - spacing || actualOffset > maxPerp + spacing) continue;

      const lineCx = cx + px * actualOffset;
      const lineCz = cz + pz * actualOffset;
      const p1 = { x: lineCx + dx * (minAlong - 50), z: lineCz + dz * (minAlong - 50) };
      const p2 = { x: lineCx + dx * (maxAlong + 50), z: lineCz + dz * (maxAlong + 50) };

      const segments = clipLineToPolygon(p1, p2, boundary);
      for (const seg of segments) {
        const len = Math.sqrt((seg[1].x - seg[0].x) ** 2 + (seg[1].z - seg[0].z) ** 2);
        if (len < MIN_STREET_LENGTH) continue;
        parallel.push(seg);
        if (offset === 0 && !spine) spine = seg;
      }
    }
  }

  if (!spine && parallel.length > 0) spine = parallel[0];

  // Cross streets connecting adjacent parallels
  const cross = [];
  parallel.sort((a, b) => {
    const aOff = (a[0].x - cx) * px + (a[0].z - cz) * pz;
    const bOff = (b[0].x - cx) * px + (b[0].z - cz) * pz;
    return aOff - bOff;
  });

  for (let i = 0; i < parallel.length - 1; i++) {
    const st1 = parallel[i], st2 = parallel[i + 1];

    const s1Start = (st1[0].x - cx) * dx + (st1[0].z - cz) * dz;
    const s1End = (st1[1].x - cx) * dx + (st1[1].z - cz) * dz;
    const s2Start = (st2[0].x - cx) * dx + (st2[0].z - cz) * dz;
    const s2End = (st2[1].x - cx) * dx + (st2[1].z - cz) * dz;

    const overlapStart = Math.max(Math.min(s1Start, s1End), Math.min(s2Start, s2End));
    const overlapEnd = Math.min(Math.max(s1Start, s1End), Math.max(s2Start, s2End));
    if (overlapEnd - overlapStart < MIN_STREET_LENGTH) continue;

    for (let along = overlapStart + CROSS_STREET_INTERVAL / 2; along < overlapEnd; along += CROSS_STREET_INTERVAL) {
      const t1 = (along - Math.min(s1Start, s1End)) / Math.abs(s1End - s1Start);
      const t2 = (along - Math.min(s2Start, s2End)) / Math.abs(s2End - s2Start);
      if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) continue;

      const p1x = st1[0].x + t1 * (st1[1].x - st1[0].x);
      const p1z = st1[0].z + t1 * (st1[1].z - st1[0].z);
      const p2x = st2[0].x + t2 * (st2[1].x - st2[0].x);
      const p2z = st2[0].z + t2 * (st2[1].z - st2[0].z);

      cross.push([{ x: p1x, z: p1z }, { x: p2x, z: p2z }]);
    }
  }

  return { spine: spine || [], parallel, cross, spacing };
}

/**
 * Adjust a street polyline to follow a constant elevation contour.
 * Densifies the line, then nudges each point perpendicular to slope direction
 * to maintain constant elevation. Smooths result with Chaikin.
 *
 * @param {Array<{x,z}>} street - Original street endpoints (2-point segment)
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {{x,z}} slopeDir - Gradient direction (unit vector)
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 * @returns {Array<{x,z}>} Adjusted polyline
 */
export function adjustStreetToContour(street, elevation, slopeDir, cellSize, originX, originZ) {
  if (street.length < 2) return street;

  // Densify: place points at regular intervals
  const totalLen = Math.sqrt(
    (street[1].x - street[0].x) ** 2 + (street[1].z - street[0].z) ** 2
  );
  const numPts = Math.max(2, Math.ceil(totalLen / CONTOUR_SAMPLE_INTERVAL));
  const pts = [];
  for (let i = 0; i <= numPts; i++) {
    const t = i / numPts;
    pts.push({
      x: street[0].x + t * (street[1].x - street[0].x),
      z: street[0].z + t * (street[1].z - street[0].z),
    });
  }

  // Find target elevation (average of all sample points)
  let elevSum = 0;
  for (const p of pts) {
    const gx = (p.x - originX) / cellSize;
    const gz = (p.z - originZ) / cellSize;
    elevSum += elevation.sample(gx, gz);
  }
  const targetElev = elevSum / pts.length;

  // Nudge each point perpendicular to slope to match target elevation
  const adjusted = pts.map(p => {
    const gx = (p.x - originX) / cellSize;
    const gz = (p.z - originZ) / cellSize;
    const currentElev = elevation.sample(gx, gz);
    const diff = currentElev - targetElev;

    if (Math.abs(diff) < CONTOUR_TOLERANCE) return { ...p };

    const slopeMag = Math.sqrt(slopeDir.x ** 2 + slopeDir.z ** 2);
    const nudgeDist = diff * cellSize / Math.max(0.01, slopeMag);
    return {
      x: p.x - slopeDir.x * nudgeDist,
      z: p.z - slopeDir.z * nudgeDist,
    };
  });

  // Chaikin smooth (2 passes)
  let result = adjusted;
  for (let i = 0; i < 2; i++) {
    if (result.length >= 3) result = chaikinSmooth(result);
  }

  return result;
}
