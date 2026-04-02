/**
 * Ridge/valley terrain face segmentation — v2 (whole-map, zone-independent).
 *
 * Segments the entire buildable terrain into faces based on gradient direction,
 * independent of zone boundaries. Faces and zones are parallel systems —
 * a zone can span multiple faces, and a face can span multiple zones.
 *
 * Algorithm:
 * 1. Smooth elevation with large Gaussian blur (radius 10)
 * 2. Compute gradient direction at each buildable cell
 * 3. Region-grow faces from centroid of buildable area outward,
 *    splitting where gradient direction differs by > 60°
 * 4. Merge small faces into largest neighbour
 *
 * Returns an array of face objects with cells, centroid, gradient direction.
 */

const MAX_FACES = 30;
const MIN_FACE_FRACTION = 0.01; // face must be ≥1% of total buildable cells
const DIR_TOLERANCE = Math.PI / 3; // 60°
const BLUR_RADIUS = 10;
const MIN_ABSOLUTE_CELLS = 500;

/**
 * Segment the entire buildable terrain into gradient-direction faces.
 *
 * @param {object} map - FeatureMap with elevation, waterMask layers
 * @returns {{ faces: object[], ridgeCells: Set<number> }}
 */
export function segmentTerrainV2(map, opts = {}) {
  const dirTolerance = opts.dirTolerance ?? DIR_TOLERANCE;
  const elevTolerance = opts.elevTolerance ?? null;   // max elev diff from seed (metres), null=disabled
  const slopeBands = opts.slopeBands ?? null;          // array of thresholds e.g. [0.3, 0.8], null=disabled
  const elev = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
  if (!elev) return { faces: [], ridgeCells: new Set() };

  const W = map.width;
  const H = map.height;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;

  // Collect all non-water cells — faces cover all terrain, not just buildable land.
  // Buildability is a preference, not a hard filter. The zone intersection downstream
  // limits what actually gets developed; face terrain properties (avgSlope, elevation)
  // are more useful as parcel metadata than as exclusion filters.
  const buildableSet = new Set();
  let totalBuildable = 0;
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      if (waterMask && waterMask.get(gx, gz) > 0) continue;
      buildableSet.add(gz * W + gx);
      totalBuildable++;
    }
  }

  const minFaceCells = Math.max(MIN_ABSOLUTE_CELLS, Math.floor(totalBuildable * MIN_FACE_FRACTION));

  // Step 1: Smooth elevation (whole map)
  const smoothed = gaussianBlur(elev, 0, 0, W, H, W, H, BLUR_RADIUS);

  // Pre-compute slope magnitude per cell (for slopeBands mode)
  const slopeMagMap = new Map();
  if (slopeBands) {
    for (let gz = 1; gz < H - 1; gz++) {
      for (let gx = 1; gx < W - 1; gx++) {
        const key = gz * W + gx;
        if (!buildableSet.has(key)) continue;
        const dx = (smoothed[gz * W + (gx + 1)] - smoothed[gz * W + (gx - 1)]) / 2;
        const dz = (smoothed[(gz + 1) * W + gx] - smoothed[(gz - 1) * W + gx]) / 2;
        slopeMagMap.set(key, Math.sqrt(dx * dx + dz * dz));
      }
    }
  }

  function getSlopeBand(key) {
    const mag = slopeMagMap.get(key) ?? 0;
    for (let i = 0; i < slopeBands.length; i++) {
      if (mag < slopeBands[i]) return i;
    }
    return slopeBands.length;
  }

  // Step 2: Compute gradient direction at each buildable cell
  const gradDirMap = new Map();

  for (let gz = 1; gz < H - 1; gz++) {
    for (let gx = 1; gx < W - 1; gx++) {
      const key = gz * W + gx;
      if (!buildableSet.has(key)) continue;

      const dx = (smoothed[gz * W + (gx + 1)] - smoothed[gz * W + (gx - 1)]) / 2;
      const dz = (smoothed[(gz + 1) * W + gx] - smoothed[(gz - 1) * W + gx]) / 2;
      const mag = Math.sqrt(dx * dx + dz * dz);

      if (mag > 0.005) {
        gradDirMap.set(key, Math.atan2(dz, dx));
      }
    }
  }

  // Step 3: Region-grow from map centre outward
  // Find buildable cell nearest to map centre
  const midX = W / 2;
  const midZ = H / 2;
  let bestSeed = -1;
  let bestDist = Infinity;
  for (const key of gradDirMap.keys()) {
    const gz = Math.floor(key / W);
    const gx = key % W;
    const d = (gx - midX) ** 2 + (gz - midZ) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestSeed = key;
    }
  }

  if (bestSeed < 0) return { faces: [], ridgeCells: new Set() };

  const cellToFace = new Map();
  const faceGroups = []; // array of { cells: [{gx,gz}], sumDx, sumDz }
  const N8 = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

  // Helper: check if a cell can join a face
  function canJoin(nk, faceDir, dirTol, face) {
    const nDir = gradDirMap.get(nk);
    if (nDir === undefined) return false;
    if (angleDiff(nDir, faceDir) > dirTol) return false;
    if (elevTolerance !== null) {
      const nElev = smoothed[nk];
      // Check against face's current elevation range — would adding this cell
      // push the range beyond the tolerance?
      const newMin = Math.min(face.elevMin, nElev);
      const newMax = Math.max(face.elevMax, nElev);
      if (newMax - newMin > elevTolerance) return false;
    }
    if (slopeBands && getSlopeBand(nk) !== face.slopeBand) return false;
    return true;
  }

  // Grow first face from centre
  const seedDir = gradDirMap.get(bestSeed);
  const seedElev0 = smoothed[bestSeed];
  const firstFace = {
    cells: [{ gx: bestSeed % W, gz: Math.floor(bestSeed / W) }],
    sumDx: Math.cos(seedDir),
    sumDz: Math.sin(seedDir),
    elevMin: seedElev0,
    elevMax: seedElev0,
    slopeBand: slopeBands ? getSlopeBand(bestSeed) : 0,
  };
  cellToFace.set(bestSeed, 0);
  faceGroups.push(firstFace);

  const queue = [bestSeed];
  let qi = 0;
  while (qi < queue.length) {
    const k = queue[qi++];
    const kgz = Math.floor(k / W);
    const kgx = k % W;

    for (const [ndx, ndz] of N8) {
      const nk = (kgz + ndz) * W + (kgx + ndx);
      if (cellToFace.has(nk)) continue;
      if (!buildableSet.has(nk)) continue;

      const faceDir = Math.atan2(firstFace.sumDz, firstFace.sumDx);
      if (canJoin(nk, faceDir, dirTolerance, firstFace)) {
        const nElev = smoothed[nk];
        firstFace.cells.push({ gx: nk % W, gz: Math.floor(nk / W) });
        firstFace.sumDx += Math.cos(gradDirMap.get(nk));
        firstFace.sumDz += Math.sin(gradDirMap.get(nk));
        if (nElev < firstFace.elevMin) firstFace.elevMin = nElev;
        if (nElev > firstFace.elevMax) firstFace.elevMax = nElev;
        cellToFace.set(nk, 0);
        queue.push(nk);
      }
    }
  }

  // Grow remaining unvisited cells into faces (closest to centre first)
  const remainingKeys = [];
  for (const key of gradDirMap.keys()) {
    if (!cellToFace.has(key)) remainingKeys.push(key);
  }
  remainingKeys.sort((a, b) => {
    const agz = Math.floor(a / W), agx = a % W;
    const bgz = Math.floor(b / W), bgx = b % W;
    return ((agx - midX) ** 2 + (agz - midZ) ** 2) - ((bgx - midX) ** 2 + (bgz - midZ) ** 2);
  });

  for (const seedKey of remainingKeys) {
    if (cellToFace.has(seedKey)) continue;

    const sd = gradDirMap.get(seedKey);
    const fi = faceGroups.length;
    const seedElevN = smoothed[seedKey];
    const face = {
      cells: [{ gx: seedKey % W, gz: Math.floor(seedKey / W) }],
      sumDx: Math.cos(sd),
      sumDz: Math.sin(sd),
      elevMin: seedElevN,
      elevMax: seedElevN,
      slopeBand: slopeBands ? getSlopeBand(seedKey) : 0,
    };
    cellToFace.set(seedKey, fi);
    faceGroups.push(face);

    const q2 = [seedKey];
    let q2i = 0;
    while (q2i < q2.length) {
      const k = q2[q2i++];
      const kgz = Math.floor(k / W);
      const kgx = k % W;

      for (const [ndx, ndz] of N8) {
        const nk = (kgz + ndz) * W + (kgx + ndx);
        if (cellToFace.has(nk)) continue;
        if (!buildableSet.has(nk)) continue;

        const faceDir = Math.atan2(face.sumDz, face.sumDx);
        if (canJoin(nk, faceDir, dirTolerance, face)) {
          const nElev = smoothed[nk];
          face.cells.push({ gx: nk % W, gz: Math.floor(nk / W) });
          face.sumDx += Math.cos(gradDirMap.get(nk));
          face.sumDz += Math.sin(gradDirMap.get(nk));
          if (nElev < face.elevMin) face.elevMin = nElev;
          if (nElev > face.elevMax) face.elevMax = nElev;
          cellToFace.set(nk, fi);
          q2.push(nk);
        }
      }
    }
  }

  // Assign cells without gradient (flat) to nearest face
  for (const key of buildableSet) {
    if (cellToFace.has(key)) continue;
    const kgz = Math.floor(key / W);
    const kgx = key % W;
    for (const [ndx, ndz] of N8) {
      const nk = (kgz + ndz) * W + (kgx + ndx);
      if (cellToFace.has(nk)) {
        const fi = cellToFace.get(nk);
        faceGroups[fi].cells.push({ gx: kgx, gz: kgz });
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
      if (faceGroups[i].cells.length >= minFaceCells) continue;

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

      let bestTarget = -1;
      let bestSize = 0;
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

  let activeFaces = faceGroups.filter(f => f.cells.length > 0);

  // Cap at MAX_FACES
  while (activeFaces.length > MAX_FACES) {
    activeFaces.sort((a, b) => a.cells.length - b.cells.length);
    const smallest = activeFaces.shift();
    activeFaces[activeFaces.length - 1].cells.push(...smallest.cells);
  }

  // Detect boundary cells between faces
  const ridgeCells = new Set();
  for (const key of buildableSet) {
    const myFace = cellToFace.get(key);
    if (myFace === undefined) continue;
    const kgz = Math.floor(key / W);
    const kgx = key % W;
    for (const [ndx, ndz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nk = (kgz + ndz) * W + (kgx + ndx);
      if (buildableSet.has(nk) && cellToFace.has(nk) && cellToFace.get(nk) !== myFace) {
        ridgeCells.add(key);
        break;
      }
    }
  }

  // Build face objects
  const faces = activeFaces.map((f, i) => {
    const n = f.cells.length;
    let cx = 0;
    let cz = 0;
    for (const c of f.cells) {
      cx += c.gx;
      cz += c.gz;
    }
    cx /= n;
    cz /= n;

    let sumDx = 0;
    let sumDz = 0;
    let slopeSum = 0;
    for (const c of f.cells) {
      if (c.gx < 1 || c.gx >= W - 1 || c.gz < 1 || c.gz >= H - 1) continue;
      const dx = (smoothed[c.gz * W + (c.gx + 1)] - smoothed[c.gz * W + (c.gx - 1)]) / 2;
      const dz = (smoothed[(c.gz + 1) * W + c.gx] - smoothed[(c.gz - 1) * W + c.gx]) / 2;
      sumDx += dx;
      sumDz += dz;
      slopeSum += Math.sqrt(dx * dx + dz * dz);
    }

    const gradLen = Math.sqrt(sumDx * sumDx + sumDz * sumDz);
    const slopeDir = gradLen > 0.01
      ? { x: sumDx / gradLen, z: sumDz / gradLen }
      : { x: 1, z: 0 };
    const avgSlope = n > 0 ? slopeSum / n : 0;

    return {
      id: `terrain-f${i}`,
      cells: f.cells,
      centroidGx: cx,
      centroidGz: cz,
      avgSlope,
      slopeDir,
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
      let sum = 0;
      let wt = 0;
      for (let d = -radius; d <= radius; d++) {
        const nx = x + d;
        if (nx >= 0 && nx < bw) {
          const gx2 = nx + minGx;
          const gz2 = z + minGz;
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
      let sum = 0;
      let wt = 0;
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
