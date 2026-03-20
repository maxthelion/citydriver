#!/usr/bin/env bun
/**
 * Experiment 007m — Cross streets from anchor road junctions.
 *
 * Real streets leave main roads at right angles, then curve to follow terrain.
 * This experiment replicates that pattern:
 *
 * For each terrain face:
 *  1. Find nearby arterial/collector road segments from map.roads.
 *  2. Sample starting points along those segments at CROSS_SPACING (90m) intervals.
 *  3. From each starting point, walk into the face:
 *       - Direction at start = perpendicular to the road segment.
 *       - Direction at distance d = normalize((1-blend)*roadPerp + blend*gradientDir)
 *         where blend = min(1, d / BLEND_DIST) transitions from perpendicular to
 *         gradient-following over BLEND_DIST = 200m.
 *       - At each step, pick the 8-connected in-face neighbour that best matches
 *         the blended direction.
 *       - Stop when leaving the face or exceeding MAX_STEPS.
 *  4. These walks become the cross streets — straight off the road, curving uphill.
 *  5. Mark PARALLEL_SPACING junction points along each walk, keyed by integer
 *     multiple of PARALLEL_SPACING.
 *  6. Connect corresponding junction points between adjacent walks → parallel streets.
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
const gx   = parseInt(process.argv[3]) || 27;
const gz   = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007m-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const CROSS_SPACING    = 90;   // metres between starting points along anchor road
const PARALLEL_SPACING = 35;   // metres between parallel street junction points
const BLEND_DIST       = 200;  // metres to fully blend from perpendicular to gradient
const MAX_STEPS        = 600;  // safety cap on walk length
const ANCHOR_RADIUS    = 400;  // metres — search for roads within this distance of face centroid
const MIN_STREET_LEN   = 15;   // metres — skip degenerate walks

console.log(`007m render-ribbon-from-road: seed=${seed} gx=${gx} gz=${gz}`);
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

// Pick a medium-large zone near the centre with slope data
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

// Build zone bounding box for cropped render
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

const bandGrid = new Int8Array(W * H).fill(-1);
for (const c of zone.cells) {
  const e = elev.get(c.gx, c.gz);
  let band = 0;
  for (const t of thresholds) { if (e >= t) band++; }
  bandGrid[c.gz * W + c.gx] = band;
}

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

// ===== Identify anchor roads (arterial or collector) =====
const anchorRoads = (map.roads || []).filter(r =>
  r.polyline && r.polyline.length >= 2 &&
  (r.hierarchy === 'arterial' || r.hierarchy === 'collector')
);
console.log(`${anchorRoads.length} anchor roads (arterial/collector)`);

// ===== Helpers =====

/** Squared distance from point (px,pz) to line segment (ax,az)-(bx,bz). */
function ptSegDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx*dx + dz*dz;
  if (lenSq === 0) return (px-ax)**2 + (pz-az)**2;
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (pz-az)*dz) / lenSq));
  return (px - (ax + t*dx))**2 + (pz - (az + t*dz))**2;
}


const NEIGHBOURS_8 = [
  [-1,-1],[0,-1],[1,-1],
  [-1, 0],       [1, 0],
  [-1, 1],[0, 1],[1, 1],
];

// ===== Main loop: process each face =====
const allCross    = [];  // arrays of {x,z} world-coord polyline points
const allParallel = [];  // [{x,z},{x,z}] pairs
const allStartPts = [];  // {x,z} red dots — starting points on road
const anchorSegs  = [];  // [{x,z},{x,z}] white highlighted anchor segments near faces

const faceTints = [[60,100,60],[60,60,100],[100,80,50],[80,60,100],[60,100,100],[100,60,80]];
const faceStats = [];

