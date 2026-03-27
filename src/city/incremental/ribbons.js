/**
 * Ribbons — Contour-following streets between adjacent cross streets.
 *
 * Given a sorted list of cross streets (polylines), lays ribbon streets
 * between each adjacent pair. Each ribbon connects a point on one cross
 * street to a point on the adjacent cross street.
 *
 * Key constraint: after the first ribbon in a corridor, one endpoint is
 * determined (continuing the road from the previous ribbon) and the other
 * is placed at the target parcel depth along the adjacent cross street.
 * Sides alternate so the pattern self-corrects as corridors widen or narrow.
 */

export function layRibbons(crossStreets, zone, map, params = {}) {
  const p = {
    targetDepth: 35,
    minRibbonLength: 20,
    minParcelDepth: 15,
    maxParcelDepth: 60,
    maxAngleOff: Math.PI / 6, // 30° max deviation from perpendicular
    ...params,
  };

  const cs = map.cellSize;
  const W = map.width, H = map.height;
  const ox = map.originX, oz = map.originZ;

  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;

  const zoneSet = new Set();
  for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

  // Sort cross streets by contour offset so adjacent ones form corridors
  const sorted = [...crossStreets].sort((a, b) => a.ctOff - b.ctOff);

  // Pre-compute arc-length parameterisations
  const parameterised = sorted.map(st => parameterise(st.points));

  const allRibbons = [];
  const allParcels = [];
  let totalAngleRejects = 0;

  // Track endpoint positions on each cross street for junction sharing.
  // endpointsOnStreet[i] stores the arc-length positions used on sorted[i].
  const endpointsOnStreet = sorted.map(() => []);

  for (let ci = 0; ci < sorted.length - 1; ci++) {
    const leftParam = parameterised[ci];
    const rightParam = parameterised[ci + 1];

    // Use shared endpoints from the previous corridor if available
    const sharedLeft = endpointsOnStreet[ci];

    const { ribbons, parcels, leftEnds, rightEnds, angleRejects } = layCorridor(
      leftParam, rightParam, sharedLeft, p,
      zoneSet, waterMask, roadGrid, cs, W, H, ox, oz,
    );

    allRibbons.push(...ribbons);
    allParcels.push(...parcels);
    totalAngleRejects += angleRejects;

    // Store endpoints for junction sharing with next corridor
    for (const t of leftEnds) {
      if (!endpointsOnStreet[ci].includes(t)) endpointsOnStreet[ci].push(t);
    }
    for (const t of rightEnds) {
      if (!endpointsOnStreet[ci + 1].includes(t)) endpointsOnStreet[ci + 1].push(t);
    }
  }

  // Post-hoc audit
  const audit = auditRibbons(allRibbons, sorted);

  return { ribbons: allRibbons, parcels: allParcels, angleRejects: totalAngleRejects, audit };
}

/**
 * Post-hoc invariant audit on all ribbons and cross streets.
 *
 * Checks:
 * - Ribbon-vs-cross-street crossings (ribbon should not cross any cross street
 *   other than its two bounding ones — but since we don't track which corridor
 *   each ribbon belongs to, we check all cross streets)
 * - Ribbon-vs-ribbon crossings
 * - Minimum separation between parallel ribbons (5m)
 * - Perpendicularity (ribbon angle vs cross street tangent at endpoints)
 */
