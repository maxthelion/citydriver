/**
 * Phase 1: Construction Lines
 *
 * Trace lines through the zone following the LOCAL gradient field,
 * not a single average direction. Each line curves with the terrain,
 * producing organic street patterns like real hillside towns.
 *
 * Lines are spaced at constructionSpacing intervals along the contour
 * axis and must span the zone. Short stubs are discarded.
 */

/**
 * Build a smoothed per-cell gradient field from elevation within the zone.
 * Returns a lookup that gives the local gradient vector at any grid cell.
 */
export function buildGradientField(zone, map, zoneSet) {
  const cs = map.cellSize;
  const W = map.width, H = map.height;
  const elev = map.getLayer('elevation');
  if (!elev) return null;

  // Raw per-cell gradient
  const rawX = new Float32Array(W * H);
  const rawZ = new Float32Array(W * H);

  for (const c of zone.cells) {
    const { gx, gz } = c;
    const eC = elev.get(gx, gz);
    const eE = (gx + 1 < W) ? elev.get(gx + 1, gz) : eC;
    const eW = (gx - 1 >= 0) ? elev.get(gx - 1, gz) : eC;
    const eS = (gz + 1 < H) ? elev.get(gx, gz + 1) : eC;
    const eN = (gz - 1 >= 0) ? elev.get(gx, gz - 1) : eC;

    const idx = gz * W + gx;
    rawX[idx] = (eE - eW) / (2 * cs);
    rawZ[idx] = (eS - eN) / (2 * cs);
  }

  // Smooth with box blur (radius ~3 cells) to avoid noisy direction changes
  const R = 3;
  const smoothX = new Float32Array(W * H);
  const smoothZ = new Float32Array(W * H);

  for (const c of zone.cells) {
    const { gx, gz } = c;
    let sumX = 0, sumZ = 0, count = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = gx + dx, nz = gz + dz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        if (!zoneSet.has(nz * W + nx)) continue;
        sumX += rawX[nz * W + nx];
        sumZ += rawZ[nz * W + nx];
        count++;
      }
    }
    const idx = gz * W + gx;
    smoothX[idx] = count > 0 ? sumX / count : 0;
    smoothZ[idx] = count > 0 ? sumZ / count : 0;
  }

  return {
    getGrad(gx, gz) {
      if (gx < 0 || gx >= W || gz < 0 || gz >= H) return { x: 0, z: 0 };
      const idx = gz * W + gx;
      return { x: smoothX[idx], z: smoothZ[idx] };
    },
  };
}

export function buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, params, gradField) {
  const { constructionSpacing, minStreetLength } = params;
  const cs = map.cellSize;
  const W = map.width, H = map.height;
  const ox = map.originX, oz = map.originZ;
  const waterMask = map.getLayer('waterMask');

  const zoneCx = ox + zone.centroidGx * cs;
  const zoneCz = oz + zone.centroidGz * cs;

  // Project zone cells onto contour axis for sweep extent
  let minCt = Infinity, maxCt = -Infinity;
  for (const c of zone.cells) {
    const wx = ox + c.gx * cs;
    const wz = oz + c.gz * cs;
    const projCt = (wx - zoneCx) * contourDir.x + (wz - zoneCz) * contourDir.z;
    if (projCt < minCt) minCt = projCt;
    if (projCt > maxCt) maxCt = projCt;
  }

  // Sweep offsets along contour axis (same spacing logic as before)
  const offsets = [];
  const firstCt = Math.ceil(minCt / constructionSpacing) * constructionSpacing;
  for (let ct = firstCt; ct <= maxCt + 1e-6; ct += constructionSpacing) {
    offsets.push(ct);
  }
  if (offsets.length === 0 || offsets[0] - minCt > constructionSpacing * 0.3) {
    offsets.unshift(minCt);
  }
  if (offsets.length === 0 || maxCt - offsets[offsets.length - 1] > constructionSpacing * 0.3) {
    offsets.push(maxCt);
  }
  offsets.sort((a, b) => a - b);

  const filtered = [offsets[0]];
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] - filtered[filtered.length - 1] >= constructionSpacing * 0.3) {
      filtered.push(offsets[i]);
    }
  }

  // Trace each construction line
  const lines = [];
  for (const ctOff of filtered) {
    const seedX = zoneCx + contourDir.x * ctOff;
    const seedZ = zoneCz + contourDir.z * ctOff;

    const line = traceFromSeed(
      seedX, seedZ, ctOff,
      gradField, gradDir, zoneSet, waterMask,
      cs, W, H, ox, oz, minStreetLength,
    );
    if (line) lines.push(line);
  }

  lines.sort((a, b) => a.ctOff - b.ctOff);

  // Prune converging lines: if two adjacent lines approach within minSeparation
  // at any point along their length, remove the shorter one.
  const minSeparation = 5;
  const pruned = pruneConvergingLines(lines, minSeparation);

  return pruned;
}

/**
 * Remove construction lines that converge within minSeparation of a neighbour.
 * Samples points along adjacent lines and checks minimum distance.
 * When two lines converge, the shorter one is removed.
 */
function pruneConvergingLines(lines, minSeparation) {
  if (lines.length < 2) return lines;

  const keep = new Array(lines.length).fill(true);

  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (!keep[j]) continue;
      if (linesConverge(lines[i], lines[j], minSeparation)) {
        // Remove the shorter line
        if (lines[i].length < lines[j].length) {
          keep[i] = false;
          break;
        } else {
          keep[j] = false;
        }
      }
    }
  }

  return lines.filter((_, i) => keep[i]);
}

/**
 * Check if two polylines come within minDist at any sampled point.
 */