for (let fi = 0; fi < faces.length; fi++) {
  const face = faces[fi];
  const faceSet = new Set(face.cells.map(c => c.gz * W + c.gx));

  // --- Compute face centroid in world coords ---
  let cxSum = 0, czSum = 0;
  for (const c of face.cells) { cxSum += c.gx; czSum += c.gz; }
  const faceCx = ox + (cxSum / face.cells.length) * cs;
  const faceCz = oz + (czSum / face.cells.length) * cs;

  // --- Compute face gradient direction (uphill) ---
  let sumDx = 0, sumDz = 0, gradCount = 0;
  for (const c of face.cells) {
    const eC = elev.get(c.gx, c.gz);
    const eE = faceSet.has(c.gz * W + (c.gx + 1)) ? elev.get(c.gx + 1, c.gz) : eC;
    const eW = faceSet.has(c.gz * W + (c.gx - 1)) ? elev.get(c.gx - 1, c.gz) : eC;
    const gxd = (eE - eW) / (2 * cs);
    const eSouth = faceSet.has((c.gz + 1) * W + c.gx) ? elev.get(c.gx, c.gz + 1) : eC;
    const eNorth = faceSet.has((c.gz - 1) * W + c.gx) ? elev.get(c.gx, c.gz - 1) : eC;
    const gzd = (eSouth - eNorth) / (2 * cs);
    sumDx += gxd; sumDz += gzd; gradCount++;
  }

  let gradX = 0, gradZ = 0;
  if (gradCount > 0) {
    gradX = sumDx / gradCount;
    gradZ = sumDz / gradCount;
    const mag = Math.sqrt(gradX*gradX + gradZ*gradZ);
    if (mag > 1e-6) { gradX /= mag; gradZ /= mag; }
    else if (zone.slopeDir) { gradX = zone.slopeDir.x; gradZ = zone.slopeDir.z; }
    else continue;
  } else continue;

  // --- Find anchor road segments near this face ---
  // Collect all segments within ANCHOR_RADIUS of the face centroid,
  // then keep only those belonging to the nearest road (by ID).
  // This prevents multiple overlapping roads from spawning redundant walks.
  let bestRoadDist = Infinity;
  let bestRoadId = null;

  for (const road of anchorRoads) {
    const pts = road.polyline;
    for (let si = 0; si < pts.length - 1; si++) {
      const p0 = pts[si], p1 = pts[si + 1];
      const distSq = ptSegDistSq(faceCx, faceCz, p0.x, p0.z, p1.x, p1.z);
      if (distSq >= ANCHOR_RADIUS * ANCHOR_RADIUS) continue;
      const dist = Math.sqrt(distSq);
      if (dist < bestRoadDist) {
        bestRoadDist = dist;
        bestRoadId = road.id;
      }
    }
  }

  if (bestRoadId === null) continue;

  // Collect segments from the nearest road that are within ANCHOR_RADIUS
  const nearSegments = [];
  for (const road of anchorRoads) {
    if (road.id !== bestRoadId) continue;
    const pts = road.polyline;
    for (let si = 0; si < pts.length - 1; si++) {
      const p0 = pts[si], p1 = pts[si + 1];
      const distSq = ptSegDistSq(faceCx, faceCz, p0.x, p0.z, p1.x, p1.z);
      if (distSq >= ANCHOR_RADIUS * ANCHOR_RADIUS) continue;

      const dx = p1.x - p0.x, dz = p1.z - p0.z;
      const len = Math.sqrt(dx*dx + dz*dz);
      if (len < 1e-6) continue;

      let perpX = -dz/len, perpZ = dx/len;

      // Orient perpendicular toward face centroid
      const midX = (p0.x + p1.x) * 0.5;
      const midZ = (p0.z + p1.z) * 0.5;
      const toCentX = faceCx - midX, toCentZ = faceCz - midZ;
      if (perpX * toCentX + perpZ * toCentZ < 0) {
        perpX = -perpX; perpZ = -perpZ;
      }

      nearSegments.push({ p0, p1, perpX, perpZ, roadId: road.id });
      anchorSegs.push([{ x: p0.x, z: p0.z }, { x: p1.x, z: p1.z }]);
    }
  }

  if (nearSegments.length === 0) continue;

  // --- Sample starting points from each nearby segment ---
  // Contour axis for this face (perpendicular to gradient = along contour)
  const ctX = -gradZ, ctZ = gradX;

  // Accumulate all walks first, then group for parallel streets.
  const allWalksThisFace = []; // {startPt, polyline, junctions: [{grOff, x, z}]}

  // Collect all road sample points from all nearby segments.
  // Deduplicate them by contour-axis bucket (at CROSS_SPACING resolution)
  // so we don't spawn overlapping walks from adjacent road segments.
  const contourBucketUsed = new Set(); // buckets along the contour axis at CROSS_SPACING intervals
  const usedStartCells = new Set();    // face entry cells (fine dedup)

  for (const seg of nearSegments) {
    const { p0, p1, perpX, perpZ } = seg;
    const samples = sampleAlongSegment(p0, p1, CROSS_SPACING);

    for (const sp of samples) {
      // Deduplicate by contour-axis bucket: bin road sample point into CROSS_SPACING slots
      const contourProj = sp.x * ctX + sp.z * ctZ;
      const bucket = Math.round(contourProj / CROSS_SPACING);
      if (contourBucketUsed.has(bucket)) continue;
      contourBucketUsed.add(bucket);

      // Project along perpendicular from road to find face entry point
      const entryPt = findFaceEntry(sp.x, sp.z, perpX, perpZ, faceSet);
      if (!entryPt) continue;

      // Deduplicate by entry cell (fine guard)
      const egx = Math.round((entryPt.x - ox) / cs);
      const egz = Math.round((entryPt.z - oz) / cs);
      const cellKey = egz * W + egx;
      if (usedStartCells.has(cellKey)) continue;
      usedStartCells.add(cellKey);

      // Record the road sample point as red dot
      allStartPts.push({ x: sp.x, z: sp.z });

      // Walk from the face entry point
      const polyline = walkFromRoad(
        entryPt.x, entryPt.z, perpX, perpZ, gradX, gradZ, faceSet
      );

      if (polyline.length < 2) continue;

      // Compute total arc length and mark PARALLEL_SPACING junction points
      const lens = [0];
      for (let i = 1; i < polyline.length; i++) {
        const dx = polyline[i].x - polyline[i-1].x;
        const dz = polyline[i].z - polyline[i-1].z;
        lens.push(lens[i-1] + Math.sqrt(dx*dx + dz*dz));
      }
      const totalLen = lens[lens.length - 1];
      if (totalLen < MIN_STREET_LEN) continue;

      const junctions = [];
      for (let d = PARALLEL_SPACING; d <= totalLen + 1e-6; d += PARALLEL_SPACING) {
        const pt = samplePolyline(polyline, lens, d);
        junctions.push({ grOff: Math.round(d / PARALLEL_SPACING) * PARALLEL_SPACING, ...pt });
      }

      // Use entry point for contour-axis sorting (road point for red dot)
      allWalksThisFace.push({ startPt: entryPt, roadPt: sp, polyline, junctions, perpX, perpZ });

      // Store cross street for rendering (as polyline segments)
      for (let i = 0; i < polyline.length - 1; i++) {
        allCross.push([polyline[i], polyline[i+1]]);
      }
    }
  }

  // --- Connect adjacent walks to form parallel streets ---
  // Sort walks by their starting point projected onto the contour axis.
  allWalksThisFace.sort((a, b) => {
    const projA = a.startPt.x * ctX + a.startPt.z * ctZ;
    const projB = b.startPt.x * ctX + b.startPt.z * ctZ;
    return projA - projB;
  });

  let faceParallel = 0;
  for (let k = 0; k < allWalksThisFace.length - 1; k++) {
    const walkA = allWalksThisFace[k];
    const walkB = allWalksThisFace[k + 1];

    // Check walks are adjacent along the contour axis (perpendicular to gradient).
    // Two walks are adjacent if their contour-axis projections are within ~CROSS_SPACING * 2.
    const projA = walkA.startPt.x * ctX + walkA.startPt.z * ctZ;
    const projB = walkB.startPt.x * ctX + walkB.startPt.z * ctZ;
    if (Math.abs(projA - projB) > CROSS_SPACING * 2) continue;

    const mapA = new Map(walkA.junctions.map(j => [j.grOff, j]));
    const mapB = new Map(walkB.junctions.map(j => [j.grOff, j]));

    for (const [grOff, pA] of mapA) {
      const pB = mapB.get(grOff);
      if (!pB) continue;
      const segLen = Math.sqrt((pB.x - pA.x)**2 + (pB.z - pA.z)**2);
      if (segLen < MIN_STREET_LEN) continue;
      allParallel.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
      faceParallel++;
    }
  }

  faceStats.push({
    fi, band: face.band, cells: face.cells.length,
    walks: allWalksThisFace.length, parallel: faceParallel,
  });
}