export function auditRibbons(ribbons, crossStreets) {
  const violations = {
    ribbonCrossesCrossStreet: 0,
    ribbonCrossesRibbon: 0,
    tooClose: 0,           // parallel ribbons within 5m
    total: 0,
    details: [],
  };

  // Collect all cross street segments
  const csSegments = [];
  for (let si = 0; si < crossStreets.length; si++) {
    const pts = crossStreets[si].points;
    for (let i = 1; i < pts.length; i++) {
      csSegments.push({ a: pts[i - 1], b: pts[i], streetIdx: si });
    }
  }

  // Collect all ribbon segments
  const ribbonSegments = [];
  for (let ri = 0; ri < ribbons.length; ri++) {
    const pts = ribbons[ri].points;
    for (let i = 1; i < pts.length; i++) {
      ribbonSegments.push({ a: pts[i - 1], b: pts[i], ribbonIdx: ri });
    }
  }

  // Check ribbon-vs-cross-street crossings
  // A ribbon endpoint touching a cross street is fine (that's a junction).
  // A ribbon segment intersecting a cross street segment in the interior is a violation.
  for (const rSeg of ribbonSegments) {
    for (const csSeg of csSegments) {
      if (segmentsIntersect(rSeg.a, rSeg.b, csSeg.a, csSeg.b)) {
        // Check it's not just an endpoint touch
        if (!isEndpointTouch(rSeg, csSeg)) {
          violations.ribbonCrossesCrossStreet++;
          violations.total++;
          if (violations.details.length < 20) {
            violations.details.push(
              `ribbon ${rSeg.ribbonIdx} crosses cross-street ${csSeg.streetIdx}`
            );
          }
        }
      }
    }
  }

  // Check ribbon-vs-ribbon crossings
  for (let i = 0; i < ribbonSegments.length; i++) {
    for (let j = i + 1; j < ribbonSegments.length; j++) {
      const a = ribbonSegments[i];
      const b = ribbonSegments[j];
      if (a.ribbonIdx === b.ribbonIdx) continue; // same ribbon
      if (segmentsIntersect(a.a, a.b, b.a, b.b)) {
        if (!isEndpointTouch(a, b)) {
          violations.ribbonCrossesRibbon++;
          violations.total++;
          if (violations.details.length < 20) {
            violations.details.push(
              `ribbon ${a.ribbonIdx} crosses ribbon ${b.ribbonIdx}`
            );
          }
        }
      }
    }
  }

  // Check minimum separation (5m) between non-adjacent ribbons
  const MIN_SEP = 5;
  for (let i = 0; i < ribbons.length; i++) {
    for (let j = i + 2; j < ribbons.length; j++) {
      // Check midpoint-to-midpoint distance as a fast proxy
      const midA = midpoint(ribbons[i].points[0], ribbons[i].points[ribbons[i].points.length - 1]);
      const midB = midpoint(ribbons[j].points[0], ribbons[j].points[ribbons[j].points.length - 1]);
      const d = dist(midA, midB);
      if (d < MIN_SEP) {
        violations.tooClose++;
        violations.total++;
        if (violations.details.length < 20) {
          violations.details.push(
            `ribbons ${i} and ${j} within ${d.toFixed(1)}m`
          );
        }
      }
    }
  }

  return violations;
}

// === Geometry utilities ===

/**
 * Check if two line segments (p1-p2) and (p3-p4) intersect in their interiors.
 */
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross2d(p3, p4, p1);
  const d2 = cross2d(p3, p4, p2);
  const d3 = cross2d(p1, p2, p3);
  const d4 = cross2d(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  // Collinear cases — check if any endpoint lies on the other segment
  if (Math.abs(d1) < 1e-9 && onSegment(p3, p4, p1)) return true;
  if (Math.abs(d2) < 1e-9 && onSegment(p3, p4, p2)) return true;
  if (Math.abs(d3) < 1e-9 && onSegment(p1, p2, p3)) return true;
  if (Math.abs(d4) < 1e-9 && onSegment(p1, p2, p4)) return true;

  return false;
}

function cross2d(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function onSegment(p, q, r) {
  return r.x >= Math.min(p.x, q.x) - 1e-9 && r.x <= Math.max(p.x, q.x) + 1e-9 &&
         r.z >= Math.min(p.z, q.z) - 1e-9 && r.z <= Math.max(p.z, q.z) + 1e-9;
}

/**
 * Check if the intersection is just an endpoint of one segment touching
 * the other (which is a valid junction, not a crossing violation).
 */
function isEndpointTouch(seg1, seg2) {
  const EPS = 2; // metres — tolerance for endpoint matching
  return ptNear(seg1.a, seg2.a, EPS) || ptNear(seg1.a, seg2.b, EPS) ||
         ptNear(seg1.b, seg2.a, EPS) || ptNear(seg1.b, seg2.b, EPS);
}

function ptNear(a, b, eps) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.z - b.z) < eps;
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

/**
 * Lay ribbons within a single corridor (between two cross streets).
 */