function linesConverge(lineA, lineB, minDist) {
  const ptsA = lineA.points;
  const ptsB = lineB.points;
  if (!ptsA || !ptsB) return false;

  // Sample ~20 points along each line
  const nSamples = 20;
  const stepA = Math.max(1, Math.floor(ptsA.length / nSamples));
  const stepB = Math.max(1, Math.floor(ptsB.length / nSamples));
  const minDistSq = minDist * minDist;

  for (let ia = 0; ia < ptsA.length; ia += stepA) {
    const pa = ptsA[ia];
    for (let ib = 0; ib < ptsB.length; ib += stepB) {
      const pb = ptsB[ib];
      const dx = pa.x - pb.x;
      const dz = pa.z - pb.z;
      if (dx * dx + dz * dz < minDistSq) return true;
    }
  }
  return false;
}

/**
 * Find an in-zone seed near the target point, then trace the gradient
 * field in both directions to produce a curved construction line.
 */
function traceFromSeed(
  targetX, targetZ, ctOff,
  gradField, fallbackDir, zoneSet, waterMask,
  cs, W, H, ox, oz, minStreetLength,
) {
  // Scan along average gradient from seed to find in-zone starting point
  const step = cs * 0.5;
  const maxScan = 500;
  let seedX = null, seedZ = null;

  for (let si = 0; si <= maxScan; si++) {
    // Alternate scanning forward and backward from the target
    for (const sign of (si === 0 ? [1] : [1, -1])) {
      const wx = targetX + fallbackDir.x * si * step * sign;
      const wz = targetZ + fallbackDir.z * si * step * sign;
      const cgx = Math.round((wx - ox) / cs);
      const cgz = Math.round((wz - oz) / cs);
      if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) continue;
      if (zoneSet.has(cgz * W + cgx)) {
        const isWater = waterMask && waterMask.get(cgx, cgz) > 0;
        if (!isWater) {
          seedX = wx;
          seedZ = wz;
          break;
        }
      }
    }
    if (seedX !== null) break;
  }

  if (seedX === null) return null;

  // Trace forward (in gradient direction)
  const forward = traceDirection(
    seedX, seedZ, 1, gradField, fallbackDir,
    zoneSet, waterMask, cs, W, H, ox, oz, step,
  );

  // Trace backward (against gradient)
  const backward = traceDirection(
    seedX, seedZ, -1, gradField, fallbackDir,
    zoneSet, waterMask, cs, W, H, ox, oz, step,
  );

  // Combine: backward (reversed, skip seed duplicate) + forward
  backward.reverse();
  const points = backward.length > 1
    ? [...backward.slice(0, -1), ...forward]
    : forward;

  if (points.length < 2) return null;

  // Compute arc length
  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    totalLen += Math.sqrt(
      (points[i].x - points[i - 1].x) ** 2 +
      (points[i].z - points[i - 1].z) ** 2,
    );
  }

  if (totalLen < minStreetLength) return null;

  return {
    ctOff,
    points,
    start: points[0],
    end: points[points.length - 1],
    length: totalLen,
  };
}

/**
 * Trace from a point blending initial direction with local gradient.
 * Near the start, the initial (straight) direction dominates.
 * Further out, the local gradient takes over. This produces lines
 * that go broadly straight but gently curve with the terrain.
 */
function traceDirection(
  startX, startZ, sign, gradField, fallbackDir,
  zoneSet, waterMask, cs, W, H, ox, oz, step,
) {
  const maxSteps = 2000;
  const blendDistance = 120; // metres: full gradient influence after this distance
  const points = [];
  let wx = startX, wz = startZ;
  let distFromStart = 0;
  const initDirX = fallbackDir.x * sign;
  const initDirZ = fallbackDir.z * sign;
  let lastDirX = initDirX;
  let lastDirZ = initDirZ;

  for (let i = 0; i < maxSteps; i++) {
    const cgx = Math.round((wx - ox) / cs);
    const cgz = Math.round((wz - oz) / cs);
    if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) break;
    if (!zoneSet.has(cgz * W + cgx)) break;
    if (waterMask && waterMask.get(cgx, cgz) > 0) break;

    points.push({ x: wx, z: wz });

    // Blend initial direction with local gradient based on distance
    let dirX, dirZ;
    if (gradField) {
      const grad = gradField.getGrad(cgx, cgz);
      const mag = Math.sqrt(grad.x * grad.x + grad.z * grad.z);
      if (mag > 1e-8) {
        const gradDirX = (grad.x / mag) * sign;
        const gradDirZ = (grad.z / mag) * sign;

        // Blend: 1 at seed/interior (pure gradient), 0 at tips/edges (pure straight).
        // Construction lines start straight at zone edges (anchor roads) and
        // curve to follow terrain in the interior. Since we trace outward from
        // the seed (interior) toward the edges, blend decreases with distance.
        const blend = Math.max(0, 1 - distFromStart / blendDistance);
        const rawX = (1 - blend) * initDirX + blend * gradDirX;
        const rawZ = (1 - blend) * initDirZ + blend * gradDirZ;
        const rawMag = Math.sqrt(rawX * rawX + rawZ * rawZ);
        if (rawMag > 1e-8) {
          dirX = rawX / rawMag;
          dirZ = rawZ / rawMag;
        } else {
          dirX = initDirX;
          dirZ = initDirZ;
        }

        // Safety: don't drift > 90° from initial direction
        const initDot = dirX * initDirX + dirZ * initDirZ;
        if (initDot < 0) break;
      } else {
        dirX = lastDirX;
        dirZ = lastDirZ;
      }
    } else {
      dirX = lastDirX;
      dirZ = lastDirZ;
    }

    lastDirX = dirX;
    lastDirZ = dirZ;
    wx += dirX * step;
    wz += dirZ * step;
    distFromStart += step;
  }

  return points;
}
