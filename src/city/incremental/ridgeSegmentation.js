/**
 * Ridge/valley terrain face segmentation.
 *
 * Subdivides a development zone into terrain faces by detecting where the
 * smoothed slope direction changes significantly between neighbouring cells.
 * Uses gradient-direction clustering rather than raw curvature thresholding,
 * producing cleaner, non-grid-aligned face boundaries.
 *
 * Algorithm:
 * 1. Smooth elevation with large Gaussian blur (radius 6) to remove noise
 * 2. Compute gradient direction at each zone cell from smoothed elevation
 * 3. Region-grow faces: seed from unvisited cells, expand to neighbours
 *    whose gradient direction is within tolerance of the face's running average
 * 4. Merge small faces, compute per-face gradient
 *
 * Returns face objects shaped like zones (cells, centroidGx/Gz, avgSlope, slopeDir).
 * Returns [zone] unchanged if flat or uniform slope.
 */

const MIN_FACE_CELLS = 400;
const MAX_FACES = 5;
const DIR_TOLERANCE = Math.PI / 5; // 36° — faces split where direction differs by more

/**
 * @param {object} zone - Development zone with cells array
 * @param {object} map  - FeatureMap with elevation layer
 * @returns {{ faces: object[], ridgeCells: Set<number> }}
 */