function layCorridor(
  leftParam, rightParam, sharedLeftEnds, p,
  zoneSet, waterMask, roadGrid, cs, W, H, ox, oz,
) {
  const ribbons = [];
  const parcels = [];
  const leftEnds = [];
  const rightEnds = [];
  let angleRejects = 0;

  const leftLen = leftParam.totalLength;
  const rightLen = rightParam.totalLength;

  // Lay first ribbon at the start of both cross streets
  const startA = pointAtArcLength(leftParam, 0);
  const startB = pointAtArcLength(rightParam, 0);

  if (isValidRibbon(startA, startB, zoneSet, waterMask, roadGrid, cs, W, H, ox, oz)) {
    ribbons.push({ points: [startA, startB], length: dist(startA, startB) });
    leftEnds.push(0);
    rightEnds.push(0);
  }

  // Which side is "determined" (0 = left, 1 = right). Alternates.
  let determinedSide = 0;

  let prevLeftT = 0;
  let prevRightT = 0;

  while (prevLeftT < leftLen - p.minParcelDepth && prevRightT < rightLen - p.minParcelDepth) {
    let newLeftT, newRightT;
    let ptA, ptB;
    let placed = false;

    if (determinedSide === 0) {
      // Advance on left (determined), place on right
      newLeftT = prevLeftT + p.targetDepth;
      if (newLeftT > leftLen) break;

      ptA = pointAtArcLength(leftParam, newLeftT);
      const tanA = tangentAtArcLength(leftParam, newLeftT);

      // Search for a valid placement on the right cross street
      const result = findPlacement(
        ptA, tanA, rightParam, prevRightT, p,
      );

      if (result) {
        newRightT = result.t;
        ptB = result.pt;
        placed = true;
      } else {
        // No valid placement — skip, advance both sides by target depth
        newRightT = Math.min(prevRightT + p.targetDepth, rightLen);
        angleRejects++;
      }
    } else {
      // Advance on right (determined), place on left
      newRightT = prevRightT + p.targetDepth;
      if (newRightT > rightLen) break;

      ptB = pointAtArcLength(rightParam, newRightT);
      const tanB = tangentAtArcLength(rightParam, newRightT);

      // Search for a valid placement on the left cross street
      const result = findPlacement(
        ptB, tanB, leftParam, prevLeftT, p,
      );

      if (result) {
        newLeftT = result.t;
        ptA = result.pt;
        placed = true;
      } else {
        // No valid placement — skip, advance both sides by target depth
        newLeftT = Math.min(prevLeftT + p.targetDepth, leftLen);
        angleRejects++;
      }
    }

    if (!placed) {
      prevLeftT = newLeftT;
      prevRightT = newRightT;
      determinedSide = 1 - determinedSide;
      continue;
    }

    const ribbonLen = dist(ptA, ptB);
    if (ribbonLen < p.minRibbonLength) {
      prevLeftT = newLeftT;
      prevRightT = newRightT;
      determinedSide = 1 - determinedSide;
      continue;
    }

    if (!isValidRibbon(ptA, ptB, zoneSet, waterMask, roadGrid, cs, W, H, ox, oz)) {
      prevLeftT = newLeftT;
      prevRightT = newRightT;
      determinedSide = 1 - determinedSide;
      continue;
    }

    ribbons.push({ points: [ptA, ptB], length: ribbonLen });
    leftEnds.push(newLeftT);
    rightEnds.push(newRightT);

    // Create parcel from previous ribbon to this one
    if (ribbons.length >= 2) {
      const prevRibbon = ribbons[ribbons.length - 2];
      const curRibbon = ribbons[ribbons.length - 1];
      parcels.push({
        topRibbon: prevRibbon,
        bottomRibbon: curRibbon,
        leftSegment: extractSegment(leftParam, prevLeftT, newLeftT),
        rightSegment: extractSegment(rightParam, prevRightT, newRightT),
      });
    }

    prevLeftT = newLeftT;
    prevRightT = newRightT;
    determinedSide = 1 - determinedSide;
  }

  return { ribbons, parcels, leftEnds, rightEnds, angleRejects };
}

/**
 * Search along placementParam for a point that makes the ribbon roughly
 * perpendicular to the cross street tangent at the determined endpoint.
 *
 * Tries positions from minParcelDepth to maxParcelDepth past prevT,
 * in steps of 2m. Picks the candidate closest to targetDepth that
 * passes the angle check at both endpoints.
 *
 * Returns { t, pt } or null if no valid placement found.
 */