console.log(`${allCross.length} cross street segments, ${allParallel.length} parallel streets`);
console.log(`${allStartPts.length} starting points on roads`);
console.log('Face breakdown:');
for (const s of faceStats) {
  console.log(`  Face ${s.fi} band=${s.band} cells=${s.cells} walks=${s.walks} parallel=${s.parallel}`);
}

// ===== Find face entry point =====
/**
 * From (startX, startZ) on the road, march along perpendicular direction
 * until we step onto a face cell (in faceSet). Returns {x,z} of entry cell,
 * or null if no face cell found within ANCHOR_RADIUS.
 */
function findFaceEntry(startX, startZ, perpX, perpZ, faceSet) {
  // Check if start cell is already in face
  const s0gx = Math.round((startX - ox) / cs);
  const s0gz = Math.round((startZ - oz) / cs);
  if (faceSet.has(s0gz * W + s0gx)) {
    return { x: ox + s0gx * cs, z: oz + s0gz * cs };
  }

  // March along perpendicular at half-cell steps
  const step = cs * 0.5;
  const maxSteps = Math.ceil(ANCHOR_RADIUS / step);

  for (let i = 1; i <= maxSteps; i++) {
    const wx = startX + perpX * i * step;
    const wz = startZ + perpZ * i * step;
    const cgx = Math.round((wx - ox) / cs);
    const cgz = Math.round((wz - oz) / cs);
    if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) break;
    if (faceSet.has(cgz * W + cgx)) {
      return { x: ox + cgx * cs, z: oz + cgz * cs };
    }
  }
  return null;
}