export function segmentByRidges(zone, map) {
  const elev = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
  if (!elev || !zone.cells || zone.cells.length < MIN_FACE_CELLS * 2) {
    return { faces: [zone], ridgeCells: new Set() };
  }

  if (zone.avgSlope !== undefined && zone.avgSlope < 0.05) {
    return { faces: [zone], ridgeCells: new Set() };
  }

  const W = map.width;
  const H = map.height;

  // Build zone cell set and bounding box
  const zoneSet = new Set();
  let bbMinGx = W, bbMaxGx = 0, bbMinGz = H, bbMaxGz = 0;
  for (const c of zone.cells) {
    zoneSet.add(c.gz * W + c.gx);
    if (c.gx < bbMinGx) bbMinGx = c.gx;
    if (c.gx > bbMaxGx) bbMaxGx = c.gx;
    if (c.gz < bbMinGz) bbMinGz = c.gz;
    if (c.gz > bbMaxGz) bbMaxGz = c.gz;
  }

  const bw = bbMaxGx - bbMinGx + 1;
  const bh = bbMaxGz - bbMinGz + 1;

  // Step 1: Smooth elevation (Gaussian blur, radius 6 — larger to suppress noise)
  const smoothed = gaussianBlur(elev, bbMinGx, bbMinGz, bw, bh, W, H, 6);

  // Step 2: Compute gradient direction at each zone cell
  const gradDirMap = new Map();  // key -> angle in radians (-PI..PI)
  const gradMagMap = new Map();  // key -> gradient magnitude
  const cellByKey = new Map();

  for (const c of zone.cells) {
    cellByKey.set(c.gz * W + c.gx, c);
    const lx = c.gx - bbMinGx;
    const lz = c.gz - bbMinGz;
    if (lx < 1 || lx >= bw - 1 || lz < 1 || lz >= bh - 1) continue;

    const dx = (smoothed[lz * bw + (lx + 1)] - smoothed[lz * bw + (lx - 1)]) / 2;
    const dz = (smoothed[(lz + 1) * bw + lx] - smoothed[(lz - 1) * bw + lx]) / 2;
    const mag = Math.sqrt(dx * dx + dz * dz);
    const key = c.gz * W + c.gx;

    if (mag > 0.005) {
      gradDirMap.set(key, Math.atan2(dz, dx));
      gradMagMap.set(key, mag);
    }
  }

  // Step 3: Region-grow faces by gradient direction similarity
  // Sort cells by gradient magnitude (descending) so we seed from steepest areas
  const sortedCells = zone.cells
    .filter(c => gradDirMap.has(c.gz * W + c.gx))
    .sort((a, b) => (gradMagMap.get(b.gz * W + b.gx) || 0) - (gradMagMap.get(a.gz * W + a.gx) || 0));

  const cellToFace = new Map();
  const faceGroups = [];
  const N8 = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];

  for (const seedCell of sortedCells) {
    const seedKey = seedCell.gz * W + seedCell.gx;
    if (cellToFace.has(seedKey)) continue;

    const seedDir = gradDirMap.get(seedKey);
    const face = { cells: [seedCell], sumDx: Math.cos(seedDir), sumDz: Math.sin(seedDir) };
    cellToFace.set(seedKey, faceGroups.length);

    // BFS expand to neighbours with similar gradient direction
    const queue = [seedKey];
    let qi = 0;
    while (qi < queue.length) {
      const k = queue[qi++];
      const kgz = Math.floor(k / W);
      const kgx = k % W;

      for (const [ndx, ndz] of N8) {
        const nk = (kgz + ndz) * W + (kgx + ndx);
        if (cellToFace.has(nk)) continue;
        if (!zoneSet.has(nk)) continue;

        const nDir = gradDirMap.get(nk);
        if (nDir === undefined) continue;

        // Compare with face's running average direction
        const faceDir = Math.atan2(face.sumDz, face.sumDx);
        const diff = angleDiff(nDir, faceDir);
        if (diff <= DIR_TOLERANCE) {
          const nCell = cellByKey.get(nk);
          if (nCell) {
            face.cells.push(nCell);
            face.sumDx += Math.cos(nDir);
            face.sumDz += Math.sin(nDir);
            cellToFace.set(nk, faceGroups.length);
            queue.push(nk);
          }
        }
      }
    }

    faceGroups.push(face);
  }

  // Assign any unvisited cells (flat / edge cells without gradient) to nearest face
  for (const c of zone.cells) {
    const key = c.gz * W + c.gx;
    if (cellToFace.has(key)) continue;
    for (const [ndx, ndz] of N8) {
      const nk = (c.gz + ndz) * W + (c.gx + ndx);
      if (cellToFace.has(nk)) {
        const fi = cellToFace.get(nk);
        faceGroups[fi].cells.push(c);
        cellToFace.set(key, fi);
        break;
      }
    }
  }

  // Step 4: Merge small faces
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = faceGroups.length - 1; i >= 0; i--) {
      if (faceGroups[i].cells.length === 0) continue;
      if (faceGroups[i].cells.length >= MIN_FACE_CELLS) continue;

      const adjFaces = new Set();
      for (const c of faceGroups[i].cells) {
        for (const [ndx, ndz] of N8) {
          const nk = (c.gz + ndz) * W + (c.gx + ndx);
          if (cellToFace.has(nk)) {
            const fi = cellToFace.get(nk);
            if (fi !== i && faceGroups[fi] && faceGroups[fi].cells.length > 0) {
              adjFaces.add(fi);
            }
          }
        }
      }

      let bestTarget = -1, bestSize = 0;
      for (const fi of adjFaces) {
        if (faceGroups[fi].cells.length > bestSize) {
          bestSize = faceGroups[fi].cells.length;
          bestTarget = fi;
        }
      }

      if (bestTarget >= 0) {
        for (const c of faceGroups[i].cells) {
          faceGroups[bestTarget].cells.push(c);
          cellToFace.set(c.gz * W + c.gx, bestTarget);
        }
        faceGroups[i].cells = [];
        merged = true;
      }
    }
  }

  const activeFaces = faceGroups.filter(f => f.cells.length > 0);
  if (activeFaces.length <= 1) {
    return { faces: [zone], ridgeCells: new Set() };
  }

  // Cap at MAX_FACES
  while (activeFaces.length > MAX_FACES) {
    activeFaces.sort((a, b) => a.cells.length - b.cells.length);
    const smallest = activeFaces.shift();
    activeFaces[activeFaces.length - 1].cells.push(...smallest.cells);
  }

  // Detect boundary cells between faces (for visualization)
  const ridgeCells = new Set();
  for (const c of zone.cells) {
    const key = c.gz * W + c.gx;
    const myFace = cellToFace.get(key);
    if (myFace === undefined) continue;
    for (const [ndx, ndz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nk = (c.gz + ndz) * W + (c.gx + ndx);
      if (zoneSet.has(nk) && cellToFace.has(nk) && cellToFace.get(nk) !== myFace) {
        ridgeCells.add(key);
        break;
      }
    }
  }

  // Build face objects shaped like zones
  const faces = activeFaces.map((f, i) => {
    const n = f.cells.length;
    let cx = 0, cz = 0;
    for (const c of f.cells) { cx += c.gx; cz += c.gz; }
    cx /= n; cz /= n;

    let sumDx = 0, sumDz = 0, slopeSum = 0;
    for (const c of f.cells) {
      const lx = c.gx - bbMinGx;
      const lz = c.gz - bbMinGz;
      if (lx < 1 || lx >= bw - 1 || lz < 1 || lz >= bh - 1) continue;
      const dx = (smoothed[lz * bw + (lx + 1)] - smoothed[lz * bw + (lx - 1)]) / 2;
      const dz = (smoothed[(lz + 1) * bw + lx] - smoothed[(lz - 1) * bw + lx]) / 2;
      sumDx += dx;
      sumDz += dz;
      slopeSum += Math.sqrt(dx * dx + dz * dz);
    }

    const gradLen = Math.sqrt(sumDx * sumDx + sumDz * sumDz);
    const slopeDir = gradLen > 0.01
      ? { x: sumDx / gradLen, z: sumDz / gradLen }
      : (zone.slopeDir || { x: 1, z: 0 });
    const avgSlope = n > 0 ? slopeSum / n : (zone.avgSlope || 0);

    return {
      id: `${zone.id}-rf${i}`,
      cells: f.cells,
      centroidGx: cx,
      centroidGz: cz,
      avgSlope,
      slopeDir,
      nucleusIdx: zone.nucleusIdx,
      avgLandValue: zone.avgLandValue,
      totalLandValue: zone.totalLandValue * (n / zone.cells.length),
      priority: zone.priority,
      polygon: zone.polygon,
      boundingEdgeIds: zone.boundingEdgeIds,
      boundary: zone.boundary,
    };
  });

  return { faces, ridgeCells };
}

