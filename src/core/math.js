/**
 * Pure math utility functions for 2D procedural generation.
 * All spatial functions use the (x, z) convention (y is up).
 */

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function inverseLerp(a, b, value) {
  if (a === b) return 0;
  return (value - a) / (b - a);
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function distance2D(x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return Math.sqrt(dx * dx + dz * dz);
}

export function normalize2D(x, z) {
  const len = Math.sqrt(x * x + z * z);
  if (len === 0) return { x: 0, z: 0 };
  return { x: x / len, z: z / len };
}

export function cross2D(ax, az, bx, bz) {
  return ax * bz - az * bx;
}

export function dot2D(ax, az, bx, bz) {
  return ax * bx + az * bz;
}

export function pointToSegmentDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;

  if (lenSq === 0) return distance2D(px, pz, ax, az);

  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = ax + t * dx;
  const projZ = az + t * dz;
  return distance2D(px, pz, projX, projZ);
}

export function pointInPolygon(px, pz, polygon) {
  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;

    if (
      (zi > pz) !== (zj > pz) &&
      px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}

export function polygonArea(polygon) {
  let area = 0;
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += polygon[i].x * polygon[j].z;
    area -= polygon[j].x * polygon[i].z;
  }

  return area / 2;
}

export function polygonCentroid(polygon) {
  const n = polygon.length;
  let cx = 0;
  let cz = 0;
  let signedArea = 0;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = polygon[i].x * polygon[j].z - polygon[j].x * polygon[i].z;
    cx += (polygon[i].x + polygon[j].x) * cross;
    cz += (polygon[i].z + polygon[j].z) * cross;
    signedArea += cross;
  }

  signedArea /= 2;
  const factor = 1 / (6 * signedArea);

  return { x: cx * factor, z: cz * factor };
}

export function segmentsIntersect(a1, a2, b1, b2) {
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

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: a1.x + t * dx1, z: a1.z + t * dz1 };
  }

  return null;
}

/**
 * Remap a value from one range to another.
 */
export function remap(value, inMin, inMax, outMin, outMax) {
  const t = (value - inMin) / (inMax - inMin);
  return outMin + t * (outMax - outMin);
}

/**
 * Chaikin corner-cutting smoothing (one iteration).
 * Preserves first and last points. Doubles point count per iteration.
 * Interpolates all numeric own-properties on each point object.
 */
export function chaikinSmooth(pts) {
  if (pts.length < 3) return pts;
  const result = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const q = { x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 };
    const r = { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 };
    if (a.y !== undefined && b.y !== undefined) {
      q.y = a.y * 0.75 + b.y * 0.25;
      r.y = a.y * 0.25 + b.y * 0.75;
    }
    result.push(q, r);
  }
  result.push(pts[pts.length - 1]);
  return result;
}