// ===== Walk function =====
/**
 * Walk from (startX, startZ) into the face.
 * Direction blends from roadPerp toward gradientDir over BLEND_DIST metres.
 * Returns array of {x,z} world-coord points (including the start).
 *
 * Uses a visited set to prevent cycling. Requires dot product with blended
 * direction to be positive (forward-only).
 */
function walkFromRoad(startX, startZ, perpX, perpZ, gradX, gradZ, faceSet) {
  const polyline = [{ x: startX, z: startZ }];
  const visitedCells = new Set();

  let curGx = Math.round((startX - ox) / cs);
  let curGz = Math.round((startZ - oz) / cs);
  visitedCells.add(curGz * W + curGx);

  let distFromStart = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    // Blend factor: 0 at road, 1 at BLEND_DIST
    const blend = Math.min(1, distFromStart / BLEND_DIST);

    // Blended direction
    let dirX = (1 - blend) * perpX + blend * gradX;
    let dirZ = (1 - blend) * perpZ + blend * gradZ;
    const mag = Math.sqrt(dirX*dirX + dirZ*dirZ);
    if (mag < 1e-9) break;
    dirX /= mag; dirZ /= mag;

    // Pick the 8-connected neighbour that best matches the blended direction
    // Must not be already visited, must be in-face, and dot > 0 (forward-only)
    let bestDot = -Infinity;
    let bestGx = -1, bestGz = -1;

    for (const [dx, dz] of NEIGHBOURS_8) {
      const nx = curGx + dx, nz = curGz + dz;
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
      const nKey = nz * W + nx;
      if (!faceSet.has(nKey)) continue;
      if (visitedCells.has(nKey)) continue;

      // Direction vector to neighbour (normalised)
      const ndx = dx, ndz = dz;
      const nMag = Math.sqrt(ndx*ndx + ndz*ndz);
      const dot = (ndx/nMag)*dirX + (ndz/nMag)*dirZ;
      if (dot <= 0) continue; // forward-only
      if (dot > bestDot) {
        bestDot = dot;
        bestGx = nx; bestGz = nz;
      }
    }

    if (bestGx === -1) break; // No valid neighbour

    const stepDx = (bestGx - curGx) * cs;
    const stepDz = (bestGz - curGz) * cs;
    distFromStart += Math.sqrt(stepDx*stepDx + stepDz*stepDz);

    curGx = bestGx; curGz = bestGz;
    visitedCells.add(curGz * W + curGx);
    polyline.push({ x: ox + curGx * cs, z: oz + curGz * cs });
  }

  return polyline;
}

