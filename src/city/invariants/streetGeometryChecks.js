/**
 * Cheap deterministic heuristics for road network quality.
 * These check world-state invariants on line geometry without
 * needing the full map or visual evaluation.
 *
 * All functions take arrays of line segments: [[{x,z}, {x,z}], ...]
 */

/**
 * Perpendicular distance from point to line segment.
 */
function pointToSegmentDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * Angle of a segment in degrees [0, 180).
 */
function segmentAngle(seg) {
  const dx = seg[1].x - seg[0].x;
  const dz = seg[1].z - seg[0].z;
  let a = Math.atan2(dz, dx) * 180 / Math.PI;
  if (a < 0) a += 180;
  if (a >= 180) a -= 180;
  return a;
}

/**
 * Length of a segment.
 */
function segmentLength(seg) {
  const dx = seg[1].x - seg[0].x;
  const dz = seg[1].z - seg[0].z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Check if two segments intersect (2D line-line intersection).
 * Returns the intersection point or null.
 */
function segmentIntersection(a, b) {
  const x1 = a[0].x, z1 = a[0].z, x2 = a[1].x, z2 = a[1].z;
  const x3 = b[0].x, z3 = b[0].z, x4 = b[1].x, z4 = b[1].z;

  const denom = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return null; // parallel

  const t = ((x1 - x3) * (z3 - z4) - (z1 - z3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (z1 - z3) - (z1 - z2) * (x1 - x3)) / denom;

  if (t >= 0.01 && t <= 0.99 && u >= 0.01 && u <= 0.99) {
    return { x: x1 + t * (x2 - x1), z: z1 + t * (z2 - z1) };
  }
  return null;
}

/**
 * Count pairs of parallel segments closer than minSeparation.
 *
 * Two segments are "parallel" if their angles differ by < angleTolerance degrees.
 * Distance is measured from the midpoint of the shorter segment to the longer one.
 *
 * @param {Array} segments - Array of [{x,z}, {x,z}] line segments
 * @param {number} minSeparation - Minimum distance in world units (default 5m)
 * @param {number} angleTolerance - Max angle difference to count as parallel (default 15 degrees)
 * @returns {number} Count of violations
 */
export function countParallelViolations(segments, minSeparation = 5, angleTolerance = 15) {
  let violations = 0;
  for (let i = 0; i < segments.length; i++) {
    const ai = segmentAngle(segments[i]);
    const midI = {
      x: (segments[i][0].x + segments[i][1].x) / 2,
      z: (segments[i][0].z + segments[i][1].z) / 2,
    };
    for (let j = i + 1; j < segments.length; j++) {
      const aj = segmentAngle(segments[j]);
      let angleDiff = Math.abs(ai - aj);
      if (angleDiff > 90) angleDiff = 180 - angleDiff;
      if (angleDiff > angleTolerance) continue;

      // Check distance from midpoint of i to segment j
      const dist = pointToSegmentDist(
        midI.x, midI.z,
        segments[j][0].x, segments[j][0].z,
        segments[j][1].x, segments[j][1].z
      );
      if (dist < minSeparation) {
        violations++;
      }
    }
  }
  return violations;
}

/**
 * Count unresolved crossings — segments that intersect without
 * sharing an endpoint (i.e. no junction at the crossing point).
 *
 * @param {Array} segments - Array of [{x,z}, {x,z}] line segments
 * @param {number} junctionRadius - Max distance to count as shared endpoint (default 3m)
 * @returns {number} Count of crossings without junctions
 */
export function countUnresolvedCrossings(segments, junctionRadius = 3) {
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const pt = segmentIntersection(segments[i], segments[j]);
      if (!pt) continue;

      // Check if any endpoint is near the intersection (= junction exists)
      const ends = [segments[i][0], segments[i][1], segments[j][0], segments[j][1]];
      const hasJunction = ends.some(e =>
        Math.hypot(e.x - pt.x, e.z - pt.z) < junctionRadius
      );
      if (!hasJunction) {
        crossings++;
      }
    }
  }
  return crossings;
}

/**
 * Count dead-end segments shorter than minimum length.
 * A dead-end is a segment where one endpoint is not shared by any other segment.
 *
 * @param {Array} segments - Array of [{x,z}, {x,z}] line segments
 * @param {number} minLength - Minimum dead-end length (default 15m)
 * @param {number} snapRadius - Max distance to count as shared endpoint (default 3m)
 * @returns {number} Count of short dead-ends
 */
export function countShortDeadEnds(segments, minLength = 15, snapRadius = 3) {
  let violations = 0;

  for (const seg of segments) {
    const len = segmentLength(seg);
    if (len >= minLength) continue;

    // Check each endpoint — is it shared with another segment?
    for (const endpoint of seg) {
      let connected = false;
      for (const other of segments) {
        if (other === seg) continue;
        if (Math.hypot(other[0].x - endpoint.x, other[0].z - endpoint.z) < snapRadius ||
            Math.hypot(other[1].x - endpoint.x, other[1].z - endpoint.z) < snapRadius) {
          connected = true;
          break;
        }
      }
      if (!connected) {
        violations++;
        break; // only count once per segment
      }
    }
  }
  return violations;
}

