/**
 * Clip a world-coordinate polyline to a rectangular boundary,
 * interpolating exact crossing points and extra numeric properties.
 */

/**
 * Segment-segment intersection returning the t parameter along the first segment.
 * Returns { x, z, t } or null if no intersection.
 */
function _segSegIntersect(a1, a2, b1, b2) {
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
    return {
      x: a1.x + t * dx1,
      z: a1.z + t * dz1,
      t,
    };
  }

  return null;
}

function _isInside(point, bounds) {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.z >= bounds.minZ &&
    point.z <= bounds.maxZ
  );
}

/**
 * Build the 4 boundary edges for intersection testing.
 */
function _boundaryEdges(bounds) {
  return [
    // Left edge
    [{ x: bounds.minX, z: bounds.minZ }, { x: bounds.minX, z: bounds.maxZ }],
    // Right edge
    [{ x: bounds.maxX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.maxZ }],
    // Bottom edge (min z)
    [{ x: bounds.minX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.minZ }],
    // Top edge (max z)
    [{ x: bounds.minX, z: bounds.maxZ }, { x: bounds.maxX, z: bounds.maxZ }],
  ];
}

/**
 * Find all crossing points of a segment with the boundary rectangle,
 * sorted by t parameter (ascending).
 */
function _findAllBoundaryCrossings(a, b, edges) {
  const hits = [];
  for (const [e1, e2] of edges) {
    const hit = _segSegIntersect(a, b, e1, e2);
    if (hit) {
      hits.push(hit);
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

/**
 * Find the first (smallest t) crossing point of a segment with the boundary.
 * Returns { x, z, t } or null.
 */
function _findBoundaryCrossing(a, b, edges) {
  const hits = _findAllBoundaryCrossings(a, b, edges);
  return hits.length > 0 ? hits[0] : null;
}

/**
 * Interpolate all extra numeric properties from point a to point b at parameter t.
 * Returns a new point with x, z, and all interpolated numeric extras.
 */
function _interpolatePoint(a, b, t, x, z) {
  const result = { x, z };
  for (const key of Object.keys(a)) {
    if (key === 'x' || key === 'z') continue;
    if (typeof a[key] === 'number' && typeof b[key] === 'number') {
      result[key] = a[key] + (b[key] - a[key]) * t;
    }
  }
  return result;
}

/**
 * Clip a polyline to a rectangular boundary.
 *
 * @param {Array<{x: number, z: number}>} polyline - Points with optional extra numeric props
 * @param {{minX: number, minZ: number, maxX: number, maxZ: number}} bounds
 * @returns {{ clipped: Array<{x, z}>, entryDir: {x,z}|null, exitDir: {x,z}|null } | null}
 */
export function clipPolylineToBounds(polyline, bounds) {
  if (!polyline || polyline.length < 2) return null;

  const edges = _boundaryEdges(bounds);
  const clipped = [];
  let entryDir = null;
  let exitDir = null;
  let inside = false;

  for (let i = 0; i < polyline.length; i++) {
    const pt = polyline[i];
    const ptInside = _isInside(pt, bounds);

    if (i === 0) {
      if (ptInside) {
        inside = true;
        clipped.push(pt);
      }
      continue;
    }

    const prev = polyline[i - 1];
    const prevInside = i === 1 ? _isInside(prev, bounds) : inside;

    if (!prevInside && ptInside) {
      // Crossing from outside to inside
      const crossing = _findBoundaryCrossing(prev, pt, edges);
      if (crossing) {
        const interpPt = _interpolatePoint(prev, pt, crossing.t, crossing.x, crossing.z);
        clipped.push(interpPt);

        // Entry direction: direction of this segment, normalized
        const dx = pt.x - prev.x;
        const dz = pt.z - prev.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0) {
          entryDir = { x: dx / len, z: dz / len };
        }
      }
      clipped.push(pt);
      inside = true;
    } else if (prevInside && !ptInside) {
      // Crossing from inside to outside
      const crossing = _findBoundaryCrossing(prev, pt, edges);
      if (crossing) {
        const interpPt = _interpolatePoint(prev, pt, crossing.t, crossing.x, crossing.z);
        clipped.push(interpPt);

        // Exit direction: direction of this segment, normalized
        const dx = pt.x - prev.x;
        const dz = pt.z - prev.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0) {
          exitDir = { x: dx / len, z: dz / len };
        }
      }
      inside = false;
    } else if (prevInside && ptInside) {
      // Both inside, just add the point
      clipped.push(pt);
    } else if (!prevInside && !ptInside) {
      // Both outside -- but segment might pass through the bounds
      const crossings = _findAllBoundaryCrossings(prev, pt, edges);
      if (crossings.length >= 2) {
        // Entry crossing (first hit)
        const entry = crossings[0];
        const entryPt = _interpolatePoint(prev, pt, entry.t, entry.x, entry.z);
        clipped.push(entryPt);

        const dx = pt.x - prev.x;
        const dz = pt.z - prev.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0) {
          entryDir = { x: dx / len, z: dz / len };
        }

        // Exit crossing (second hit)
        const exit = crossings[1];
        const exitPt = _interpolatePoint(prev, pt, exit.t, exit.x, exit.z);
        clipped.push(exitPt);

        if (len > 0) {
          exitDir = { x: dx / len, z: dz / len };
        }
      }
    }
  }

  if (clipped.length === 0) return null;

  return { clipped, entryDir, exitDir };
}
