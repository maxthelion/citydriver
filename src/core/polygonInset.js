/**
 * Compute the inset (offset inward) of a polygon.
 * Each edge can have a different inset distance.
 *
 * Algorithm: for each edge, compute the inward-offset edge (parallel line
 * shifted by distance). Then intersect consecutive offset edges to get new
 * vertices.
 *
 * Uses (x, z) convention consistent with the rest of the codebase (y is up).
 *
 * @param {Array<{x: number, z: number}>} polygon — vertices in order (CW or CCW)
 * @param {number|number[]} distances — uniform distance or per-edge distances
 * @returns {Array<{x: number, z: number}>} inset polygon (empty if collapsed)
 */
export function insetPolygon(polygon, distances) {
  const n = polygon.length;
  if (n < 3) return [];

  // Normalise distances to per-edge array
  const dist = typeof distances === 'number'
    ? new Array(n).fill(distances)
    : distances;

  if (dist.length !== n) {
    throw new Error(`Expected ${n} distances, got ${dist.length}`);
  }

  // All-zero distances → return copy
  if (dist.every(d => d === 0)) {
    return polygon.map(p => ({ x: p.x, z: p.z }));
  }

  // 1. Determine winding direction via signed area (shoelace formula).
  //    Positive signed area → CCW; negative → CW.
  const signedArea = computeSignedArea(polygon);
  if (Math.abs(signedArea) < 1e-12) return [];

  // Winding sign: +1 for CCW, -1 for CW
  const windSign = signedArea > 0 ? 1 : -1;

  // 2. For each edge, compute the inward-offset line.
  //    Edge i goes from polygon[i] to polygon[(i+1)%n].
  //    The inward normal points into the polygon interior.
  //
  //    For CCW winding: the inward normal of edge (dx, dz) is (-dz, dx) normalised.
  //    For CW winding:  the inward normal is (dz, -dx) normalised.
  const offsetEdges = []; // Each: { px, pz, dx, dz } — point on offset line + direction

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const edgeDx = polygon[j].x - polygon[i].x;
    const edgeDz = polygon[j].z - polygon[i].z;
    const len = Math.sqrt(edgeDx * edgeDx + edgeDz * edgeDz);
    if (len < 1e-12) {
      // Degenerate edge — use a zero-length offset edge
      offsetEdges.push({ px: polygon[i].x, pz: polygon[i].z, dx: 0, dz: 0 });
      continue;
    }

    // Unit direction along edge
    const ux = edgeDx / len;
    const uz = edgeDz / len;

    // Inward normal: for CCW → (-uz, ux); for CW → (uz, -ux)
    const nx = -windSign * uz;
    const nz = windSign * ux;

    // Offset the edge start point by distance * inward normal
    const d = dist[i];
    const px = polygon[i].x + nx * d;
    const pz = polygon[i].z + nz * d;

    offsetEdges.push({ px, pz, dx: ux, dz: uz });
  }

  // 3. For each vertex i, find the intersection of the offset edge ending at i
  //    (edge i-1) and the offset edge starting at i (edge i).
  //    This gives the new position of vertex i in the inset polygon.
  const result = [];

  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const eA = offsetEdges[prev]; // edge ending at vertex i
    const eB = offsetEdges[i];    // edge starting at vertex i

    const pt = lineLineIntersection(
      eA.px, eA.pz, eA.dx, eA.dz,
      eB.px, eB.pz, eB.dx, eB.dz,
    );

    if (pt) {
      result.push({ x: pt.x, z: pt.z });
    } else {
      // Parallel edges: use midpoint of the two offset edge endpoints
      result.push({
        x: (eA.px + eB.px) / 2,
        z: (eA.pz + eB.pz) / 2,
      });
    }
  }

  // 4. Check for degenerate result.
  const resultArea = computeSignedArea(result);

  // If sign flipped or area is essentially zero, polygon collapsed
  if (Math.abs(resultArea) < 1e-8) return [];
  if ((resultArea > 0) !== (signedArea > 0)) return [];

  // Check that no inset edge has reversed direction compared to the original.
  // When the inset overshoots (distance > half-width), edges flip direction.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const origDx = polygon[j].x - polygon[i].x;
    const origDz = polygon[j].z - polygon[i].z;
    const insetDx = result[j].x - result[i].x;
    const insetDz = result[j].z - result[i].z;
    // Dot product: if negative, the edge has reversed
    const dot = origDx * insetDx + origDz * insetDz;
    if (dot < 0) return [];
  }

  // 5. Check for self-intersections and clip if needed.
  //    For simple cases (convex polygons or mild insets) there won't be any.
  //    For aggressive insets on concave polygons we do a basic check.
  if (hasSelfIntersection(result)) {
    // Attempt to salvage by removing self-intersecting portions.
    // This is a simplified approach: just return empty for now.
    // A full implementation would use Vatti/Greiner-Hormann clipping.
    return [];
  }

  return result;
}

/**
 * Compute the signed area of a polygon using the shoelace formula.
 * Positive = CCW, negative = CW.
 *
 * @param {Array<{x: number, z: number}>} polygon
 * @returns {number}
 */
export function computeSignedArea(polygon) {
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
 * Intersection of two lines defined as point + direction.
 * Line A: P_a + t * D_a
 * Line B: P_b + u * D_b
 *
 * @returns {{x: number, z: number} | null} intersection point, or null if parallel
 */
function lineLineIntersection(pax, paz, dax, daz, pbx, pbz, dbx, dbz) {
  const denom = dax * dbz - daz * dbx;
  if (Math.abs(denom) < 1e-10) return null; // parallel

  const dpx = pbx - pax;
  const dpz = pbz - paz;
  const t = (dpx * dbz - dpz * dbx) / denom;

  return {
    x: pax + t * dax,
    z: paz + t * daz,
  };
}

/**
 * Check if a polygon has any self-intersections.
 * Tests all non-adjacent edge pairs.
 *
 * @param {Array<{x: number, z: number}>} polygon
 * @returns {boolean}
 */
function hasSelfIntersection(polygon) {
  const n = polygon.length;
  if (n < 4) return false;

  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent (wrap-around)
      const j2 = (j + 1) % n;

      if (segmentsProperlyIntersect(
        polygon[i].x, polygon[i].z, polygon[i2].x, polygon[i2].z,
        polygon[j].x, polygon[j].z, polygon[j2].x, polygon[j2].z,
      )) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Point-in-polygon test using ray casting.
 * @param {number} px
 * @param {number} pz
 * @param {Array<{x: number, z: number}>} polygon
 * @returns {boolean}
 */
function pointInPolygonTest(px, pz, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if (((zi > pz) !== (zj > pz)) &&
        (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Test if two segments properly intersect (cross each other, not just touch).
 */
function segmentsProperlyIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const dABx = bx - ax, dABz = bz - az;
  const dCDx = dx - cx, dCDz = dz - cz;
  const denom = dABx * dCDz - dABz * dCDx;
  if (Math.abs(denom) < 1e-10) return false;

  const dACx = cx - ax, dACz = cz - az;
  const t = (dACx * dCDz - dACz * dCDx) / denom;
  const u = (dACx * dABz - dACz * dABx) / denom;

  const EPS = 1e-6;
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS;
}