// === Helpers ===

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

function gaussianBlur(elev, minGx, minGz, bw, bh, W, H, radius) {
  const sigma = radius / 2;
  const kernel = [];
  let kSum = 0;
  for (let d = -radius; d <= radius; d++) {
    const w = Math.exp(-(d * d) / (2 * sigma * sigma));
    kernel.push(w);
    kSum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= kSum;

  const temp = new Float64Array(bw * bh);
  for (let z = 0; z < bh; z++) {
    for (let x = 0; x < bw; x++) {
      let sum = 0, wt = 0;
      for (let d = -radius; d <= radius; d++) {
        const nx = x + d;
        if (nx >= 0 && nx < bw) {
          const gx2 = nx + minGx, gz2 = z + minGz;
          if (gx2 >= 0 && gx2 < W && gz2 >= 0 && gz2 < H) {
            const kw = kernel[d + radius];
            sum += elev.get(gx2, gz2) * kw;
            wt += kw;
          }
        }
      }
      temp[z * bw + x] = wt > 0 ? sum / wt : elev.get(x + minGx, z + minGz);
    }
  }

  const smoothed = new Float64Array(bw * bh);
  for (let z = 0; z < bh; z++) {
    for (let x = 0; x < bw; x++) {
      let sum = 0, wt = 0;
      for (let d = -radius; d <= radius; d++) {
        const nz = z + d;
        if (nz >= 0 && nz < bh) {
          const kw = kernel[d + radius];
          sum += temp[nz * bw + x] * kw;
          wt += kw;
        }
      }
      smoothed[z * bw + x] = wt > 0 ? sum / wt : temp[z * bw + x];
    }
  }

  return smoothed;
}
