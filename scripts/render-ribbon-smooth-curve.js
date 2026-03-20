#!/usr/bin/env bun
/**
 * Experiment 007p — Smooth-curve cross streets.
 *
 * Cross street direction varies along its length. Near anchor roads the
 * direction is road-perpendicular; in the interior it follows the terrain
 * gradient. Smooth blend between the two based on distance to nearest road cell.
 *
 * Algorithm per face:
 *  1. Compute average gradient direction (same as 007i).
 *  2. Find nearest anchor road segment to face centroid; compute road
 *     perpendicular direction (roadPerp).
 *  3. Build a per-cell road distance map (BFS from road cells on roadGrid).
 *  4. Sweep starting positions at CROSS_SPACING intervals along the contour
 *     axis (same sweep as 007i).
 *  5. For each sweep origin, WALK cell by cell:
 *     - At current cell, look up roadDist from BFS map.
 *     - blend = min(1, roadDist / BLEND_RADIUS) — 0 at road, 1 beyond radius.
 *     - dir = normalize((1 - blend) * roadPerp + blend * gradientDir)
 *     - Pick the 8-connected face-interior neighbour closest to dir.
 *     - Walk until leaving face or MAX_WALK_STEPS reached.
 *     - Cross street = polyline of walked cells.
 *  6. Mark junction points at PARALLEL_SPACING distance intervals along each
 *     walk (index-keyed, same as 007k3).
 *  7. Connect matching index points between adjacent cross street walks →
 *     parallel streets (polyline segments).
 *
 * Parameters:
 *   GRID_BIAS     = 0.5  — road influence strength scalar (scales the weight
 *                          assigned to roadPerp vs gradient at proximity=1)
 *   BLEND_RADIUS  = 200  — metres; full gradient direction beyond this distance
 *   CROSS_SPACING = 90   — metres between sweep origins along contour axis
 *   PARALLEL_SPACING = 35 — metres between junction points along walk
 *
 * Render:
 *   Cross streets (walked polylines): magenta 1px — visible curves.
 *   Parallel streets (junction connections): cyan 1px.
 *   Road grid: white 2px.
 *   Zone boundary: yellow 1px.
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

const seed  = parseInt(process.argv[2]) || 42;
const gx    = parseInt(process.argv[3]) || 27;
const gz    = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007p-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// ── Parameters ──────────────────────────────────────────────────────────────
const GRID_BIAS      = 0.5;   // road influence strength (0 = pure gradient, 1 = pure perp)
const BLEND_RADIUS   = 200;   // metres — full gradient direction beyond this
const CROSS_SPACING  = 90;    // metres between cross street sweep lines
const PARALLEL_SPACING = 35;  // metres between junction points along walk
const MIN_STREET_LEN = 20;    // metres — skip degenerate segments
const MAX_WALK_STEPS = 2000;  // guard against infinite loops
// ────────────────────────────────────────────────────────────────────────────

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
const W  = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');

// ── Zone selection (same criteria as 007i) ───────────────────────────────────
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

// ── Crop bounds ──────────────────────────────────────────────────────────────
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

// ── Anchor roads ─────────────────────────────────────────────────────────────
const anchorRoads = (map.roads || []).filter(r =>
  r.hierarchy === 'arterial' || r.hierarchy === 'collector'
);
console.log(`Anchor roads: ${anchorRoads.length}`);

const anchorSegments = [];
for (const road of anchorRoads) {
  const pts = road.polyline;
  if (!pts || pts.length < 2) continue;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].z;
    const bx = pts[i+1].x, bz = pts[i+1].z;
    const ddx = bx - ax, ddz = bz - az;
    const len = Math.sqrt(ddx*ddx + ddz*ddz);
    if (len < 1e-6) continue;
    anchorSegments.push({ ax, az, bx, bz, dirX: ddx/len, dirZ: ddz/len, road });
  }
}
console.log(`Anchor segments: ${anchorSegments.length}`);

function findNearestAnchorSegment(px, pz) {
  if (anchorSegments.length === 0) return null;
  let bestSeg = null, bestDist = Infinity;
  for (const seg of anchorSegments) {
    const dx = seg.bx - seg.ax, dz = seg.bz - seg.az;
    const len2 = dx*dx + dz*dz;
    let t = len2 > 0 ? ((px - seg.ax)*dx + (pz - seg.az)*dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = seg.ax + t*dx, cz = seg.az + t*dz;
    const dist = Math.sqrt((px-cx)*(px-cx) + (pz-cz)*(pz-cz));
    if (dist < bestDist) { bestDist = dist; bestSeg = seg; }
  }
  return bestSeg ? { seg: bestSeg, dist: bestDist } : null;
}

// ── Road-distance BFS ─────────────────────────────────────────────────────────
// Build a Float32Array of road distances (metres) for all cells in the zone,
// seeded from every road-grid cell within the zone bounding box.
const roadGrid = map.getLayer('roadGrid');
const roadDist = new Float32Array(W * H).fill(Infinity);

if (roadGrid) {
  const bfsQueue = [];
  // Seed with every road cell in the crop region
  for (let z = minGz; z <= maxGz; z++) {
    for (let x = minGx; x <= maxGx; x++) {
      if (roadGrid.get(x, z) > 0) {
        const idx = z * W + x;
        roadDist[idx] = 0;
        bfsQueue.push(x, z); // interleaved x,z pairs
      }
    }
  }
  // BFS expanding 4-connected
  let head = 0;
  while (head < bfsQueue.length) {
    const cx = bfsQueue[head++];
    const cz = bfsQueue[head++];
    const curDist = roadDist[cz * W + cx];
    for (const [ddx, ddz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cx + ddx, nz = cz + ddz;
      if (nx < minGx || nx > maxGx || nz < minGz || nz > maxGz) continue;
      const ni = nz * W + nx;
      const nd = curDist + cs; // one cell step = cs metres
      if (nd < roadDist[ni]) {
        roadDist[ni] = nd;
        bfsQueue.push(nx, nz);
      }
    }
  }
  console.log(`Road BFS complete (${bfsQueue.length / 2} cells visited)`);
} else {
  console.log('No roadGrid layer — road distances remain Infinity');
}

// ── Terrain face segmentation (same as 007i) ─────────────────────────────────
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
    for (const [ddx, ddz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = p.gx + ddx, nz = p.gz + ddz;
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

// ── Smooth-curve layout ──────────────────────────────────────────────────────
const allCross    = [];  // array of [{x,z}] polylines
const allParallel = [];  // array of [{x,z},{x,z}] segments
const faceTints = [[60,100,60],[60,60,100],[100,80,50],[80,60,100],[60,100,100],[100,60,80]];
const faceStats = [];

// 8-connected neighbour offsets (sorted by angle for stable pick)
const DIRS8 = [
  [1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]
];

for (let fi = 0; fi < faces.length; fi++) {
  const face = faces[fi];
  const faceSet = new Set(face.cells.map(c => c.gz * W + c.gx));

  // ── Step 1: Average gradient direction ────────────────────────────────────
  let sumDx = 0, sumDz = 0, gradCount = 0;
  for (const c of face.cells) {
    const eC = elev.get(c.gx, c.gz);
    const eE = faceSet.has(c.gz * W + (c.gx + 1)) ? elev.get(c.gx + 1, c.gz) : eC;
    const eW = faceSet.has(c.gz * W + (c.gx - 1)) ? elev.get(c.gx - 1, c.gz) : eC;
    const gx_ = (eE - eW) / (2 * cs);
    const eS = faceSet.has((c.gz + 1) * W + c.gx) ? elev.get(c.gx, c.gz + 1) : eC;
    const eN = faceSet.has((c.gz - 1) * W + c.gx) ? elev.get(c.gx, c.gz - 1) : eC;
    const gz_ = (eS - eN) / (2 * cs);
    sumDx += gx_; sumDz += gz_; gradCount++;
  }
  if (gradCount === 0) continue;

  let gradX = sumDx / gradCount;
  let gradZ = sumDz / gradCount;
  const gradMag = Math.sqrt(gradX * gradX + gradZ * gradZ);
  if (gradMag < 1e-6) {
    if (zone.slopeDir) { gradX = zone.slopeDir.x; gradZ = zone.slopeDir.z; }
    else { continue; }
  } else {
    gradX /= gradMag; gradZ /= gradMag;
  }

  // Contour direction (perpendicular to gradient, for sweep axis)
  const ctX = -gradZ, ctZ = gradX;

  // ── Step 2: Face centroid ─────────────────────────────────────────────────
  let cxSum = 0, czSum = 0;
  for (const c of face.cells) { cxSum += c.gx; czSum += c.gz; }
  const faceCx = ox + (cxSum / face.cells.length) * cs;
  const faceCz = oz + (czSum / face.cells.length) * cs;

  // ── Step 3: Find nearest anchor road → road perpendicular ────────────────
  const nearestResult = findNearestAnchorSegment(faceCx, faceCz);
  let roadPerpX, roadPerpZ;

  if (nearestResult) {
    const { seg } = nearestResult;
    // Perpendicular to road direction
    let rpX = -seg.dirZ;
    let rpZ =  seg.dirX;
    // Orient toward gradient (so it doesn't flip upside down)
    const dot = gradX * rpX + gradZ * rpZ;
    if (dot < 0) { rpX = -rpX; rpZ = -rpZ; }
    roadPerpX = rpX; roadPerpZ = rpZ;
    console.log(`  Face ${fi}: nearest road dist=${nearestResult.dist.toFixed(1)}m hierarchy=${seg.road.hierarchy}`);
  } else {
    // No anchor roads — road perp equals gradient (neutral blend)
    roadPerpX = gradX; roadPerpZ = gradZ;
    console.log(`  Face ${fi}: no anchor roads, using gradient as roadPerp`);
  }

  // ── Step 4: Find face extent along contour and gradient axes ─────────────
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

  // ── Step 5: Sweep walk starts at CROSS_SPACING intervals ─────────────────
  const crossStreets = [];  // [{ctOff, polyline: [{x,z,cgx,cgz}], junctionMap}]
  const firstCt = Math.ceil(minCt / CROSS_SPACING) * CROSS_SPACING;

  for (let ctOff = firstCt; ctOff <= maxCt + 1e-6; ctOff += CROSS_SPACING) {
    // Start position for this sweep line
    const startWx = faceCx + ctX * ctOff;
    const startWz = faceCz + ctZ * ctOff;

    // Convert to grid cell
    const startCgx = Math.round((startWx - ox) / cs);
    const startCgz = Math.round((startWz - oz) / cs);

    // Find the cell in this sweep column that is inside the face.
    // Walk backward/forward along gradient to find first in-face cell.
    let originCgx = -1, originCgz = -1;
    if (faceSet.has(startCgz * W + startCgx)) {
      originCgx = startCgx; originCgz = startCgz;
    } else {
      // Search along gradient axis from sweep origin for first in-face cell
      const searchSteps = Math.ceil((maxGr - minGr) / cs) + 5;
      outer: for (let si = 1; si <= searchSteps; si++) {
        for (const sign of [1, -1]) {
          const tx = startWx + gradX * si * cs;
          const tz = startWz + gradZ * si * cs;
          const tcgx = Math.round((tx - ox) / cs);
          const tcgz = Math.round((tz - oz) / cs);
          if (tcgx < 0 || tcgx >= W || tcgz < 0 || tcgz >= H) continue;
          if (faceSet.has(tcgz * W + tcgx)) {
            originCgx = tcgx; originCgz = tcgz;
            break outer;
          }
        }
      }
    }

    if (originCgx < 0) continue;  // No in-face entry found

    // ── Walk the cross street cell by cell (both directions from origin) ──
    // We walk in "positive gradient" direction first, then reverse, and
    // combine into one polyline.

    function walkFrom(startX, startZ, forwardDir) {
      // forwardDir: +1 or -1 (along gradient direction)
      const pts = [];
      const walkVisited = new Set();
      let cx = startX, cz = startZ;
      walkVisited.add(cz * W + cx);
      pts.push({ cgx: cx, cgz: cz });

      for (let step = 0; step < MAX_WALK_STEPS; step++) {
        // World position of current cell
        const wx = ox + cx * cs;
        const wz = oz + cz * cs;

        // Road distance for blend
        const dist = (cx >= 0 && cx < W && cz >= 0 && cz < H)
          ? roadDist[cz * W + cx] : Infinity;
        const distFinite = isFinite(dist) ? dist : BLEND_RADIUS;

        // blend: 0 near road (use roadPerp), 1 far from road (use gradient)
        const rawBlend = Math.min(1, distFinite / BLEND_RADIUS);
        // Apply GRID_BIAS: at rawBlend=0, weight = GRID_BIAS toward roadPerp
        // At rawBlend=1, weight = 0 toward roadPerp (pure gradient)
        const blend = rawBlend; // full blend range; GRID_BIAS scales road contribution
        const roadWeight = GRID_BIAS * (1 - blend);
        const gradWeight = 1 - roadWeight;

        // Target direction at this cell
        let tDirX = roadWeight * roadPerpX + gradWeight * gradX;
        let tDirZ = roadWeight * roadPerpZ + gradWeight * gradZ;
        const tLen = Math.sqrt(tDirX*tDirX + tDirZ*tDirZ);
        if (tLen > 1e-6) { tDirX /= tLen; tDirZ /= tLen; }
        else { tDirX = gradX; tDirZ = gradZ; }

        // Apply forward direction
        const fdx = forwardDir * tDirX;
        const fdz = forwardDir * tDirZ;

        // Pick best 8-connected neighbour: must be in face, not yet visited,
        // and maximise dot product with target direction
        let bestNx = -1, bestNz = -1, bestDot = -Infinity;
        for (const [ddx, ddz] of DIRS8) {
          const nx = cx + ddx, nz = cz + ddz;
          if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
          const ni = nz * W + nx;
          if (!faceSet.has(ni) || walkVisited.has(ni)) continue;
          // Normalised neighbour direction
          const mag = Math.sqrt(ddx*ddx + ddz*ddz);
          const dot = (ddx/mag)*fdx + (ddz/mag)*fdz;
          if (dot > bestDot) { bestDot = dot; bestNx = nx; bestNz = nz; }
        }

        if (bestNx < 0 || bestDot < 0) break;  // No valid forward neighbour

        cx = bestNx; cz = bestNz;
        walkVisited.add(cz * W + cx);
        pts.push({ cgx: cx, cgz: cz });
      }
      return pts;
    }

    // Walk positive and negative gradient directions from origin
    const fwdPts = walkFrom(originCgx, originCgz, +1);
    const revPts = walkFrom(originCgx, originCgz, -1);

    // Combine: reverse pts (excluding duplicated origin) + forward pts
    const combined = [
      ...revPts.slice(1).reverse(),
      ...fwdPts,
    ];

    if (combined.length < 2) continue;

    // Check minimum length
    const startPt = combined[0], endPt = combined[combined.length - 1];
    const segLen = Math.sqrt(
      ((endPt.cgx - startPt.cgx) * cs) ** 2 +
      ((endPt.cgz - startPt.cgz) * cs) ** 2
    );
    if (segLen < MIN_STREET_LEN) continue;

    // Convert to world-space polyline
    const polyline = combined.map(p => ({
      x: ox + p.cgx * cs,
      z: oz + p.cgz * cs,
      cgx: p.cgx,
      cgz: p.cgz,
    }));

    allCross.push(polyline);

    // ── Step 6: Junction points at PARALLEL_SPACING arc-length intervals ──
    const junctionMap = new Map();
    let distAccum = 0;
    let pointIndex = 0;

    for (let si = 0; si < polyline.length; si++) {
      if (si > 0) {
        const ddx = polyline[si].x - polyline[si-1].x;
        const ddz = polyline[si].z - polyline[si-1].z;
        distAccum += Math.sqrt(ddx*ddx + ddz*ddz);
      }
      if (distAccum < PARALLEL_SPACING) continue;
      distAccum = 0;
      junctionMap.set(pointIndex++, { x: polyline[si].x, z: polyline[si].z });
    }

    crossStreets.push({ ctOff, polyline, junctionMap });
  }

  // ── Step 7: Connect matching junction indices between adjacent streets ───
  crossStreets.sort((a, b) => a.ctOff - b.ctOff);

  let faceCross = crossStreets.length;
  let faceParallel = 0;

  for (let k = 0; k < crossStreets.length - 1; k++) {
    const csA = crossStreets[k];
    const csB = crossStreets[k + 1];

    for (const [key, pA] of csA.junctionMap) {
      const pB = csB.junctionMap.get(key);
      if (!pB) continue;
      const pLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
      if (pLen < MIN_STREET_LEN) continue;
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

// ── Render ───────────────────────────────────────────────────────────────────
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

// Face boundaries (faint white, 1px)
for (let fi = 0; fi < faces.length; fi++) {
  const faceSet = new Set(faces[fi].cells.map(c => c.gz * W + c.gx));
  for (const c of faces[fi].cells) {
    let isBoundary = false;
    for (const [ddx, ddz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      if (!faceSet.has((c.gz + ddz) * W + (c.gx + ddx))) { isBoundary = true; break; }
    }
    if (!isBoundary) continue;
    const x = c.gx - minGx, z = c.gz - minGz;
    if (x >= 0 && x < cropW && z >= 0 && z < cropH) {
      const idx = (z * cropW + x) * 3;
      pixels[idx] = 180; pixels[idx+1] = 180; pixels[idx+2] = 180;
    }
  }
}

// Road grid (white, 2px)
if (roadGrid) {
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      if (roadGrid.get(x + minGx, z + minGz) > 0) {
        // 2px — also paint the pixel to the right
        for (const ox2 of [0, 1]) {
          const px = x + ox2;
          if (px >= cropW) continue;
          const idx = (z * cropW + px) * 3;
          pixels[idx] = 255; pixels[idx+1] = 255; pixels[idx+2] = 255;
        }
      }
    }
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

// Cross streets (magenta, 1px) — polylines, should show visible curves
for (const polyline of allCross) {
  for (let i = 0; i < polyline.length - 1; i++) {
    bres(pixels, cropW, cropH,
      Math.round((polyline[i].x   - ox) / cs) - minGx, Math.round((polyline[i].z   - oz) / cs) - minGz,
      Math.round((polyline[i+1].x - ox) / cs) - minGx, Math.round((polyline[i+1].z - oz) / cs) - minGz,
      255, 0, 255);
  }
}

// Parallel streets (cyan, 1px)
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
