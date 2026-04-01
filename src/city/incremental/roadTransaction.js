/**
 * Road Transaction — tentative add with invariant checking.
 *
 * tryAddRoad() adds a road to the network, checks it against
 * world-state invariants (crossings, water, separation), and
 * rolls back if any check fails. This is the single entry point
 * for any code that wants to lay a new road with validation.
 *
 * Checks performed (scoped to the new road vs existing roads):
 * - No unresolved crossings with existing roads
 * - No water crossings
 * - Minimum separation from parallel existing roads (5m)
 */

/**
 * Attempt to add a road to the map. If invariant checks fail,
 * the road is removed (rolled back) and violations are returned.
 *
 * @param {object} map - FeatureMap with roadNetwork, waterMask, etc.
 * @param {Array<{x: number, z: number}>} polyline - Road polyline in world coords
 * @param {object} [attrs] - Road attributes (width, hierarchy, source, etc.)
 * @param {object} [opts] - Check options
 * @param {number} [opts.minSeparation=5] - Min distance from parallel roads (metres)
 * @param {number} [opts.junctionRadius=3] - Endpoint snap tolerance for junctions (metres)
 * @param {number} [opts.angleTolerance=15] - Max angle diff (degrees) to count as parallel
 * @returns {{ accepted: boolean, road: Road|null, violations: string[], violationDetails: object[] }}
 */
export function tryAddRoad(map, polyline, attrs = {}, opts = {}) {
  const {
    minSeparation = 5,
    junctionRadius = 3,
    angleTolerance = 15,
  } = opts;

  if (!polyline || polyline.length < 2) {
    return { accepted: false, road: null, violations: ['polyline too short'], violationDetails: [{ type: 'polyline-too-short' }] };
  }

  // 1. Add tentatively
  const road = map.roadNetwork.add(polyline, attrs);

  // 2. Collect segments of the new road
  const newSegs = polylineToSegments(road.polyline);

  // 3. Collect segments of all OTHER existing roads (with bounding box filter)
  const bbox = segmentsBBox(newSegs, Math.max(minSeparation, junctionRadius) + 10);
  const existingSegs = [];
  for (const other of map.roadNetwork.roads) {
    if (other.id === road.id) continue;
    const otherSegs = polylineToSegments(other.polyline);
    for (const seg of otherSegs) {
      if (segInBBox(seg, bbox)) {
        existingSegs.push({
          seg,
          roadId: other.id,
          source: other.source ?? other.attrs?.source ?? null,
          hierarchy: other.hierarchy ?? other.attrs?.hierarchy ?? null,
        });
      }
    }
  }

  // 4. Run checks
  const violations = [];
  const violationDetails = [];

  // 4a. Unresolved crossings
  for (const ns of newSegs) {
    for (const existing of existingSegs) {
      const es = existing.seg;
      const pt = segmentIntersection(ns, es);
      if (!pt) continue;
      // Check if any endpoint is near the intersection (= junction)
      const ends = [ns[0], ns[1], es[0], es[1]];
      const hasJunction = ends.some(e =>
        Math.hypot(e.x - pt.x, e.z - pt.z) < junctionRadius
      );
      if (!hasJunction) {
        violations.push(`crosses existing road at (${pt.x.toFixed(0)},${pt.z.toFixed(0)})`);
        violationDetails.push({
          type: 'crossing',
          roadId: existing.roadId,
          roadSource: existing.source,
          roadHierarchy: existing.hierarchy,
          point: { x: pt.x, z: pt.z },
          newSegment: cloneSeg(ns),
          existingSegment: cloneSeg(es),
        });
      }
    }
  }

  // 4b. Water crossings
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  if (waterMask) {
    const cs = map.cellSize;
    const ox = map.originX;
    const oz = map.originZ;
    const W = map.width;
    const H = map.height;
    for (const seg of newSegs) {
      const len = Math.hypot(seg[1].x - seg[0].x, seg[1].z - seg[0].z);
      const steps = Math.ceil(len / (cs * 0.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const wx = seg[0].x + (seg[1].x - seg[0].x) * t;
        const wz = seg[0].z + (seg[1].z - seg[0].z) * t;
        const gx = Math.round((wx - ox) / cs);
        const gz = Math.round((wz - oz) / cs);
        if (gx >= 0 && gx < W && gz >= 0 && gz < H && waterMask.get(gx, gz) > 0) {
          violations.push(`crosses water at (${gx},${gz})`);
          violationDetails.push({
            type: 'water',
            cell: { gx, gz },
            point: { x: wx, z: wz },
            newSegment: cloneSeg(seg),
          });
          break; // one water violation per segment is enough
        }
      }
    }
  }

  // 4c. Minimum separation from parallel existing roads
  for (const ns of newSegs) {
    const nsAngle = segAngle(ns);
    const nsMid = { x: (ns[0].x + ns[1].x) / 2, z: (ns[0].z + ns[1].z) / 2 };
    for (const existing of existingSegs) {
      const es = existing.seg;
      const esAngle = segAngle(es);
      let angleDiff = Math.abs(nsAngle - esAngle);
      if (angleDiff > 90) angleDiff = 180 - angleDiff;
      if (angleDiff > angleTolerance) continue;

      const d = pointToSegDist(
        nsMid.x, nsMid.z,
        es[0].x, es[0].z, es[1].x, es[1].z
      );
      if (d < minSeparation) {
        violations.push(`parallel to existing road, ${d.toFixed(1)}m apart`);
        violationDetails.push({
          type: 'parallel',
          roadId: existing.roadId,
          roadSource: existing.source,
          roadHierarchy: existing.hierarchy,
          distance: d,
          angleDiff,
          midpoint: nsMid,
          newSegment: cloneSeg(ns),
          existingSegment: cloneSeg(es),
        });
        break; // one separation violation is enough to reject
      }
    }
  }

  // 5. Accept or roll back
  if (violations.length > 0) {
    map.roadNetwork.remove(road.id);
    return { accepted: false, road: null, violations, violationDetails };
  }

  return { accepted: true, road, violations: [], violationDetails: [] };
}

// === Geometry helpers ===

function polylineToSegments(polyline) {
  const segs = [];
  for (let i = 1; i < polyline.length; i++) {
    segs.push([polyline[i - 1], polyline[i]]);
  }
  return segs;
}

function segmentsBBox(segs, margin) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of segs) {
    for (const p of s) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}