// ===== Sample points at intervals along a polyline segment =====
function sampleAlongSegment(p0, p1, spacingM) {
  const dx = p1.x - p0.x, dz = p1.z - p0.z;
  const len = Math.sqrt(dx*dx + dz*dz);
  if (len < 1e-6) return [];
  const nx = dx/len, nz = dz/len;
  const perpX = -nz, perpZ = nx;
  const pts = [];
  // Anchor to multiples of spacingM so adjacent segments share points
  const offset = Math.ceil(0 / spacingM) * spacingM;
  for (let d = offset; d <= len + 1e-6; d += spacingM) {
    const t = d / len;
    pts.push({ x: p0.x + t*dx, z: p0.z + t*dz, perpX, perpZ });
  }
  return pts;
}

// ===== Interpolate a world point at arc-distance d along a polyline =====
function samplePolyline(polyline, lens, d) {
  if (d <= 0) return { ...polyline[0] };
  if (d >= lens[lens.length - 1]) return { ...polyline[polyline.length - 1] };
  let lo = 0, hi = lens.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lens[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - lens[lo]) / (lens[hi] - lens[lo]);
  return {
    x: polyline[lo].x + t * (polyline[hi].x - polyline[lo].x),
    z: polyline[lo].z + t * (polyline[hi].z - polyline[lo].z),
  };
}

// ===== Render (cropped) =====

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

// Face boundaries (grey, 1px)
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

// Existing road grid (grey)
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

// Anchor road segments highlighted white (3px)
const drawnAnchorSegs = new Set();
for (const seg of anchorSegs) {
  const key = `${seg[0].x.toFixed(1)},${seg[0].z.toFixed(1)}-${seg[1].x.toFixed(1)},${seg[1].z.toFixed(1)}`;
  if (drawnAnchorSegs.has(key)) continue;
  drawnAnchorSegs.add(key);
  const x1 = Math.round((seg[0].x - ox) / cs) - minGx;
  const z1 = Math.round((seg[0].z - oz) / cs) - minGz;
  const x2 = Math.round((seg[1].x - ox) / cs) - minGx;
  const z2 = Math.round((seg[1].z - oz) / cs) - minGz;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      bres(pixels, cropW, cropH, x1+dx, z1+dz, x2+dx, z2+dz, 255, 255, 255);
}

// Cross streets (magenta, 1px)
for (const seg of allCross) {
  bres(pixels, cropW, cropH,
    Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
    Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
    255, 0, 255);
}

// Parallel streets (cyan, 1px)
for (const seg of allParallel) {
  bres(pixels, cropW, cropH,
    Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
    Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
    0, 220, 220);
}

// Starting points as red dots (3x3)
for (const pt of allStartPts) {
  const px = Math.round((pt.x - ox) / cs) - minGx;
  const pz = Math.round((pt.z - oz) / cs) - minGz;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = px + dx, nz = pz + dz;
      if (nx < 0 || nx >= cropW || nz < 0 || nz >= cropH) continue;
      const idx = (nz * cropW + nx) * 3;
      pixels[idx] = 255; pixels[idx+1] = 30; pixels[idx+2] = 30;
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
