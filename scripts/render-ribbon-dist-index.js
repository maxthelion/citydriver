#!/usr/bin/env bun
/**
 * Experiment 007k3 — Distance-indexed junction points (no elevation snapping).
 *
 * Problem with 007k2: junction points were placed at every 35m horizontal
 * distance interval then snapped to the nearest 2m elevation contour. On flat
 * terrain many points snapped to the same elevation key, causing gaps because
 * only the first occurrence of each key was recorded.
 *
 * Fix: keep the 35m horizontal-distance walk, but key each junction by its
 * sequential INDEX (0, 1, 2, 3...) along the cross street instead of by
 * elevation. Adjacent cross streets connect index N on street A to index N on
 * street B → full coverage with no collapsed keys.
 *
 * This is similar to 007i's fixed-offset approach but uses the per-face
 * gradient direction from 007i and the zoomed rendering from 007k2. The key
 * difference from 007i: junction points are placed by walking the cross
 * street and measuring arc-length distance, not by sweeping perpendicular
 * offsets.
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { subdivideLargeZones } from '../src/city/pipeline/subdivideZones.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';

const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007k3-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
runToStep(strategy, 'spatial');

// Pipeline already runs zone-boundary + zones-refine. Only subdivide large zones
// (which cuts interior roads) and re-extract using flood-fill so the new road
// barriers are respected.
subdivideLargeZones(map);
extractZones(map);

const zones = map.developmentZones;
const W = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');

// Pick same zone as 007i/007j/007k — medium-large, near centre, has slope data
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

// ===== Terrain face segmentation (same as 007i/007j/007k) =====
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

// ===== Distance-indexed junction layout =====
const CROSS_SPACING    = 90;   // metres between cross streets (along contour axis)
const PARALLEL_SPACING = 35;   // metres of horizontal arc-length between junction points
const MIN_STREET_LEN   = 20;   // metres — skip degenerate segments

const allCross     = [];
const allParallel  = [];
const allJunctions = [];  // {x, z} — red dots for rendering
const faceTints = [[60,100,60],[60,60,100],[100,80,50],[80,60,100],[60,100,100],[100,60,80]];

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

  // Contour direction (perpendicular to gradient): (-gradZ, gradX)
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
  // Same geometry as 007k — keep longest contiguous in-face run.
  // ------------------------------------------------------------------
  const crossStreets = [];

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
      inFacePoints.push({ wx, wz, grOff, inFace, cgx, cgz });
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

    // Record for rendering
    allCross.push([
      { x: segStart.wx, z: segStart.wz },
      { x: segEnd.wx,   z: segEnd.wz   },
    ]);

    // ------------------------------------------------------------------
    // Step 4: Walk this cross street measuring horizontal arc-length.
    // Every PARALLEL_SPACING metres, record the current position and key
    // it by its sequential INDEX (0, 1, 2, ...) along this street.
    //
    // junctionMap: pointIndex (integer) → {x, z}
    // Using the distance index as the key means adjacent cross streets
    // will match index N on street A to index N on street B, giving full
    // coverage even on flat terrain where elevation snapping collapses
    // multiple points to the same key.
    // ------------------------------------------------------------------
    const junctionMap = new Map(); // key = distance index (integer)

    const profile = bestRun; // already at half-cell steps

    let distAccum = 0;
    let pointIndex = 0;

    for (let si = 0; si < profile.length; si++) {
      // Accumulate horizontal distance from previous sample
      if (si > 0) {
        const dx = profile[si].wx - profile[si - 1].wx;
        const dz = profile[si].wz - profile[si - 1].wz;
        distAccum += Math.sqrt(dx * dx + dz * dz);
      }

      if (distAccum < PARALLEL_SPACING) continue;
      distAccum = 0; // reset accumulator for next interval

      // Record junction at this position with its distance index as the key
      const pt = profile[si];
      if (pt.cgx < 0 || pt.cgx >= W || pt.cgz < 0 || pt.cgz >= H) continue;

      junctionMap.set(pointIndex, { x: pt.wx, z: pt.wz });
      pointIndex++;
    }

    crossStreets.push({ ctOff, start: segStart, end: segEnd, junctionMap });
  }

  // ------------------------------------------------------------------
  // Step 5: Connect matching distance indices between adjacent cross streets.
  // Index N on street A connects to index N on street B.
  // ------------------------------------------------------------------
  crossStreets.sort((a, b) => a.ctOff - b.ctOff);

  let faceCross = crossStreets.length;
  let faceParallel = 0;

  // Collect junction dots for rendering
  for (const cs_ of crossStreets) {
    for (const [, pt] of cs_.junctionMap) {
      allJunctions.push({ x: pt.x, z: pt.z });
    }
  }

  for (let k = 0; k < crossStreets.length - 1; k++) {
    const csA = crossStreets[k];
    const csB = crossStreets[k + 1];

    for (const [key, pA] of csA.junctionMap) {
      const pB = csB.junctionMap.get(key);
      if (!pB) continue;

      const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
      if (segLen < MIN_STREET_LEN) continue;

      allParallel.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
      faceParallel++;
    }
  }

  faceStats.push({ fi, band: face.band, cells: face.cells.length, cross: faceCross, parallel: faceParallel });
}

console.log(`${allCross.length} cross streets, ${allParallel.length} parallel streets, ${allJunctions.length} junction points`);
console.log('Face breakdown:');
for (const s of faceStats) {
  console.log(`  Face ${s.fi} band=${s.band} cells=${s.cells} cross=${s.cross} parallel=${s.parallel}`);
}

// ===== Render (cropped, same style as 007k) =====

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

// Parallel streets (cyan, 1px) — distance-indexed contour followers
for (const seg of allParallel) {
  bres(pixels, cropW, cropH,
    Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
    Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
    0, 220, 220);
}

// Junction points (red, 1px dot)
for (const pt of allJunctions) {
  const px = Math.round((pt.x - ox) / cs) - minGx;
  const pz = Math.round((pt.z - oz) / cs) - minGz;
  if (px >= 0 && px < cropW && pz >= 0 && pz < cropH) {
    const idx = (pz * cropW + px) * 3;
    pixels[idx] = 255; pixels[idx+1] = 0; pixels[idx+2] = 0;
  }
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