/**
 * Count segments that cross water cells.
 * Walk each segment at half-cell steps and check if any point falls on water.
 *
 * @param {Array} segments - Array of [{x,z}, {x,z}] line segments
 * @param {Object} waterMask - Grid layer with .get(gx, gz) returning water value
 * @param {number} ox - Origin X (world coords)
 * @param {number} oz - Origin Z (world coords)
 * @param {number} cs - Cell size
 * @param {number} W - Grid width
 * @param {number} H - Grid height
 * @returns {number} Count of segments that cross water
 */
export function countWaterCrossings(segments, waterMask, ox, oz, cs, W, H) {
  let violations = 0;
  for (const seg of segments) {
    const dx = seg[1].x - seg[0].x, dz = seg[1].z - seg[0].z;
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    const steps = Math.ceil(len / (cs * 0.5));
    let crossesWater = false;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const gx = Math.round((seg[0].x + dx * t - ox) / cs);
      const gz = Math.round((seg[0].z + dz * t - oz) / cs);
      if (gx >= 0 && gx < W && gz >= 0 && gz < H && waterMask.get(gx, gz) > 0) {
        crossesWater = true;
        break;
      }
    }
    if (crossesWater) violations++;
  }
  return violations;
}

/**
 * Like countParallelViolations but checks 3 points along each segment
 * (start, middle, end) against the other segment, not just midpoint.
 * Two parallel segments violate if ANY of the 3 points is within
 * minSeparation of the other segment.
 *
 * @param {Array} segments - Array of [{x,z}, {x,z}] line segments
 * @param {number} minSeparation - Minimum distance in world units (default 5m)
 * @param {number} angleTolerance - Max angle difference to count as parallel (default 15 degrees)
 * @returns {number} Count of violations
 */
export function countFullLengthParallelViolations(segments, minSeparation = 5, angleTolerance = 15) {
  let violations = 0;
  for (let i = 0; i < segments.length; i++) {
    const ai = segmentAngle(segments[i]);
    // 3 sample points: start, middle, end
    const points = [
      segments[i][0],
      {
        x: (segments[i][0].x + segments[i][1].x) / 2,
        z: (segments[i][0].z + segments[i][1].z) / 2,
      },
      segments[i][1],
    ];
    for (let j = i + 1; j < segments.length; j++) {
      const aj = segmentAngle(segments[j]);
      let angleDiff = Math.abs(ai - aj);
      if (angleDiff > 90) angleDiff = 180 - angleDiff;
      if (angleDiff > angleTolerance) continue;

      // Check distance from each of the 3 points of i to segment j
      let tooClose = false;
      for (const pt of points) {
        const dist = pointToSegmentDist(
          pt.x, pt.z,
          segments[j][0].x, segments[j][0].z,
          segments[j][1].x, segments[j][1].z
        );
        if (dist < minSeparation) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) violations++;
    }
  }
  return violations;
}

/**
 * Check how many zone cells are covered by terrain faces.
 * Given zone cells and face cell lists, count zone cells that aren't in any face.
 *
 * @param {Array} zoneCells - Array of {gx, gz} cells
 * @param {Array} faces - Array of { cells: [{gx, gz}, ...] }
 * @param {number} W - Grid width
 * @returns {{ uncoveredCells: number, totalZoneCells: number, coverageRatio: number }}
 */
export function checkFaceCoverage(zoneCells, faces, W) {
  const faceCellSet = new Set();
  for (const face of faces) {
    for (const c of face.cells) faceCellSet.add(c.gz * W + c.gx);
  }
  let uncovered = 0;
  for (const c of zoneCells) {
    if (!faceCellSet.has(c.gz * W + c.gx)) uncovered++;
  }
  return {
    uncoveredCells: uncovered,
    totalZoneCells: zoneCells.length,
    coverageRatio: 1 - uncovered / zoneCells.length,
  };
}

/**
 * Check parcel viability based on bounding-box dimensions.
 * Given a parcel polygon (4+ corners), compute width and depth,
 * and check minimum dimensions and aspect ratio.
 *
 * @param {Array} polygon - Array of {x, z} points
 * @param {number} cs - Cell size (unused but available for future thresholds)
 * @returns {{ width: number, depth: number, shortSide: number, longSide: number, ratio: number, tooShallow: boolean, tooNarrow: boolean, isSliver: boolean }}
 */
export function checkParcelViability(polygon, cs) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const w = maxX - minX, d = maxZ - minZ;
  const shortSide = Math.min(w, d);
  const longSide = Math.max(w, d);
  const ratio = longSide > 0 ? shortSide / longSide : 0;

  return {
    width: w,
    depth: d,
    shortSide,
    longSide,
    ratio,
    tooShallow: shortSide < 15,  // can't fit plots
    tooNarrow: longSide < 20,    // not enough frontage
    isSliver: ratio < 0.1,       // extremely elongated
  };
}

/**
 * Run all heuristic checks on a set of line segments.
 *
 * @param {Array} allSegments - All line segments (k3 + s2 combined)
 * @returns {{ parallelViolations: number, unresolvedCrossings: number, shortDeadEnds: number }}
 */
export function checkAllViolations(allSegments) {
  return {
    parallelViolations: countParallelViolations(allSegments),
    unresolvedCrossings: countUnresolvedCrossings(allSegments),
    shortDeadEnds: countShortDeadEnds(allSegments),
  };
}
