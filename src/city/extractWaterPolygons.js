/**
 * Extract smooth water boundary polygons from the coarse water mask grid.
 *
 * Uses marching squares to trace the water/land boundary, then simplifies
 * and smooths the resulting polylines into clean polygon paths.
 *
 * Output: array of closed polylines (arrays of {x, z} in world coords),
 * each representing a water body boundary (coastline, river bank, lake shore).
 */

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @returns {Array<Array<{x: number, z: number}>>} array of closed polylines
 */
export function extractWaterPolygons(cityLayers) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  if (!params || !elevation) return [];

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;

  // Build a dilated water grid: expand water cells by 1 to fill diagonal gaps
  const waterGrid = new Uint8Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      let isW = false;
      if (waterMask && waterMask.get(gx, gz) > 0) isW = true;
      if (elevation.get(gx, gz) < seaLevel) isW = true;
      if (isW) waterGrid[gz * w + gx] = 1;
    }
  }

  // Dilate by 1 cell to connect diagonal water cells
  const dilated = new Uint8Array(waterGrid);
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      if (waterGrid[gz * w + gx]) continue;
      // If surrounded by 3+ water neighbors (including diagonals), fill
      let wn = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          if (waterGrid[(gz + dz) * w + (gx + dx)]) wn++;
        }
      }
      if (wn >= 3) dilated[gz * w + gx] = 1;
    }
  }

  const isWater = (gx, gz) => {
    if (gx < 0 || gx >= w || gz < 0 || gz >= h) return true;
    return dilated[gz * w + gx] === 1;
  };

  // Marching squares on the dilated grid
  const edgeSegments = [];

  for (let gz = 0; gz < h - 1; gz++) {
    for (let gx = 0; gx < w - 1; gx++) {
      const tl = isWater(gx, gz) ? 1 : 0;
      const tr = isWater(gx + 1, gz) ? 1 : 0;
      const br = isWater(gx + 1, gz + 1) ? 1 : 0;
      const bl = isWater(gx, gz + 1) ? 1 : 0;
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;

      if (code === 0 || code === 15) continue;

      const x0 = gx * cs, z0 = gz * cs;
      const segs = marchingSquaresSegments(code, x0, z0, cs);
      for (const seg of segs) {
        edgeSegments.push(seg);
      }
    }
  }

  if (edgeSegments.length === 0) return [];

  // Chain segments into polylines
  const polylines = chainSegments(edgeSegments, cs * 1.0);

  // Simplify and smooth each polyline
  const result = [];
  for (const poly of polylines) {
    if (poly.length < 4) continue;
    const simplified = douglasPeucker(poly, cs * 0.5);
    if (simplified.length < 3) continue;
    const smoothed = smoothPolyline(simplified, 2);
    result.push(smoothed);
  }

  return result;
}

/**
 * Marching squares lookup: returns line segments for a given cell configuration.
 * code = 4-bit (TL TR BR BL), 1=water, 0=land
 */
function marchingSquaresSegments(code, x, z, cs) {
  const half = cs / 2;
  // Edge midpoints: top, right, bottom, left
  const T = { x: x + half, z: z };
  const R = { x: x + cs, z: z + half };
  const B = { x: x + half, z: z + cs };
  const L = { x: x, z: z + half };

  // Standard marching squares lookup (water = inside)
  switch (code) {
    case 1: return [[L, B]];           // BL only
    case 2: return [[B, R]];           // BR only
    case 3: return [[L, R]];           // bottom row
    case 4: return [[T, R]];           // TR only
    case 5: return [[T, R], [L, B]];   // TR + BL (saddle)
    case 6: return [[T, B]];           // right column
    case 7: return [[T, L]];           // all except TL
    case 8: return [[T, L]];           // TL only
    case 9: return [[T, B]];           // left column
    case 10: return [[T, L], [B, R]];  // TL + BR (saddle)
    case 11: return [[T, R]];          // all except TR
    case 12: return [[L, R]];          // top row
    case 13: return [[B, R]];          // all except BR
    case 14: return [[L, B]];          // all except BL
    default: return [];
  }
}

/**
 * Chain loose line segments into connected polylines.
 * Marching squares segments share exact endpoints at grid midpoints,
 * so we use exact coordinate matching via string keys.
 */
function chainSegments(segments, snapDist) {
  // Build adjacency: for each endpoint coordinate, list segments touching it
  const endpointMap = new Map(); // "x,z" -> [{segIdx, end: 0|1}]

  function ptKey(p) {
    // Round to avoid floating point mismatch (coords are multiples of cs/2)
    return `${Math.round(p.x * 10)},${Math.round(p.z * 10)}`;
  }

  for (let i = 0; i < segments.length; i++) {
    for (let end = 0; end < 2; end++) {
      const key = ptKey(segments[i][end]);
      if (!endpointMap.has(key)) endpointMap.set(key, []);
      endpointMap.get(key).push({ segIdx: i, end });
    }
  }

  const used = new Uint8Array(segments.length);
  const polylines = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;

    const chain = [segments[i][0], segments[i][1]];

    // Extend forward from end
    let extending = true;
    while (extending) {
      extending = false;
      const tailKey = ptKey(chain[chain.length - 1]);
      const entries = endpointMap.get(tailKey);
      if (!entries) continue;
      for (const entry of entries) {
        if (used[entry.segIdx]) continue;
        used[entry.segIdx] = 1;
        const seg = segments[entry.segIdx];
        chain.push(entry.end === 0 ? seg[1] : seg[0]);
        extending = true;
        break;
      }
    }

    // Extend backward from start
    extending = true;
    while (extending) {
      extending = false;
      const headKey = ptKey(chain[0]);
      const entries = endpointMap.get(headKey);
      if (!entries) continue;
      for (const entry of entries) {
        if (used[entry.segIdx]) continue;
        used[entry.segIdx] = 1;
        const seg = segments[entry.segIdx];
        chain.unshift(entry.end === 0 ? seg[1] : seg[0]);
        extending = true;
        break;
      }
    }

    // Close loop if endpoints match
    if (chain.length > 3 && ptKey(chain[0]) === ptKey(chain[chain.length - 1])) {
      // Already closed
    } else if (chain.length > 3) {
      const d2 = (chain[0].x - chain[chain.length - 1].x) ** 2 +
                 (chain[0].z - chain[chain.length - 1].z) ** 2;
      if (d2 < snapDist * snapDist * 4) {
        chain.push({ ...chain[0] });
      }
    }

    polylines.push(chain);
  }

  return polylines;
}

/**
 * Douglas-Peucker line simplification.
 */
function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToLineDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function pointToLineDist(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  if (len2 < 1e-10) return Math.sqrt((p.x - a.x) ** 2 + (p.z - a.z) ** 2);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2));
  const projX = a.x + t * abx;
  const projZ = a.z + t * abz;
  return Math.sqrt((p.x - projX) ** 2 + (p.z - projZ) ** 2);
}

/**
 * Chaikin corner-cutting smoothing.
 */
function smoothPolyline(points, iterations) {
  let pts = points;
  for (let iter = 0; iter < iterations; iter++) {
    const smoothed = [pts[0]]; // keep first point
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      smoothed.push({
        x: a.x * 0.75 + b.x * 0.25,
        z: a.z * 0.75 + b.z * 0.25,
      });
      smoothed.push({
        x: a.x * 0.25 + b.x * 0.75,
        z: a.z * 0.25 + b.z * 0.75,
      });
    }
    smoothed.push(pts[pts.length - 1]); // keep last point
    pts = smoothed;
  }
  return pts;
}
