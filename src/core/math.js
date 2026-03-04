/**
 * Pure math utility functions for 2D procedural generation.
 * All spatial functions use the (x, z) convention (y is up).
 */

/**
 * Linear interpolation from a to b by factor t.
 * @param {number} a
 * @param {number} b
 * @param {number} t - Interpolation factor (0 = a, 1 = b)
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Inverse of lerp: returns the t value such that lerp(a, b, t) === value.
 * @param {number} a
 * @param {number} b
 * @param {number} value
 * @returns {number}
 */
export function inverseLerp(a, b, value) {
  if (a === b) return 0;
  return (value - a) / (b - a);
}

/**
 * Hermite interpolation (smoothstep). Returns 0 when x <= edge0, 1 when x >= edge1,
 * and smoothly interpolates between using 3t^2 - 2t^3.
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Clamps value to [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Euclidean distance between two 2D points (x, z).
 * @param {number} x1
 * @param {number} z1
 * @param {number} x2
 * @param {number} z2
 * @returns {number}
 */
export function distance2D(x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Returns a unit vector in the direction of (x, z).
 * Returns {x: 0, z: 0} for zero-length input.
 * @param {number} x
 * @param {number} z
 * @returns {{x: number, z: number}}
 */
export function normalize2D(x, z) {
  const len = Math.sqrt(x * x + z * z);
  if (len === 0) return { x: 0, z: 0 };
  return { x: x / len, z: z / len };
}

/**
 * 2D cross product (scalar). Returns the z-component of the 3D cross product.
 * Positive if b is counter-clockwise from a.
 * @param {number} ax
 * @param {number} az
 * @param {number} bx
 * @param {number} bz
 * @returns {number}
 */
export function cross2D(ax, az, bx, bz) {
  return ax * bz - az * bx;
}

/**
 * 2D dot product.
 * @param {number} ax
 * @param {number} az
 * @param {number} bx
 * @param {number} bz
 * @returns {number}
 */
export function dot2D(ax, az, bx, bz) {
  return ax * bx + az * bz;
}

/**
 * Minimum distance from point (px, pz) to line segment (ax, az)-(bx, bz).
 * @param {number} px
 * @param {number} pz
 * @param {number} ax
 * @param {number} az
 * @param {number} bx
 * @param {number} bz
 * @returns {number}
 */
export function pointToSegmentDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;

  if (lenSq === 0) {
    // Segment is a point
    return distance2D(px, pz, ax, az);
  }

  // Project point onto segment line, clamped to [0, 1]
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = ax + t * dx;
  const projZ = az + t * dz;
  return distance2D(px, pz, projX, projZ);
}

/**
 * Tests whether a point (px, pz) is inside a polygon.
 * Uses the ray-casting algorithm.
 * @param {number} px
 * @param {number} pz
 * @param {{x: number, z: number}[]} polygon - Array of vertices
 * @returns {boolean}
 */
export function pointInPolygon(px, pz, polygon) {
  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;

    // Check if ray from (px, pz) in +x direction crosses edge (i, j)
    if (
      (zi > pz) !== (zj > pz) &&
      px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Signed area of a polygon. Positive for counter-clockwise winding.
 * Uses the shoelace formula.
 * @param {{x: number, z: number}[]} polygon
 * @returns {number}
 */
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

/**
 * Centroid of a polygon.
 * Uses the signed-area weighted formula for accuracy with non-convex polygons.
 * @param {{x: number, z: number}[]} polygon
 * @returns {{x: number, z: number}}
 */
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

/**
 * Tests whether two line segments intersect. Returns intersection point or null.
 * Segments: a1-a2 and b1-b2.
 * @param {{x: number, z: number}} a1
 * @param {{x: number, z: number}} a2
 * @param {{x: number, z: number}} b1
 * @param {{x: number, z: number}} b2
 * @returns {{x: number, z: number} | null}
 */
export function segmentsIntersect(a1, a2, b1, b2) {
  const dx1 = a2.x - a1.x;
  const dz1 = a2.z - a1.z;
  const dx2 = b2.x - b1.x;
  const dz2 = b2.z - b1.z;

  const denom = dx1 * dz2 - dz1 * dx2;

  // Parallel or coincident
  if (Math.abs(denom) < 1e-10) return null;

  const dx3 = b1.x - a1.x;
  const dz3 = b1.z - a1.z;

  const t = (dx3 * dz2 - dz3 * dx2) / denom;
  const u = (dx3 * dz1 - dz3 * dx1) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: a1.x + t * dx1,
      z: a1.z + t * dz1,
    };
  }

  return null;
}