function findPlacement(determinedPt, determinedTan, placementParam, prevT, p) {
  const searchMin = prevT + p.minParcelDepth;
  const searchMax = Math.min(prevT + p.maxParcelDepth, placementParam.totalLength);
  if (searchMin > searchMax) return null;

  const searchStep = 2; // metres
  let bestCandidate = null;
  let bestDistFromTarget = Infinity;
  const idealT = prevT + p.targetDepth;

  for (let t = searchMin; t <= searchMax; t += searchStep) {
    const pt = pointAtArcLength(placementParam, t);
    const placementTan = tangentAtArcLength(placementParam, t);

    // Check perpendicularity at the determined endpoint
    if (!isPerpendicular(determinedPt, pt, determinedTan, p.maxAngleOff)) continue;

    // Check perpendicularity at the placement endpoint
    if (!isPerpendicular(pt, determinedPt, placementTan, p.maxAngleOff)) continue;

    const distFromTarget = Math.abs(t - idealT);
    if (distFromTarget < bestDistFromTarget) {
      bestDistFromTarget = distFromTarget;
      bestCandidate = { t, pt };
    }
  }

  return bestCandidate;
}

/**
 * Check if the direction from ptA to ptB is roughly perpendicular
 * to the tangent at ptA. "Perpendicular" means the angle between
 * the ribbon direction and the cross-street normal is within maxAngle.
 */
function isPerpendicular(ptA, ptB, tangentA, maxAngle) {
  const ribbonDx = ptB.x - ptA.x;
  const ribbonDz = ptB.z - ptA.z;
  const ribbonLen = Math.sqrt(ribbonDx * ribbonDx + ribbonDz * ribbonDz);
  if (ribbonLen < 1e-6) return false;

  // Normal to tangent (rotate 90°)
  const normalX = -tangentA.z;
  const normalZ = tangentA.x;

  // Dot product of ribbon direction with normal
  const dot = (ribbonDx / ribbonLen) * normalX + (ribbonDz / ribbonLen) * normalZ;

  // angle between ribbon and normal — use abs(dot) since ribbon can go either way
  const angle = Math.acos(Math.min(1, Math.abs(dot)));
  return angle <= maxAngle;
}

/**
 * Check if a ribbon line is valid (doesn't cross water or non-bounding roads).
 */
function isValidRibbon(ptA, ptB, zoneSet, waterMask, roadGrid, cs, W, H, ox, oz) {
  const steps = Math.ceil(dist(ptA, ptB) / (cs * 0.5));
  if (steps === 0) return false;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wx = ptA.x + (ptB.x - ptA.x) * t;
    const wz = ptA.z + (ptB.z - ptA.z) * t;
    const gx = Math.round((wx - ox) / cs);
    const gz = Math.round((wz - oz) / cs);

    if (gx < 0 || gx >= W || gz < 0 || gz >= H) return false;
    if (waterMask && waterMask.get(gx, gz) > 0) return false;
  }

  return true;
}

// === Polyline parameterisation utilities ===

function parameterise(points) {
  const cumLen = [0];
  for (let i = 1; i < points.length; i++) {
    cumLen.push(cumLen[i - 1] + dist(points[i - 1], points[i]));
  }
  return { points, cumLen, totalLength: cumLen[cumLen.length - 1] };
}

function pointAtArcLength(param, t) {
  const { points, cumLen, totalLength } = param;
  if (t <= 0) return { x: points[0].x, z: points[0].z };
  if (t >= totalLength) return { x: points[points.length - 1].x, z: points[points.length - 1].z };

  // Binary search for the segment containing t
  let lo = 0, hi = cumLen.length - 1;
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

function tangentAtArcLength(param, t) {
  const { points, cumLen, totalLength } = param;
  // Clamp t and find the segment
  t = clamp(t, 0, totalLength);

  let lo = 0, hi = cumLen.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] <= t) lo = mid;
    else hi = mid;
  }

  const dx = points[hi].x - points[lo].x;
  const dz = points[hi].z - points[lo].z;
  const segLen = Math.sqrt(dx * dx + dz * dz);
  if (segLen < 1e-9) return { x: 1, z: 0 }; // degenerate — arbitrary direction
  return { x: dx / segLen, z: dz / segLen };
}

function extractSegment(param, tStart, tEnd) {
  const pts = [];
  pts.push(pointAtArcLength(param, tStart));

  // Add intermediate vertices that fall between tStart and tEnd
  for (let i = 0; i < param.cumLen.length; i++) {
    if (param.cumLen[i] > tStart + 1e-6 && param.cumLen[i] < tEnd - 1e-6) {
      pts.push({ x: param.points[i].x, z: param.points[i].z });
    }
  }

  pts.push(pointAtArcLength(param, tEnd));
  return pts;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
