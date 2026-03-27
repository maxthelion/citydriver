/**
 * Phase 2: Incremental Parallel Streets
 *
 * For each pair of adjacent construction lines (a corridor), lay parallel
 * streets one at a time, creating parcels as we go.
 *
 * Construction lines are curved polylines. Streets connect corresponding
 * fractional positions on adjacent lines, so they naturally follow the
 * local contour direction — varying in angle across the zone.
 *
 * Key principle: adapt, don't reject. When a street hits an obstacle,
 * truncate it there. Only skip if the truncated version is too short.
 */

export function buildParallelStreets(constructionLines, zone, map, gradDir, contourDir, zoneSet, params) {
  if (constructionLines.length < 2) return { streets: [], parcels: [] };

  const { parcelDepth, minStreetLength, minParcelDepth, angleTolerance } = params;
  const cs = map.cellSize;
  const W = map.width, H = map.height;
  const ox = map.originX, oz = map.originZ;
  const waterMask = map.getLayer('waterMask');
  const roadGrid = map.getLayer('roadGrid');

  const streets = [];
  const parcels = [];

  // Junction registry: when a corridor places a street endpoint on a construction
  // line, it registers the point. The next corridor sharing that line snaps to
  // these registered points instead of creating near-duplicates.
  const SNAP_DIST = 10;
  const junctionsByLine = new Map();
  for (let i = 0; i < constructionLines.length; i++) {
    junctionsByLine.set(i, []);
  }

  // Process each corridor (pair of adjacent construction lines)
  for (let ci = 0; ci < constructionLines.length - 1; ci++) {
    const lineA = constructionLines[ci];
    const lineB = constructionLines[ci + 1];

    const avgLen = (lineA.length + lineB.length) / 2;
    if (avgLen < parcelDepth) continue;

    const fracStep = parcelDepth / avgLen;
    let prevStreet = null;

    for (let frac = 0; frac <= 1.0 + 1e-6; frac += fracStep) {
      const f = Math.min(frac, 1.0);
      let pA = pointAtFraction(lineA, f);
      let pB = pointAtFraction(lineB, f);
      if (!pA || !pB) continue;

      // Snap to existing junctions on shared construction lines
      pA = snapToJunction(pA, junctionsByLine.get(ci), SNAP_DIST);
      pB = snapToJunction(pB, junctionsByLine.get(ci + 1), SNAP_DIST);

      // Truncate street at obstacles (adapt, don't reject)
      const truncated = truncateStreet(
        pA, pB, zoneSet, waterMask, roadGrid,
        cs, W, H, ox, oz,
      );
      if (!truncated) continue;

      // Also truncate at existing street crossings to prevent unresolved crossings
      const { start, end } = truncateAtExistingStreets(truncated, streets);
      const len = Math.sqrt((end.x - start.x) ** 2 + (end.z - start.z) ** 2);
      if (len < minStreetLength) continue;

      // Local angle validation: street should be roughly perpendicular
      // to the construction lines at this point. Get local tangent.
      const tangA = tangentAtFraction(lineA, f);
      const tangB = tangentAtFraction(lineB, f);
      const avgTangX = tangA.x + tangB.x;
      const avgTangZ = tangA.z + tangB.z;
      const tangMag = Math.sqrt(avgTangX * avgTangX + avgTangZ * avgTangZ);
      if (tangMag > 1e-6) {
        const streetDx = end.x - start.x;
        const streetDz = end.z - start.z;
        const streetMag = Math.sqrt(streetDx * streetDx + streetDz * streetDz);
        // Dot product of street direction and construction line tangent
        // Should be close to 0 (perpendicular)
        const dot = Math.abs(streetDx * avgTangX + streetDz * avgTangZ) / (streetMag * tangMag);
        if (dot > Math.sin(angleTolerance)) continue; // too parallel to construction lines
      }

      const street = { start, end, length: len };
      streets.push(street);

      // Register the actual endpoints as junctions on their construction lines.
      // Line A uses start, line B uses end. Future corridors reuse these.
      registerJunction(start, junctionsByLine.get(ci));
      registerJunction(end, junctionsByLine.get(ci + 1));

      if (prevStreet) {
        const parcel = createParcel(prevStreet, street, minParcelDepth);
        if (parcel) parcels.push(parcel);
      }

      prevStreet = street;
    }
  }

  return { streets, parcels };
}

/**
 * Get a point at fractional position (0..1) along a polyline,
 * interpolated by arc length.
 */
function pointAtFraction(line, frac) {
  const pts = line.points;
  if (!pts || pts.length === 0) return null;
  if (pts.length === 1 || frac <= 0) return { x: pts[0].x, z: pts[0].z };
  if (frac >= 1) return { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z };

  const targetS = frac * line.length;
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (s + segLen >= targetS - 1e-6) {
      const t = segLen > 1e-6 ? Math.min((targetS - s) / segLen, 1) : 0;
      return {
        x: pts[i - 1].x + dx * t,
        z: pts[i - 1].z + dz * t,
      };
    }
    s += segLen;
  }
  return { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z };
}

/**
 * Get the tangent direction at a fractional position along a polyline.
 */
