#!/usr/bin/env bun
/**
 * Experiment 007j — Elevation-matched parallel streets (converging at junctions).
 *
 * Improvement over 007i: instead of placing PARALLEL_SPACING points at fixed
 * gradient offsets on BOTH cross streets and connecting matching indices, we now:
 *
 *   1. Place source points at PARALLEL_SPACING intervals along cross street A only.
 *   2. For each source point, read its elevation.
 *   3. Walk cross street B at small intervals; interpolate to find the point on B
 *      that has exactly the same elevation.
 *   4. Connect source point to the elevation-matched point on B.
 *
 * This produces contour-following parallels that converge where terrain is steep
 * (contour lines close together) and diverge where terrain is gentle, matching
 * real hillside street behaviour.
 *
 * Cross streets remain gradient-direction sweeps (same as 007i).
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { createZoneBoundaryRoads } from '../src/city/pipeline/zoneBoundaryRoads.js';
import { subdivideLargeZones } from '../src/city/pipeline/subdivideZones.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007j-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
for (let i = 0; i < 4; i++) strategy.tick();

createZoneBoundaryRoads(map);
subdivideLargeZones(map);
extractZones(map);

const zones = map.developmentZones;
const W = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');

// Pick same zone as 007i — medium-large, near centre, has slope data
const candidates = zones.filter(z =>
  z.cells.length > 2000 && z.cells.length < 50000 &&
  z.boundary && z.boundary.length >= 4 && z.avgSlope !== undefined
);
candidates.sort((a, b) => {
  const ad = Math.abs(a.centroidGx - W/2) + Math.abs(a.centroidGz - H/2);
  const bd = Math.abs(b.centroidGx - W/2) + Math.abs(b.centroidGz - H/2);
  return ad - bd;
});
const zone = candidates[0];
if (!zone) { console.error('No suitable zone'); process.exit(1); }

// Find zone bounding box for cropped render
let minGx = W, maxGx = 0, minGz = H, maxGz = 0;
for (const c of zone.cells) {
  if (c.gx < minGx) minGx = c.gx;
  if (c.gx > maxGx) maxGx = c.gx;
  if (c.gz < minGz) minGz = c.gz;
  if (c.gz > maxGz) maxGz = c.gz;
}
const pad = 20;
minGx = Math.max(0, minGx - pad);
maxGx = Math.min(W - 1, maxGx + pad);
minGz = Math.max(0, minGz - pad);
maxGz = Math.min(H - 1, maxGz + pad);
const cropW = maxGx - minGx + 1;
const cropH = maxGz - minGz + 1;

console.log(`Zone: ${zone.cells.length} cells, avgSlope=${zone.avgSlope.toFixed(3)}`);
console.log(`Crop: ${cropW}x${cropH} at (${minGx},${minGz})`);

// ===== Terrain face segmentation (same as 007i) =====
const zoneSet = new Set();
for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

const elevations = zone.cells.map(c => elev.get(c.gx, c.gz)).sort((a, b) => a - b);
const q25 = elevations[Math.floor(elevations.length * 0.25)];
const q50 = elevations[Math.floor(elevations.length * 0.50)];
const q75 = elevations[Math.floor(elevations.length * 0.75)];
const thresholds = [q25, q50, q75];

console.log(`Elevation quartiles: q25=${q25.toFixed(1)}, q50=${q50.toFixed(1)}, q75=${q75.toFixed(1)}`);

const bandGrid = new Int8Array(W * H).fill(-1);
for (const c of zone.cells) {
  const e = elev.get(c.gx, c.gz);
  let band = 0;
  for (const t of thresholds) { if (e >= t) band++; }
  bandGrid[c.gz * W + c.gx] = band;
}

// Flood-fill faces
const visited = new Uint8Array(W * H);
const faces = [];
for (const c of zone.cells) {
  const idx = c.gz * W + c.gx;
  if (visited[idx]) continue;
  const band = bandGrid[idx];
  if (band < 0) continue;
  const cells = [];
  const queue = [{ gx: c.gx, gz: c.gz }];
  visited[idx] = 1;
  while (queue.length > 0) {
    const p = queue.shift();
    cells.push(p);
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = p.gx + dx, nz = p.gz + dz;
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
      const ni = nz * W + nx;
      if (visited[ni] || bandGrid[ni] !== band) continue;
      visited[ni] = 1;
      queue.push({ gx: nx, gz: nz });
    }
  }
  if (cells.length >= 500) faces.push({ cells, band });
}

console.log(`${faces.length} terrain faces`);

// ===== Gradient-cross layout (same as 007i for cross streets) =====
const CROSS_SPACING = 90;     // metres between cross streets (along contour)
const PARALLEL_SPACING = 35;  // metres between source points on cross street A
const ELEV_STEP = 1.0;        // metres — step size for elevation sampling along cross street B
const MIN_STREET_LEN = 20;    // metres — skip degenerate segments

const allCross = [];
const allParallel = [];
const faceTints = [[60,100,60],[60,60,100],[100,80,50],[80,60,100],[60,100,100],[100,60,80]];

// Statistics for logging
const faceStats = [];

for (let fi = 0; fi < faces.length; fi++) {
  const face = faces[fi];

  // Build a fast lookup set for this face
  const faceSet = new Set(face.cells.map(c => c.gz * W + c.gx));

  // ------------------------------------------------------------------
  // Step 1: Compute average gradient direction for this face.
  // ------------------------------------------------------------------
  let sumDx = 0, sumDz = 0, gradCount = 0;

  for (const c of face.cells) {
    const eC = elev.get(c.gx, c.gz);

    const eE = faceSet.has(c.gz * W + (c.gx + 1)) ? elev.get(c.gx + 1, c.gz) : eC;
    const eW = faceSet.has(c.gz * W + (c.gx - 1)) ? elev.get(c.gx - 1, c.gz) : eC;
    const gx_ = (eE - eW) / (2 * cs);

    const eS = faceSet.has((c.gz + 1) * W + c.gx) ? elev.get(c.gx, c.gz + 1) : eC;
    const eN = faceSet.has((c.gz - 1) * W + c.gx) ? elev.get(c.gx, c.gz - 1) : eC;
    const gz_ = (eS - eN) / (2 * cs);

    sumDx += gx_;
    sumDz += gz_;
    gradCount++;
  }

  if (gradCount === 0) continue;

  let gradX = sumDx / gradCount;
  let gradZ = sumDz / gradCount;
  const gradMag = Math.sqrt(gradX * gradX + gradZ * gradZ);

  if (gradMag < 1e-6) {
    if (zone.slopeDir) {
      gradX = zone.slopeDir.x;
      gradZ = zone.slopeDir.z;
    } else {
      continue;
    }
  } else {
    gradX /= gradMag;
    gradZ /= gradMag;
  }

  // Gradient direction (uphill): (gradX, gradZ)
  // Contour direction (perpendicular): (-gradZ, gradX)
  const ctX = -gradZ, ctZ = gradX;

  // ------------------------------------------------------------------
  // Step 2: Find face extent along the contour direction.
  // ------------------------------------------------------------------
  let cxSum = 0, czSum = 0;
  for (const c of face.cells) { cxSum += c.gx; czSum += c.gz; }
  const faceCx = ox + (cxSum / face.cells.length) * cs;
  const faceCz = oz + (czSum / face.cells.length) * cs;

  let minCt = Infinity, maxCt = -Infinity;
  let minGr = Infinity, maxGr = -Infinity;

  for (const c of face.cells) {
    const wx = ox + c.gx * cs;
    const wz = oz + c.gz * cs;
    const projCt = (wx - faceCx) * ctX + (wz - faceCz) * ctZ;
    const projGr = (wx - faceCx) * gradX + (wz - faceCz) * gradZ;
    if (projCt < minCt) minCt = projCt;
    if (projCt > maxCt) maxCt = projCt;
    if (projGr < minGr) minGr = projGr;
    if (projGr > maxGr) maxGr = projGr;
  }

  // ------------------------------------------------------------------
  // Step 3: Sweep cross streets at CROSS_SPACING along the contour axis.
  // ------------------------------------------------------------------

  const crossStreetSegments = []; // [{ctOff, start:{x,z}, end:{x,z}, gradMin, gradMax}]

  const firstCt = Math.ceil(minCt / CROSS_SPACING) * CROSS_SPACING;

  for (let ctOff = firstCt; ctOff <= maxCt + 1e-6; ctOff += CROSS_SPACING) {
    const lineOx = faceCx + ctX * ctOff;
    const lineOz = faceCz + ctZ * ctOff;

    const step = cs * 0.5;
    const reach = (maxGr - minGr) + cs * 2;
    const nSteps = Math.ceil(reach / step);

    const inFacePoints = [];

    for (let si = -nSteps; si <= nSteps; si++) {
      const grOff = si * step;
      const wx = lineOx + gradX * grOff;
      const wz = lineOz + gradZ * grOff;

      const cgx = Math.round((wx - ox) / cs);
      const cgz = Math.round((wz - oz) / cs);
      if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) continue;

      const inFace = faceSet.has(cgz * W + cgx);
      inFacePoints.push({ wx, wz, grOff, inFace });
    }

    // Keep the longest contiguous in-face run
    let bestRun = [];
    let curRun = [];
    for (const pt of inFacePoints) {
      if (pt.inFace) {
        curRun.push(pt);
      } else {
        if (curRun.length > bestRun.length) bestRun = curRun;
        curRun = [];
      }
    }
    if (curRun.length > bestRun.length) bestRun = curRun;

    if (bestRun.length < 2) continue;

    const segStart = bestRun[0];
    const segEnd   = bestRun[bestRun.length - 1];
    const segLen   = Math.sqrt(
      (segEnd.wx - segStart.wx) ** 2 + (segEnd.wz - segStart.wz) ** 2
    );
    if (segLen < MIN_STREET_LEN) continue;

    allCross.push([
      { x: segStart.wx, z: segStart.wz },
      { x: segEnd.wx,   z: segEnd.wz   },
    ]);

    crossStreetSegments.push({
      ctOff,
      start: { x: segStart.wx, z: segStart.wz },
      end:   { x: segEnd.wx,   z: segEnd.wz },
      gradMin: segStart.grOff,
      gradMax: segEnd.grOff,
    });
  }

  // ------------------------------------------------------------------
  // Step 4 (NEW): Elevation-matched parallel streets.
  //
  // For each adjacent cross street pair (A, B):
  //   a) Place source points on A at PARALLEL_SPACING intervals.
  //   b) For each source point P on A, read elevation at P.
  //   c) Sample cross street B at ELEV_STEP resolution and interpolate
  //      to find the point Q on B with the same elevation as P.
  //   d) Draw a parallel street from P to Q.
  // ------------------------------------------------------------------

  crossStreetSegments.sort((a, b) => a.ctOff - b.ctOff);

  let faceCross = crossStreetSegments.length;
  let faceParallel = 0;

  for (let k = 0; k < crossStreetSegments.length - 1; k++) {
    const csA = crossStreetSegments[k];
    const csB = crossStreetSegments[k + 1];

    // Length of each cross street
    const lenA = Math.sqrt(
      (csA.end.x - csA.start.x) ** 2 + (csA.end.z - csA.start.z) ** 2
    );
    const lenB = Math.sqrt(
      (csB.end.x - csB.start.x) ** 2 + (csB.end.z - csB.start.z) ** 2
    );

    if (lenA < MIN_STREET_LEN || lenB < MIN_STREET_LEN) continue;

    // Pre-sample cross street B at ELEV_STEP intervals.
    // Each sample: { t (0..1), wx, wz, elevation }
    const nSamplesB = Math.max(2, Math.ceil(lenB / ELEV_STEP));
    const samplesB = [];
    for (let si = 0; si <= nSamplesB; si++) {
      const t = si / nSamplesB;
      const wx = csB.start.x + t * (csB.end.x - csB.start.x);
      const wz = csB.start.z + t * (csB.end.z - csB.start.z);
      // Convert world to grid for elevation lookup
      const cgx = Math.round((wx - ox) / cs);
      const cgz = Math.round((wz - oz) / cs);
      const e = (cgx >= 0 && cgx < W && cgz >= 0 && cgz < H)
        ? elev.get(cgx, cgz)
        : null;
      samplesB.push({ t, wx, wz, e });
    }
    // Filter out null-elevation samples
    const validSamplesB = samplesB.filter(s => s.e !== null);
    if (validSamplesB.length < 2) continue;

    const elevMinB = Math.min(...validSamplesB.map(s => s.e));
    const elevMaxB = Math.max(...validSamplesB.map(s => s.e));

    // Place source points on A at PARALLEL_SPACING intervals.
    const firstGr = Math.ceil(csA.gradMin / PARALLEL_SPACING) * PARALLEL_SPACING;

    for (let grOff = firstGr; grOff <= csA.gradMax + 1e-6; grOff += PARALLEL_SPACING) {
      const tA = (grOff - csA.gradMin) / (csA.gradMax - csA.gradMin);
      if (tA < 0 || tA > 1) continue;

      const pA = {
        x: csA.start.x + tA * (csA.end.x - csA.start.x),
        z: csA.start.z + tA * (csA.end.z - csA.start.z),
      };

      // Read elevation at source point P
      const cgxA = Math.round((pA.x - ox) / cs);
      const cgzA = Math.round((pA.z - oz) / cs);
      if (cgxA < 0 || cgxA >= W || cgzA < 0 || cgzA >= H) continue;
      const targetElev = elev.get(cgxA, cgzA);

      // Cross street B must span this elevation
      if (targetElev < elevMinB || targetElev > elevMaxB) continue;

      // Walk validSamplesB to find the interval where elevation crosses targetElev.
      // Because cross streets run uphill, elevation is monotonically increasing
      // (or at least generally trending) from start to end. We search for the
      // first crossing regardless.
      let pB = null;
      for (let si = 0; si < validSamplesB.length - 1; si++) {
        const s0 = validSamplesB[si];
        const s1 = validSamplesB[si + 1];
        const e0 = s0.e, e1 = s1.e;
        // Does the target elevation lie within this interval?
        if ((e0 <= targetElev && targetElev <= e1) || (e1 <= targetElev && targetElev <= e0)) {
          const span = e1 - e0;
          const alpha = Math.abs(span) < 1e-6 ? 0.5 : (targetElev - e0) / span;
          pB = {
            x: s0.wx + alpha * (s1.wx - s0.wx),
            z: s0.wz + alpha * (s1.wz - s0.wz),
          };
          break;
        }
      }

      if (!pB) continue;

      const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
      if (segLen < MIN_STREET_LEN) continue;

      allParallel.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
      faceParallel++;
    }
  }

  faceStats.push({ fi, band: face.band, cells: face.cells.length, cross: faceCross, parallel: faceParallel });
}

console.log(`${allCross.length} cross streets, ${allParallel.length} parallel streets`);
console.log('Face breakdown:');
for (const s of faceStats) {
  console.log(`  Face ${s.fi} band=${s.band} cells=${s.cells} cross=${s.cross} parallel=${s.parallel}`);
}

// ===== Render (cropped, same style as 007i) =====

const pixels = new Uint8Array(cropW * cropH * 3);

// Terrain base
const waterMask = map.getLayer('waterMask');
const eBounds = elev.bounds();
const eRange = eBounds.max - eBounds.min || 1;
for (let z = 0; z < cropH; z++) {
  for (let x = 0; x < cropW; x++) {
    const gx2 = x + minGx, gz2 = z + minGz;
    const v = (elev.get(gx2, gz2) - eBounds.min) / eRange;
    const idx = (z * cropW + x) * 3;
    if (waterMask && waterMask.get(gx2, gz2) > 0) {
      pixels[idx] = 15; pixels[idx+1] = 30; pixels[idx+2] = 60;
    } else {
      pixels[idx]   = Math.round(35 + v * 50);
      pixels[idx+1] = Math.round(45 + v * 40);
      pixels[idx+2] = Math.round(25 + v * 25);
    }
  }
}

// Face tints
for (let fi = 0; fi < faces.length; fi++) {
  const [tr, tg, tb] = faceTints[fi % faceTints.length];
  for (const c of faces[fi].cells) {
    const x = c.gx - minGx, z = c.gz - minGz;
    if (x >= 0 && x < cropW && z >= 0 && z < cropH) {
      const idx = (z * cropW + x) * 3;
      pixels[idx] = tr; pixels[idx+1] = tg; pixels[idx+2] = tb;
    }
  }
}

// Face boundaries (white, faint — 1px)
for (let fi = 0; fi < faces.length; fi++) {
  const faceSet = new Set(faces[fi].cells.map(c => c.gz * W + c.gx));
  for (const c of faces[fi].cells) {
    let isBoundary = false;
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      if (!faceSet.has((c.gz + dz) * W + (c.gx + dx))) { isBoundary = true; break; }
    }
    if (!isBoundary) continue;
    const x = c.gx - minGx, z = c.gz - minGz;
    if (x >= 0 && x < cropW && z >= 0 && z < cropH) {
      const idx = (z * cropW + x) * 3;
      pixels[idx] = 180; pixels[idx+1] = 180; pixels[idx+2] = 180;
    }
  }
}

// Roads
const roadGrid = map.getLayer('roadGrid');
if (roadGrid) {
  for (let z = 0; z < cropH; z++)
    for (let x = 0; x < cropW; x++)
      if (roadGrid.get(x + minGx, z + minGz) > 0) {
        const idx = (z * cropW + x) * 3;
        pixels[idx] = 150; pixels[idx+1] = 150; pixels[idx+2] = 150;
      }
}

// Zone boundary (yellow, 1px)
if (zone.boundary) {
  for (let i = 0; i < zone.boundary.length; i++) {
    const p1 = zone.boundary[i], p2 = zone.boundary[(i+1) % zone.boundary.length];
    bres(pixels, cropW, cropH,
      Math.round((p1.x - ox) / cs) - minGx, Math.round((p1.z - oz) / cs) - minGz,
      Math.round((p2.x - ox) / cs) - minGx, Math.round((p2.z - oz) / cs) - minGz,
      200, 200, 0);
  }
}

// Cross streets (magenta, 1px) — run straight uphill
for (const seg of allCross) {
  bres(pixels, cropW, cropH,
    Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
    Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
    255, 0, 255);
}

// Parallel streets (cyan, 1px) — now elevation-matched, should converge/diverge with terrain
for (const seg of allParallel) {
  bres(pixels, cropW, cropH,
    Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
    Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
    0, 220, 220);
}

const header = `P6\n${cropW} ${cropH}\n255\n`;
const basePath = `${outDir}/ribbon-zone-zoomed-seed${seed}`;
writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
console.log(`Written to ${basePath}.png (${cropW}x${cropH})`);
console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// === Bresenham line draw ===
function bres(pixels, w, h, x0, y0, x1, y1, r, g, b) {
  const dx = Math.abs(x1-x0), dy = Math.abs(y1-y0);
  const sx = x0<x1?1:-1, sy = y0<y1?1:-1;
  let err = dx-dy, x = x0, y = y0;
  for (let i = 0; i < dx+dy+2; i++) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (y*w+x)*3;
      pixels[idx]=r; pixels[idx+1]=g; pixels[idx+2]=b;
    }
    if (x===x1 && y===y1) break;
    const e2 = 2*err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
