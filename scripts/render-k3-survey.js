#!/usr/bin/env bun
/**
 * render-k3-survey.js — k3-only organic streets across up to 3 zones per seed.
 *
 * Renders terrain face segmentation + distance-indexed junction layout (k3)
 * without any s2 geometric overlay. One image per zone.
 *
 * Usage: bun scripts/render-k3-survey.js <seed> <gx> <gz> [outDir]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
// Zone extraction handled by pipeline (skeleton → boundaries → land-value → zones → zone-boundary → zones-refine)
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';

const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/k3-survey-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
runToStep(strategy, 'spatial');
// Pipeline already runs: skeleton → boundaries → land-value → zones
// → zone-boundary → zones-refine → spatial

const zones = map.developmentZones;
const W = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');
const roadGrid = map.getLayer('roadGrid');
const waterMask = map.getLayer('waterMask');
const eBounds = elev.bounds();
const eRange = eBounds.max - eBounds.min || 1;

// ===== Zone selection — relaxed: cells > 500, has boundary >= 4 pts, has avgSlope =====
const candidates = zones.filter(z =>
  z.cells.length > 500 &&
  z.boundary && z.boundary.length >= 4 && z.avgSlope !== undefined
);
candidates.sort((a, b) => {
  const ad = Math.abs(a.centroidGx - W / 2) + Math.abs(a.centroidGz - H / 2);
  const bd = Math.abs(b.centroidGx - W / 2) + Math.abs(b.centroidGz - H / 2);
  return ad - bd;
});
const selectedZones = candidates.slice(0, 3);

if (selectedZones.length === 0) {
  console.error('No suitable zones found');
  process.exit(1);
}

console.log(`Found ${candidates.length} candidate zones, rendering ${selectedZones.length}`);

// ===== k3 constants =====
const CROSS_SPACING = 90;
const PARALLEL_SPACING = 35;
const MIN_STREET_LEN = 20;
const faceTints = [[60, 100, 60], [60, 60, 100], [100, 80, 50], [80, 60, 100], [60, 100, 100], [100, 60, 80]];

// Summary accumulators
let totalCross = 0;
let totalParallel = 0;
const zoneResults = [];

// ===== Process each zone =====
for (let zi = 0; zi < selectedZones.length; zi++) {
  const zone = selectedZones[zi];
  console.log(`\n=== Zone ${zi} ===`);
  console.log(`  ${zone.cells.length} cells, avgSlope=${zone.avgSlope.toFixed(3)}`);

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
  console.log(`  Crop: ${cropW}x${cropH} at (${minGx},${minGz})`);

  // ===== k3: Terrain face segmentation (elevation quartiles, as per 007k3) =====
  const zoneSet = new Set();
  for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

  // Elevation quartile thresholds — cells at similar elevation form one face
  const elevations = zone.cells.map(c => elev.get(c.gx, c.gz)).sort((a, b) => a - b);
  const q25 = elevations[Math.floor(elevations.length * 0.25)];
  const q50 = elevations[Math.floor(elevations.length * 0.50)];
  const q75 = elevations[Math.floor(elevations.length * 0.75)];
  const thresholds = [q25, q50, q75];

  const bandGrid = new Int8Array(W * H).fill(-1);
  for (const c of zone.cells) {
    const e = elev.get(c.gx, c.gz);
    let band = 0;
    for (const t of thresholds) { if (e >= t) band++; }
    bandGrid[c.gz * W + c.gx] = band;
  }

  // Flood-fill faces — contiguous cells at same elevation band
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
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
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

  console.log(`  ${faces.length} terrain faces (elevation quartiles, min 500 cells)`);

  // ===== k3: Distance-indexed junction layout =====
  const allCross = [];
  const allParallel = [];
  const allJunctions = [];
  const faceStats = [];

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const faceSet = new Set(face.cells.map(c => c.gz * W + c.gx));

    // Compute average gradient direction for this face
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

    const ctX = -gradZ, ctZ = gradX;

    // Find face extent along the contour direction
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

    // Sweep cross streets at CROSS_SPACING along the contour axis
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
      const segEnd = bestRun[bestRun.length - 1];
      const segLen = Math.sqrt(
        (segEnd.wx - segStart.wx) ** 2 + (segEnd.wz - segStart.wz) ** 2
      );
      if (segLen < MIN_STREET_LEN) continue;

      allCross.push([
        { x: segStart.wx, z: segStart.wz },
        { x: segEnd.wx, z: segEnd.wz },
      ]);

      // Walk cross street measuring horizontal arc-length for junction points
      // Store elevation at each junction for elevation-based matching
      const junctions = [];
      const profile = bestRun;
      let distAccum = 0;

      for (let si = 0; si < profile.length; si++) {
        if (si > 0) {
          const dx = profile[si].wx - profile[si - 1].wx;
          const dz = profile[si].wz - profile[si - 1].wz;
          distAccum += Math.sqrt(dx * dx + dz * dz);
        }
        if (distAccum < PARALLEL_SPACING) continue;
        distAccum = 0;

        const pt = profile[si];
        if (pt.cgx < 0 || pt.cgx >= W || pt.cgz < 0 || pt.cgz >= H) continue;
        const e = elev.get(pt.cgx, pt.cgz);
        junctions.push({ x: pt.wx, z: pt.wz, elev: e });
      }

      crossStreets.push({ ctOff, start: segStart, end: segEnd, junctions });
    }

    // Connect junctions between adjacent cross streets by sequential index,
    // but reject connections that are too steep (> 15% gradient).
    // Index-based matching keeps parallels local and straight.
    // Elevation filtering catches cases where contours curve and same-index
    // junctions end up at very different heights.
    crossStreets.sort((a, b) => a.ctOff - b.ctOff);

    let faceCross = crossStreets.length;
    let faceParallel = 0;

    for (const cs_ of crossStreets) {
      for (const pt of cs_.junctions) {
        allJunctions.push({ x: pt.x, z: pt.z });
      }
    }

    for (let k = 0; k < crossStreets.length - 1; k++) {
      const jA = crossStreets[k].junctions;
      const jB = crossStreets[k + 1].junctions;

      const count = Math.min(jA.length, jB.length);
      for (let idx = 0; idx < count; idx++) {
        const pA = jA[idx], pB = jB[idx];

        const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
        if (segLen < MIN_STREET_LEN) continue;
        // Skip if gradient is too steep (> 15%)
        const elevDiff = Math.abs(pA.elev - pB.elev);
        if (elevDiff / segLen > 0.15) continue;

        allParallel.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
        faceParallel++;
      }
    }

    faceStats.push({ fi, band: face.band, cells: face.cells.length, cross: faceCross, parallel: faceParallel });
  }

  // ===== Post-processing: remove parallel violations and road crossings =====

  // 1. Remove parallel streets that are too close to another parallel (< 5m)
  const MIN_PARALLEL_SEP = 5;
  const parallelsBefore = allParallel.length;
  for (let i = allParallel.length - 1; i >= 0; i--) {
    const midI = {
      x: (allParallel[i][0].x + allParallel[i][1].x) / 2,
      z: (allParallel[i][0].z + allParallel[i][1].z) / 2,
    };
    const angleI = Math.atan2(
      allParallel[i][1].z - allParallel[i][0].z,
      allParallel[i][1].x - allParallel[i][0].x
    );
    for (let j = 0; j < i; j++) {
      const angleJ = Math.atan2(
        allParallel[j][1].z - allParallel[j][0].z,
        allParallel[j][1].x - allParallel[j][0].x
      );
      let angleDiff = Math.abs(angleI - angleJ);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
      if (angleDiff > Math.PI / 12) continue; // >15° — not parallel

      // Distance from midpoint of i to segment j
      const a = allParallel[j][0], b = allParallel[j][1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const lenSq = dx * dx + dz * dz;
      if (lenSq === 0) continue;
      let t = ((midI.x - a.x) * dx + (midI.z - a.z) * dz) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const dist = Math.hypot(midI.x - (a.x + t * dx), midI.z - (a.z + t * dz));
      if (dist < MIN_PARALLEL_SEP) {
        allParallel.splice(i, 1);
        break;
      }
    }
  }

  // 2. Clip streets at existing road cells — truncate at road grid intersections
  if (roadGrid) {
    const clipSegments = (segments) => {
      const result = [];
      for (const seg of segments) {
        // Walk the segment checking for road cells
        const dx = seg[1].x - seg[0].x, dz = seg[1].z - seg[0].z;
        const len = Math.hypot(dx, dz);
        if (len < 1) { result.push(seg); continue; }
        const stepLen = cs * 0.5;
        const nSteps = Math.ceil(len / stepLen);
        let lastCleanPt = seg[0];
        let hitRoad = false;
        for (let s = 1; s <= nSteps; s++) {
          const t = Math.min(s / nSteps, 1);
          const px = seg[0].x + dx * t, pz = seg[0].z + dz * t;
          const gx2 = Math.round((px - ox) / cs), gz2 = Math.round((pz - oz) / cs);
          if (gx2 >= 0 && gx2 < W && gz2 >= 0 && gz2 < H && roadGrid.get(gx2, gz2) > 0) {
            // Hit a road — emit segment up to here if long enough
            const clipLen = Math.hypot(px - lastCleanPt.x, pz - lastCleanPt.z);
            if (clipLen >= MIN_STREET_LEN) {
              result.push([{ x: lastCleanPt.x, z: lastCleanPt.z }, { x: px, z: pz }]);
            }
            hitRoad = true;
            // Skip past the road
            while (s < nSteps) {
              s++;
              const t2 = Math.min(s / nSteps, 1);
              const px2 = seg[0].x + dx * t2, pz2 = seg[0].z + dz * t2;
              const gx3 = Math.round((px2 - ox) / cs), gz3 = Math.round((pz2 - oz) / cs);
              if (gx3 < 0 || gx3 >= W || gz3 < 0 || gz3 >= H || roadGrid.get(gx3, gz3) === 0) {
                lastCleanPt = { x: px2, z: pz2 };
                break;
              }
            }
          }
        }
        // Emit final segment after last road crossing
        const finalLen = Math.hypot(seg[1].x - lastCleanPt.x, seg[1].z - lastCleanPt.z);
        if (finalLen >= MIN_STREET_LEN) {
          result.push([{ x: lastCleanPt.x, z: lastCleanPt.z }, { x: seg[1].x, z: seg[1].z }]);
        } else if (!hitRoad) {
          result.push(seg); // No road hit — keep original
        }
      }
      return result;
    };

    const crossBefore = allCross.length, parBeforeClip = allParallel.length;
    const clippedCross = clipSegments(allCross);
    const clippedParallel = clipSegments(allParallel);
    allCross.length = 0; allCross.push(...clippedCross);
    allParallel.length = 0; allParallel.push(...clippedParallel);
    if (crossBefore !== allCross.length || parBeforeClip !== allParallel.length) {
      console.log(`    Clipped at roads: cross ${crossBefore}->${allCross.length}, parallel ${parBeforeClip}->${allParallel.length}`);
    }
  }

  if (parallelsBefore !== allParallel.length) {
    console.log(`    Parallel separation filter: ${parallelsBefore}->${allParallel.length}`);
  }

  // 3. Remove self-crossings between k3 streets from different faces.
  // For each pair of crossing segments, remove the shorter one.
  function segIntersect(a0, a1, b0, b1) {
    const dax = a1.x - a0.x, daz = a1.z - a0.z;
    const dbx = b1.x - b0.x, dbz = b1.z - b0.z;
    const det = dax * dbz - daz * dbx;
    if (Math.abs(det) < 1e-10) return false;
    const dx = b0.x - a0.x, dz = b0.z - a0.z;
    const t = (dx * dbz - dz * dbx) / det;
    const u = (dx * daz - dz * dax) / det;
    return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
  }

  const allK3 = [...allCross, ...allParallel];
  const toRemoveCross = new Set();
  const toRemoveParallel = new Set();

  for (let i = 0; i < allK3.length; i++) {
    for (let j = i + 1; j < allK3.length; j++) {
      if (segIntersect(allK3[i][0], allK3[i][1], allK3[j][0], allK3[j][1])) {
        // Remove the shorter segment
        const lenI = Math.hypot(allK3[i][1].x - allK3[i][0].x, allK3[i][1].z - allK3[i][0].z);
        const lenJ = Math.hypot(allK3[j][1].x - allK3[j][0].x, allK3[j][1].z - allK3[j][0].z);
        const removeIdx = lenI < lenJ ? i : j;
        if (removeIdx < allCross.length) toRemoveCross.add(removeIdx);
        else toRemoveParallel.add(removeIdx - allCross.length);
      }
    }
  }

  if (toRemoveCross.size > 0 || toRemoveParallel.size > 0) {
    const crossBefore2 = allCross.length, parBefore2 = allParallel.length;
    for (let i = allCross.length - 1; i >= 0; i--) { if (toRemoveCross.has(i)) allCross.splice(i, 1); }
    for (let i = allParallel.length - 1; i >= 0; i--) { if (toRemoveParallel.has(i)) allParallel.splice(i, 1); }
    console.log(`    Self-crossing filter: cross ${crossBefore2}->${allCross.length}, parallel ${parBefore2}->${allParallel.length}`);
  }

  console.log(`  k3: ${allCross.length} cross streets, ${allParallel.length} parallel streets, ${allJunctions.length} junctions`);
  for (const s of faceStats) {
    console.log(`    Face ${s.fi} band=${s.band} cells=${s.cells} cross=${s.cross} parallel=${s.parallel}`);
  }

  // Compute coverage ratio: zone cells that have a street nearby
  const streetCells = new Set();
  for (const seg of [...allCross, ...allParallel]) {
    const x0 = Math.round((seg[0].x - ox) / cs);
    const z0 = Math.round((seg[0].z - oz) / cs);
    const x1 = Math.round((seg[1].x - ox) / cs);
    const z1 = Math.round((seg[1].z - oz) / cs);
    // Walk Bresenham to mark cells
    const dx = Math.abs(x1 - x0), dy = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sy = z0 < z1 ? 1 : -1;
    let err = dx - dy, x = x0, y = z0;
    for (let i = 0; i < dx + dy + 2; i++) {
      if (x >= 0 && x < W && y >= 0 && y < H) streetCells.add(y * W + x);
      if (x === x1 && y === z1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }
  let coveredCount = 0;
  for (const c of zone.cells) {
    if (streetCells.has(c.gz * W + c.gx)) coveredCount++;
  }
  const coverageRatio = zone.cells.length > 0 ? coveredCount / zone.cells.length : 0;
  console.log(`  Coverage ratio: ${(coverageRatio * 100).toFixed(1)}% (${coveredCount}/${zone.cells.length} cells on streets)`);

  totalCross += allCross.length;
  totalParallel += allParallel.length;
  zoneResults.push({
    zi,
    cells: zone.cells.length,
    avgSlope: zone.avgSlope,
    faces: faces.length,
    cross: allCross.length,
    parallel: allParallel.length,
    coverageRatio,
  });

  // ===== Render (cropped to zone) =====
  const pixels = new Uint8Array(cropW * cropH * 3);

  // Terrain base
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const v = (elev.get(gx2, gz2) - eBounds.min) / eRange;
      const idx = (z * cropW + x) * 3;
      if (waterMask && waterMask.get(gx2, gz2) > 0) {
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
      } else {
        pixels[idx] = Math.round(35 + v * 50);
        pixels[idx + 1] = Math.round(45 + v * 40);
        pixels[idx + 2] = Math.round(25 + v * 25);
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
        pixels[idx] = tr; pixels[idx + 1] = tg; pixels[idx + 2] = tb;
      }
    }
  }

  // Face boundaries (faint white)
  for (let fi = 0; fi < faces.length; fi++) {
    const faceSet = new Set(faces[fi].cells.map(c => c.gz * W + c.gx));
    for (const c of faces[fi].cells) {
      let isBoundary = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!faceSet.has((c.gz + dz) * W + (c.gx + dx))) { isBoundary = true; break; }
      }
      if (!isBoundary) continue;
      const x = c.gx - minGx, z = c.gz - minGz;
      if (x >= 0 && x < cropW && z >= 0 && z < cropH) {
        const idx = (z * cropW + x) * 3;
        pixels[idx] = 180; pixels[idx + 1] = 180; pixels[idx + 2] = 180;
      }
    }
  }

  // Roads (light gray)
  if (roadGrid) {
    for (let z = 0; z < cropH; z++)
      for (let x = 0; x < cropW; x++)
        if (roadGrid.get(x + minGx, z + minGz) > 0) {
          const idx = (z * cropW + x) * 3;
          pixels[idx] = 150; pixels[idx + 1] = 150; pixels[idx + 2] = 150;
        }
  }

  // Zone boundary (yellow)
  if (zone.boundary) {
    for (let i = 0; i < zone.boundary.length; i++) {
      const p1 = zone.boundary[i], p2 = zone.boundary[(i + 1) % zone.boundary.length];
      bres(pixels, cropW, cropH,
        Math.round((p1.x - ox) / cs) - minGx, Math.round((p1.z - oz) / cs) - minGz,
        Math.round((p2.x - ox) / cs) - minGx, Math.round((p2.z - oz) / cs) - minGz,
        200, 200, 0);
    }
  }

  // k3 cross streets (magenta)
  for (const seg of allCross) {
    bres(pixels, cropW, cropH,
      Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
      Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
      255, 0, 255);
  }

  // k3 parallel streets (cyan)
  for (const seg of allParallel) {
    bres(pixels, cropW, cropH,
      Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
      Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
      0, 220, 220);
  }

  // Junction dots (white, 3px)
  for (const j of allJunctions) {
    const jx = Math.round((j.x - ox) / cs) - minGx;
    const jz = Math.round((j.z - oz) / cs) - minGz;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (jx + dx >= 0 && jx + dx < cropW && jz + dz >= 0 && jz + dz < cropH) {
          const idx = ((jz + dz) * cropW + (jx + dx)) * 3;
          pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
        }
  }

  // === Write output ===
  const header = `P6\n${cropW} ${cropH}\n255\n`;
  const basePath = `${outDir}/k3-zone${zi}-seed${seed}`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
  console.log(`  Written to ${basePath}.png (${cropW}x${cropH})`);
}

// ===== Summary =====
console.log(`\n=== Summary ===`);
console.log(`Total zones rendered: ${zoneResults.length}`);
console.log(`Total cross streets: ${totalCross}`);
console.log(`Total parallel streets: ${totalParallel}`);
const zeroOutput = zoneResults.filter(r => r.cross === 0 && r.parallel === 0);
if (zeroOutput.length > 0) {
  console.log(`Zones with zero output: ${zeroOutput.map(r => `zone${r.zi}`).join(', ')}`);
} else {
  console.log(`All zones produced output.`);
}
for (const r of zoneResults) {
  console.log(`  Zone ${r.zi}: cells=${r.cells} avgSlope=${r.avgSlope.toFixed(3)} faces=${r.faces} cross=${r.cross} parallel=${r.parallel} coverage=${(r.coverageRatio * 100).toFixed(1)}%`);
}
console.log(`Total time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// === Bresenham line draw ===
function bres(pixels, w, h, x0, y0, x1, y1, r, g, b) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (let i = 0; i < dx + dy + 2; i++) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (y * w + x) * 3;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