function segInBBox(seg, bbox) {
  return !(seg[0].x > bbox.maxX && seg[1].x > bbox.maxX) &&
         !(seg[0].x < bbox.minX && seg[1].x < bbox.minX) &&
         !(seg[0].z > bbox.maxZ && seg[1].z > bbox.maxZ) &&
         !(seg[0].z < bbox.minZ && seg[1].z < bbox.minZ);
}

/**
 * Segment intersection — returns intersection point or null.
 * Uses t/u margins of [0.01, 0.99] to tolerate endpoint touches.
 * (Same logic as streetGeometryChecks.js)
 */
function segmentIntersection(a, b) {
  const x1 = a[0].x, z1 = a[0].z, x2 = a[1].x, z2 = a[1].z;
  const x3 = b[0].x, z3 = b[0].z, x4 = b[1].x, z4 = b[1].z;

  const denom = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return null;

  const t = ((x1 - x3) * (z3 - z4) - (z1 - z3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (z1 - z3) - (z1 - z2) * (x1 - x3)) / denom;

  if (t >= 0.01 && t <= 0.99 && u >= 0.01 && u <= 0.99) {
    return { x: x1 + t * (x2 - x1), z: z1 + t * (z2 - z1) };
  }
  return null;
}

function segAngle(seg) {
  const dx = seg[1].x - seg[0].x;
  const dz = seg[1].z - seg[0].z;
  let a = Math.atan2(dz, dx) * 180 / Math.PI;
  if (a < 0) a += 180;
  if (a >= 180) a -= 180;
  return a;
}

function pointToSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function cloneSeg(seg) {
  return [
    { x: seg[0].x, z: seg[0].z },
    { x: seg[1].x, z: seg[1].z },
  ];
}
