#!/usr/bin/env bun
/**
 * Experiment 007s6 — Most perpendicular pair of triangle edges:
 *
 * 1. k3-style organic terrain-following streets (gradient cross streets +
 *    distance-indexed parallels)
 * 2. s2-style geometric construction lines between anchor roads
 *
 * Uses the k3 zone selection (large zone near center with slope data).
 * After computing k3's terrain faces and streets, also finds two anchor
 * roads near the zone boundary and computes s2-style construction geometry.
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
import { runToStep } from './pipeline-utils.js';

const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007s6-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
runToStep(strategy, 'spatial');

createZoneBoundaryRoads(map);
subdivideLargeZones(map);
extractZones(map);

const zones = map.developmentZones;
const W = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');
const roadGrid = map.getLayer('roadGrid');

// ===== Zone selection (same as k3) — medium-large, near centre, has slope data =====
const candidates = zones.filter(z =>
  z.cells.length > 2000 && z.cells.length < 50000 &&
  z.boundary && z.boundary.length >= 4 && z.avgSlope !== undefined
);
candidates.sort((a, b) => {
  const ad = Math.abs(a.centroidGx - W / 2) + Math.abs(a.centroidGz - H / 2);
  const bd = Math.abs(b.centroidGx - W / 2) + Math.abs(b.centroidGz - H / 2);
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

// ===== k3: Terrain face segmentation =====
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

console.log(`${faces.length} terrain faces`);

// ===== k3: Distance-indexed junction layout =====
const CROSS_SPACING = 90;
const PARALLEL_SPACING = 35;
const MIN_STREET_LEN = 20;

const allCross = [];
const allParallel = [];
const allJunctions = [];
const faceTints = [[60, 100, 60], [60, 60, 100], [100, 80, 50], [80, 60, 100], [60, 100, 100], [100, 60, 80]];

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
    const junctionMap = new Map();
    const profile = bestRun;
    let distAccum = 0;
    let pointIndex = 0;

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
      junctionMap.set(pointIndex, { x: pt.wx, z: pt.wz });
      pointIndex++;
    }

    crossStreets.push({ ctOff, start: segStart, end: segEnd, junctionMap });
  }

  // Connect matching distance indices between adjacent cross streets
  crossStreets.sort((a, b) => a.ctOff - b.ctOff);

  let faceCross = crossStreets.length;
  let faceParallel = 0;

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

console.log(`k3: ${allCross.length} cross streets, ${allParallel.length} parallel streets, ${allJunctions.length} junction points`);
console.log('Face breakdown:');
for (const s of faceStats) {
  console.log(`  Face ${s.fi} band=${s.band} cells=${s.cells} cross=${s.cross} parallel=${s.parallel}`);
}

// ===== s2: Find two anchor roads from zone boundary =====
//
// Find the 3 boundary vertices that form the largest triangle. The two longest
// sides of that triangle are the anchor roads. This avoids issues with DP
// splitting edges at boundary zigzags.

const b = zone.boundary;

// Sample boundary at regular intervals to keep the search fast
const sampleStep = Math.max(1, Math.floor(b.length / 200));
const samples = [];
for (let i = 0; i < b.length; i += sampleStep) {
  samples.push({ x: b[i].x, z: b[i].z, idx: i });
}

// Find 3 points that maximize triangle area
let bestArea = 0;
let bestTri = [0, 1, 2];
for (let i = 0; i < samples.length; i++) {
  for (let j = i + 1; j < samples.length; j++) {
    for (let k = j + 1; k < samples.length; k++) {
      const area = Math.abs(
        (samples[j].x - samples[i].x) * (samples[k].z - samples[i].z) -
        (samples[k].x - samples[i].x) * (samples[j].z - samples[i].z)
      );
      if (area > bestArea) {
        bestArea = area;
        bestTri = [i, j, k];
      }
    }
  }
}

const corners = bestTri.map(i => samples[i]);

// Build 3 triangle edges by walking the boundary between corners.
// The boundary path between corners IS the road — no fitting needed.
const triEdges = [];
for (let i = 0; i < 3; i++) {
  const idx1 = corners[i].idx, idx2 = corners[(i + 1) % 3].idx;

  // Walk boundary from idx1 to idx2 (forward around the polygon)
  const edgePts = [];
  let ci = idx1;
  while (true) {
    edgePts.push({ x: b[ci].x, z: b[ci].z });
    if (ci === idx2) break;
    ci = (ci + 1) % b.length;
    if (edgePts.length > b.length) break; // safety
  }

  // Chord from first to last point for direction/angle
  const first = edgePts[0], last = edgePts[edgePts.length - 1];
  const dx = last.x - first.x, dz = last.z - first.z;
  const chordLen = Math.sqrt(dx * dx + dz * dz);

  triEdges.push({
    points: edgePts,
    length: chordLen,
    angle: Math.atan2(dz, dx) * 180 / Math.PI,
    start: first,
    end: last,
  });
}

// Pick the pair with the largest angle difference (closest to 90°)
let bestPair = [0, 1], bestAngleScore = 0;
for (let i = 0; i < triEdges.length; i++) {
  for (let j = i + 1; j < triEdges.length; j++) {
    const diff = Math.abs(triEdges[i].angle - triEdges[j].angle);
    const norm = diff > 90 ? 180 - diff : diff;
    // Score: how close to 90° the angle is, weighted by combined length
    const angleScore = (90 - Math.abs(norm - 90)) * (triEdges[i].length + triEdges[j].length);
    if (angleScore > bestAngleScore) {
      bestAngleScore = angleScore;
      bestPair = [i, j];
    }
  }
}
let edges = [triEdges[bestPair[0]], triEdges[bestPair[1]]];
console.log(`  Best pair angle diff: ${Math.abs(edges[0].angle - edges[1].angle).toFixed(0)}°`);

// Add direction and perpendicular vectors
edges = edges.map(e => {
  const dx = e.end.x - e.start.x, dz = e.end.z - e.start.z;
  const len = e.length || 1;
  return {
    ...e,
    dir: { x: dx / len, z: dz / len },
    perp: { x: -dz / len, z: dx / len },
  };
});

let hasS2 = edges.length >= 2;

let s2CrossStreets = [];
let s2ParallelStreets = [];
let farA, farB, nearA, nearB, apex, perpLenA, perpLenB;

if (hasS2) {
  console.log(`\ns2: Largest triangle from ${samples.length} boundary samples`);
  console.log(`  Anchor A: ${edges[0].points.length} pts, angle ${edges[0].angle.toFixed(0)}°, length ${edges[0].length.toFixed(0)}m`);
  console.log(`  Anchor B: ${edges[1].points.length} pts, angle ${edges[1].angle.toFixed(0)}°, length ${edges[1].length.toFixed(0)}m`);

  // Ensure perpendiculars point inward (toward zone centroid)
  const centX = ox + zone.centroidGx * cs;
  const centZ = oz + zone.centroidGz * cs;

  for (const edge of edges) {
    const midX = (edge.points[0].x + edge.points[edge.points.length - 1].x) / 2;
    const midZ = (edge.points[0].z + edge.points[edge.points.length - 1].z) / 2;
    const toCentX = centX - midX, toCentZ = centZ - midZ;
    const dot = edge.perp.x * toCentX + edge.perp.z * toCentZ;
    if (dot < 0) {
      edge.perp.x = -edge.perp.x;
      edge.perp.z = -edge.perp.z;
    }
  }

  // Find where the two anchor road LINES intersect (virtual intersection)
  const A0 = edges[0].points[0];
  const B0 = edges[1].points[0];
  const dA = edges[0].dir, dB = edges[1].dir;
  const det = dA.x * (-dB.z) - dA.z * (-dB.x);
  let roadIntersection;

  if (Math.abs(det) > 0.001) {
    const dmx = B0.x - A0.x, dmz = B0.z - A0.z;
    const t = (dmx * (-dB.z) - dmz * (-dB.x)) / det;
    roadIntersection = { x: A0.x + t * dA.x, z: A0.z + t * dA.z };
    console.log(`  Road lines intersect at (${roadIntersection.x.toFixed(0)}, ${roadIntersection.z.toFixed(0)})`);
  } else {
    roadIntersection = { x: centX, z: centZ };
    console.log(`  Roads are parallel — using centroid`);
  }

  // Find point on each edge furthest from the intersection
  function furthestFromPoint(edgePts, px, pz) {
    let maxDist = 0, best = edgePts[0];
    for (const p of edgePts) {
      const d = Math.sqrt((p.x - px) ** 2 + (p.z - pz) ** 2);
      if (d > maxDist) { maxDist = d; best = p; }
    }
    return { point: best, dist: maxDist };
  }

  // Find point on each edge nearest to the intersection
  function closestToPoint(edgePts, px, pz) {
    let minDist = Infinity, best = edgePts[0];
    for (const p of edgePts) {
      const d = Math.sqrt((p.x - px) ** 2 + (p.z - pz) ** 2);
      if (d < minDist) { minDist = d; best = p; }
    }
    return { point: best, dist: minDist };
  }

  farA = furthestFromPoint(edges[0].points, roadIntersection.x, roadIntersection.z);
  farB = furthestFromPoint(edges[1].points, roadIntersection.x, roadIntersection.z);
  nearA = closestToPoint(edges[0].points, roadIntersection.x, roadIntersection.z);
  nearB = closestToPoint(edges[1].points, roadIntersection.x, roadIntersection.z);

  console.log(`  Furthest on A: dist=${farA.dist.toFixed(0)}m`);
  console.log(`  Furthest on B: dist=${farB.dist.toFixed(0)}m`);
  console.log(`  nearA dist=${nearA.dist.toFixed(0)}m, nearB dist=${nearB.dist.toFixed(0)}m`);

  // Find where perpendicular lines from far points intersect (apex)
  const pA = edges[0].perp, pB = edges[1].perp;
  const detPerp = pA.x * (-pB.z) - pA.z * (-pB.x);

  if (Math.abs(detPerp) > 0.001) {
    const dmx = farB.point.x - farA.point.x, dmz = farB.point.z - farA.point.z;
    const t = (dmx * (-pB.z) - dmz * (-pB.x)) / detPerp;
    apex = { x: farA.point.x + t * pA.x, z: farA.point.z + t * pA.z };
  } else {
    apex = { x: centX, z: centZ };
  }

  perpLenA = Math.sqrt((apex.x - farA.point.x) ** 2 + (apex.z - farA.point.z) ** 2);
  perpLenB = Math.sqrt((apex.x - farB.point.x) ** 2 + (apex.z - farB.point.z) ** 2);
  console.log(`  Apex at (${apex.x.toFixed(0)}, ${apex.z.toFixed(0)}), perpA=${perpLenA.toFixed(0)}m, perpB=${perpLenB.toFixed(0)}m`);

  // Subdivide perpendiculars and connect to opposite roads
  function subdivide(from, to, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push({ x: from.x + t * (to.x - from.x), z: from.z + t * (to.z - from.z) });
    }
    return pts;
  }

  const STREET_SPACING = 40;

  // Subdivide perpA (farA -> apex) and road B (nearB -> farB)
  const stepsA = Math.max(3, Math.round(perpLenA / STREET_SPACING));
  const perpAPts = subdivide(farA.point, apex, stepsA);
  const roadBPts = subdivide(nearB.point, farB.point, stepsA);

  // Subdivide perpB (farB -> apex) and road A (nearA -> farA)
  const stepsB = Math.max(3, Math.round(perpLenB / STREET_SPACING));
  const perpBPts = subdivide(farB.point, apex, stepsB);
  const roadAPts = subdivide(nearA.point, farA.point, stepsB);

  // Set A: perpA subdivisions -> road B points
  for (let i = 0; i <= stepsA; i++) {
    s2CrossStreets.push([perpAPts[i], roadBPts[i]]);
  }

  // Set B: perpB subdivisions -> road A points
  for (let i = 0; i <= stepsB; i++) {
    s2ParallelStreets.push([perpBPts[i], roadAPts[i]]);
  }

  console.log(`  s2: ${s2CrossStreets.length} set A lines (perpA->roadB), ${s2ParallelStreets.length} set B lines (perpB->roadA)`);
} else {
  console.log(`\ns2: Only ${edges.length} suitable roads found (need 2) — skipping s2 overlay`);
}

// ===== Render (cropped to zone, same style as k3) =====

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

// Zone boundary (yellow, 1px)
if (zone.boundary) {
  for (let i = 0; i < zone.boundary.length; i++) {
    const p1 = zone.boundary[i], p2 = zone.boundary[(i + 1) % zone.boundary.length];
    bres(pixels, cropW, cropH,
      Math.round((p1.x - ox) / cs) - minGx, Math.round((p1.z - oz) / cs) - minGz,
      Math.round((p2.x - ox) / cs) - minGx, Math.round((p2.z - oz) / cs) - minGz,
      200, 200, 0);
  }
}

// k3 cross streets (magenta, 1px)
for (const seg of allCross) {
  bres(pixels, cropW, cropH,
    Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
    Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
    255, 0, 255);
}

// k3 parallel streets (cyan, 1px)
for (const seg of allParallel) {
  bres(pixels, cropW, cropH,
    Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
    Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
    0, 220, 220);
}

// s2 layers (only if we found two anchor roads)
if (hasS2) {
  // s2 set A lines: perpA -> roadB (yellow-green, rgb 200,220,0, 1px)
  for (const [a, b] of s2CrossStreets) {
    bres(pixels, cropW, cropH,
      Math.round((a.x - ox) / cs) - minGx, Math.round((a.z - oz) / cs) - minGz,
      Math.round((b.x - ox) / cs) - minGx, Math.round((b.z - oz) / cs) - minGz,
      200, 220, 0);
  }

  // s2 set B lines: perpB -> roadA (orange, rgb 255,140,0, 1px)
  for (const [a, b] of s2ParallelStreets) {
    bres(pixels, cropW, cropH,
      Math.round((a.x - ox) / cs) - minGx, Math.round((a.z - oz) / cs) - minGz,
      Math.round((b.x - ox) / cs) - minGx, Math.round((b.z - oz) / cs) - minGz,
      255, 140, 0);
  }

  // Construction lines: perpA and perpB (bright green, 1px)
  bres(pixels, cropW, cropH,
    Math.round((farA.point.x - ox) / cs) - minGx, Math.round((farA.point.z - oz) / cs) - minGz,
    Math.round((apex.x - ox) / cs) - minGx, Math.round((apex.z - oz) / cs) - minGz,
    0, 255, 0);
  bres(pixels, cropW, cropH,
    Math.round((farB.point.x - ox) / cs) - minGx, Math.round((farB.point.z - oz) / cs) - minGz,
    Math.round((apex.x - ox) / cs) - minGx, Math.round((apex.z - oz) / cs) - minGz,
    0, 255, 0);

  // Apex (bright green dot, 5px)
  {
    const ax = Math.round((apex.x - ox) / cs) - minGx;
    const az = Math.round((apex.z - oz) / cs) - minGz;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++)
        if (ax + dx >= 0 && ax + dx < cropW && az + dz >= 0 && az + dz < cropH) {
          const idx = ((az + dz) * cropW + (ax + dx)) * 3;
          pixels[idx] = 0; pixels[idx + 1] = 255; pixels[idx + 2] = 0;
        }
  }

  // Far points on edges (white dots, 5px)
  for (const p of [farA.point, farB.point]) {
    const x = Math.round((p.x - ox) / cs) - minGx;
    const z = Math.round((p.z - oz) / cs) - minGz;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++)
        if (x + dx >= 0 && x + dx < cropW && z + dz >= 0 && z + dz < cropH) {
          const idx = ((z + dz) * cropW + (x + dx)) * 3;
          pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
        }
  }

  // Near points on edges (orange dots, 5px)
  for (const p of [nearA.point, nearB.point]) {
    const x = Math.round((p.x - ox) / cs) - minGx;
    const z = Math.round((p.z - oz) / cs) - minGz;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++)
        if (x + dx >= 0 && x + dx < cropW && z + dz >= 0 && z + dz < cropH) {
          const idx = ((z + dz) * cropW + (x + dx)) * 3;
          pixels[idx] = 255; pixels[idx + 1] = 140; pixels[idx + 2] = 0;
        }
  }
}

// Anchor roads drawn LAST in thick white/yellow so they're unmissable
if (hasS2) {
  // Helper: draw a thick line (radius r pixels)
  function thickLine(px, w, h, x0, y0, x1, y1, r, g, b2, radius) {
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++)
        bres(px, w, h, x0+dx, y0+dy, x1+dx, y1+dy, r, g, b2);
  }

  // Draw anchor roads through their boundary points (not just start→end chord)
  function drawAnchorRoad(pts, r, g, b2, radius) {
    for (let i = 0; i < pts.length - 1; i++) {
      thickLine(pixels, cropW, cropH,
        Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
        Math.round((pts[i+1].x - ox) / cs) - minGx, Math.round((pts[i+1].z - oz) / cs) - minGz,
        r, g, b2, radius);
    }
  }

  // Anchor road A: thick white
  drawAnchorRoad(edges[0].points, 255, 255, 255, 2);
  // Anchor road B: thick bright yellow
  drawAnchorRoad(edges[1].points, 255, 255, 0, 2);
}

// === Write output ===
const header = `P6\n${cropW} ${cropH}\n255\n`;
const basePath = `${outDir}/ribbon-zone-zoomed-seed${seed}`;
writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
console.log(`\nWritten to ${basePath}.png (${cropW}x${cropH})`);
console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

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