function tangentAtFraction(line, frac) {
  const pts = line.points;
  if (!pts || pts.length < 2) return { x: 1, z: 0 };

  const targetS = frac * line.length;
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (s + segLen >= targetS - 1e-6 || i === pts.length - 1) {
      const mag = segLen > 1e-6 ? segLen : 1;
      return { x: dx / mag, z: dz / mag };
    }
    s += segLen;
  }
  const last = pts.length - 1;
  const dx = pts[last].x - pts[last - 1].x;
  const dz = pts[last].z - pts[last - 1].z;
  const mag = Math.sqrt(dx * dx + dz * dz) || 1;
  return { x: dx / mag, z: dz / mag };
}

/**
 * Walk from pA toward pB, truncating at the first obstacle.
 */
function truncateStreet(pA, pB, zoneSet, waterMask, roadGrid, cs, W, H, ox, oz) {
  const dx = pB.x - pA.x;
  const dz = pB.z - pA.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1) return null;

  const step = cs * 0.5;
  const nSteps = Math.ceil(len / step);

  let lastValidT = 0;

  for (let s = 0; s <= nSteps; s++) {
    const t = s / nSteps;
    const wx = pA.x + dx * t;
    const wz = pA.z + dz * t;
    const cgx = Math.round((wx - ox) / cs);
    const cgz = Math.round((wz - oz) / cs);

    if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) break;

    const isWater = waterMask && waterMask.get(cgx, cgz) > 0;
    if (isWater) break;

    const isRoad = roadGrid && roadGrid.get(cgx, cgz) > 0;
    if (isRoad && s > 0 && s < nSteps) {
      lastValidT = t;
      break;
    }

    const inZone = zoneSet.has(cgz * W + cgx);
    if (!inZone && !isRoad) break;

    lastValidT = t;
  }

  if (lastValidT < 0.01) return null;

  return {
    start: { x: pA.x, z: pA.z },
    end: { x: pA.x + dx * lastValidT, z: pA.z + dz * lastValidT },
  };
}

/**
 * If the proposed street crosses any existing street, truncate it
 * at the first crossing point to form a T-junction instead.
 */
function truncateAtExistingStreets(proposed, existingStreets) {
  const { start, end } = proposed;
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let bestT = 1.0;

  for (const existing of existingStreets) {
    const ex = existing.end.x - existing.start.x;
    const ez = existing.end.z - existing.start.z;

    const denom = dx * ez - dz * ex;
    if (Math.abs(denom) < 1e-10) continue; // parallel

    const ox = existing.start.x - start.x;
    const oz = existing.start.z - start.z;
    const t = (ox * ez - oz * ex) / denom;
    const u = (ox * dz - oz * dx) / denom;

    // Intersection in the interior of both segments (not at endpoints)
    if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) {
      if (t < bestT) bestT = t;
    }
  }

  if (bestT < 1.0) {
    return {
      start,
      end: { x: start.x + dx * bestT, z: start.z + dz * bestT },
    };
  }
  return proposed;
}

function createParcel(prevStreet, curStreet, minParcelDepth) {
  const corners = [
    { x: prevStreet.start.x, z: prevStreet.start.z },
    { x: prevStreet.end.x, z: prevStreet.end.z },
    { x: curStreet.end.x, z: curStreet.end.z },
    { x: curStreet.start.x, z: curStreet.start.z },
  ];

  const widthTop = dist(corners[0], corners[1]);
  const widthBot = dist(corners[3], corners[2]);
  const depthLeft = dist(corners[0], corners[3]);
  const depthRight = dist(corners[1], corners[2]);

  const width = (widthTop + widthBot) / 2;
  const depth = (depthLeft + depthRight) / 2;
  const shortSide = Math.min(width, depth);
  const longSide = Math.max(width, depth);
  const ratio = longSide > 0 ? shortSide / longSide : 0;

  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += corners[i].x * corners[j].z - corners[j].x * corners[i].z;
  }
  area = Math.abs(area) / 2;

  if (shortSide < minParcelDepth) return null;
  if (ratio < 0.1) return null;

  return { corners, width, depth, shortSide, longSide, ratio, area };
}

function dist(a, b) {
  return Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
}

/**
 * Snap a point to the nearest existing junction if within snapDist.
 * Returns the existing junction (same object) or the original point.
 */
function snapToJunction(point, junctions, snapDist) {
  let bestDist = snapDist;
  let best = null;
  for (const j of junctions) {
    const d = dist(point, j);
    if (d < bestDist) {
      bestDist = d;
      best = j;
    }
  }
  return best || point;
}

/**
 * Find the fractional arc-length position of a point on a polyline
 * (nearest point projection).
 */
function nearestFraction(line, point) {
  const pts = line.points;
  if (!pts || pts.length < 2) return 0;

  let bestDistSq = Infinity;
  let bestS = 0;
  let s = 0;

  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    const segLen = Math.sqrt(dx * dx + dz * dz);

    // Project point onto this segment
    if (segLen > 1e-6) {
      const t = Math.max(0, Math.min(1,
        ((point.x - pts[i - 1].x) * dx + (point.z - pts[i - 1].z) * dz) / (segLen * segLen)));
      const px = pts[i - 1].x + dx * t;
      const pz = pts[i - 1].z + dz * t;
      const dSq = (point.x - px) ** 2 + (point.z - pz) ** 2;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestS = s + segLen * t;
      }
    }

    s += segLen;
  }

  return line.length > 0 ? bestS / line.length : 0;
}

/**
 * Register a junction point on a construction line, avoiding duplicates.
 */
function registerJunction(point, junctions) {
  for (const j of junctions) {
    if (dist(point, j) < 1) return;
  }
  junctions.push(point);
}
