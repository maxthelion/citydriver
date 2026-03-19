#!/usr/bin/env bun
/**
 * Experiment 007q — Local kink: gradient interior with perpendicular approach near roads.
 *
 * Cross streets follow the terrain gradient direction for most of their length,
 * but bend sharply near anchor roads to meet them at right angles. Like a
 * chicane or dogleg.
 *
 * Algorithm per face:
 *  1. Compute average gradient direction (same as 007i).
 *  2. Sweep cross street lines in the gradient direction; clip to face.
 *  3. POST-PROCESS each cross street endpoint that is within KINK_RADIUS of
 *     an anchor road:
 *       a. Find the nearest road cell.
 *       b. Compute the road direction at that cell (scan neighbours).
 *       c. Compute road perpendicular.
 *       d. Walk from the endpoint inward for KINK_LEN cells, blending the
 *          direction from pure gradient toward the road perpendicular.
 *     This produces: [straight gradient] → [short kinked bend] → [road]
 *  4. Mark PARALLEL_SPACING junction points along each (now kinked) cross street.
 *  5. Connect index-matched points between adjacent cross streets → parallels.
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
const outDir = process.argv[5] || 'experiments/007q-output';
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
const roadGrid = map.getLayer('roadGrid');

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

// ===== Local-kink parameters =====
const CROSS_SPACING   = 90;   // metres between cross streets (along contour)
const PARALLEL_SPACING = 35;  // metres between parallel street points (along gradient)
const MIN_STREET_LEN  = 20;   // metres — skip degenerate segments
const KINK_RADIUS     = 50;   // metres — within this distance from road, kink begins
const KINK_CELLS      = 10;   // cells to blend over (5 m cellSize → 50 m)

// ===== Helper: find nearest road cell within radius (world coords) =====
// Returns { cgx, cgz } or null
function nearestRoadCell(wx, wz, radiusM) {
  if (!roadGrid) return null;
  const radiusCells = Math.ceil(radiusM / cs);
  const cgx0 = Math.round((wx - ox) / cs);
  const cgz0 = Math.round((wz - oz) / cs);
  let bestDist2 = Infinity;
  let best = null;
  for (let dz = -radiusCells; dz <= radiusCells; dz++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const cx = cgx0 + dx, cz = cgz0 + dz;
      if (cx < 0 || cx >= W || cz < 0 || cz >= H) continue;
      if (roadGrid.get(cx, cz) <= 0) continue;
      const dist2 = dx * dx + dz * dz;
      if (dist2 < bestDist2) { bestDist2 = dist2; best = { cgx: cx, cgz: cz }; }
    }
  }
  if (best === null) return null;
  const dist = Math.sqrt(bestDist2) * cs;
  return dist <= radiusM ? best : null;
}

// ===== Helper: road direction at a cell (unit vector along road) =====
// Scans 4-connected neighbours on roadGrid and returns the dominant axis.
function roadDirAt(cgx, cgz) {
  if (!roadGrid) return null;
  // Count road neighbours in each axis
  const hasE = cgx + 1 < W  && roadGrid.get(cgx + 1, cgz) > 0;
  const hasW = cgx - 1 >= 0 && roadGrid.get(cgx - 1, cgz) > 0;
  const hasS = cgz + 1 < H  && roadGrid.get(cgx, cgz + 1) > 0;
  const hasN = cgz - 1 >= 0 && roadGrid.get(cgx, cgz - 1) > 0;

  // Build a direction from the sum of vectors to road neighbours
  let dx = 0, dz = 0;
  if (hasE) dx += 1;
  if (hasW) dx -= 1;
  if (hasS) dz += 1;
  if (hasN) dz -= 1;

  const mag = Math.sqrt(dx * dx + dz * dz);
  if (mag < 1e-6) {
    // Isolated cell or diagonal — try 8-connected to get any direction
    for (let ddz = -1; ddz <= 1; ddz++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        if (ddx === 0 && ddz === 0) continue;
        const nx = cgx + ddx, nz = cgz + ddz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        if (roadGrid.get(nx, nz) > 0) { dx += ddx; dz += ddz; }
      }
    }
    const mag2 = Math.sqrt(dx * dx + dz * dz);
    if (mag2 < 1e-6) return null;
    return { x: dx / mag2, z: dz / mag2 };
  }
  return { x: dx / mag, z: dz / mag };
}

// ===== Helper: apply kink to a cross-street endpoint region =====
//
// Given a cross street as a list of world-space points (fine-grained walk),
// and the gradient direction (gradX, gradZ), post-process one end:
//
//   endIdx = 0  (start end — walk forward from index 0)
//   endIdx = -1 (end end  — walk backward from last index)
//
// Returns a new points array with the kink applied.
//
function applyKink(points, gradX, gradZ) {
  if (points.length < 2) return points;

  // Try both ends
  const result = points.slice(); // shallow copy

  for (const [endIdx, direction] of [[0, 1], [points.length - 1, -1]]) {
    const ep = points[endIdx];

    const roadCell = nearestRoadCell(ep.x, ep.z, KINK_RADIUS);
    if (!roadCell) continue;

    const roadDir = roadDirAt(roadCell.cgx, roadCell.cgz);
    if (!roadDir) continue;

    // Road perpendicular (two choices; pick the one closer to gradient direction)
    let perpX = -roadDir.z, perpZ = roadDir.x;
    const dot = perpX * gradX + perpZ * gradZ;
    if (dot < 0) { perpX = -perpX; perpZ = -perpZ; }

    // Blend the last KINK_CELLS points from gradient toward perpendicular
    // direction: point at index k (0 = endpoint) gets weight t = k / KINK_CELLS
    // t=0 → pure perp, t=1 → pure gradient
    //
    // We reconstruct positions by walking from the first un-kinked point
    // (index KINK_CELLS from the end) inward toward the endpoint using
    // the blended direction.
    //
    // Find the "hinge" point: KINK_CELLS steps from the endpoint along points[]
    const hingeIdx = direction > 0
      ? Math.min(KINK_CELLS, points.length - 1)
      : Math.max(points.length - 1 - KINK_CELLS, 0);

    const hinge = points[hingeIdx];
    const stepLen = cs; // one cell step in metres

    // Rebuild from hinge toward endpoint
    const kinkPts = [];
    let cx = hinge.x, cz = hinge.z;
    const numKinkSteps = Math.abs(hingeIdx - endIdx);

    for (let k = 0; k < numKinkSteps; k++) {
      const t = k / numKinkSteps; // 0 at hinge, 1 at endpoint
      // Blend: near hinge keep gradient, near endpoint use perpendicular
      const bx = (1 - t) * gradX + t * perpX;
      const bz = (1 - t) * gradZ + t * perpZ;
      const bmag = Math.sqrt(bx * bx + bz * bz);
      const dirX = bmag > 1e-6 ? bx / bmag : gradX;
      const dirZ = bmag > 1e-6 ? bz / bmag : gradZ;

      // For the start end we walk toward endpoint (decreasing index = backward)
      const sign = direction > 0 ? -1 : 1;
      cx += sign * dirX * stepLen;
      cz += sign * dirZ * stepLen;
      kinkPts.push({ x: cx, z: cz, grOff: null });
    }

    // Splice kink points into result
    if (direction > 0) {
      // start end: replace indices 0..hingeIdx-1 with kinkPts (reversed)
      kinkPts.reverse();
      result.splice(0, hingeIdx, ...kinkPts);
    } else {
      // end end: replace indices hingeIdx+1..end with kinkPts
      result.splice(hingeIdx + 1, result.length - hingeIdx - 1, ...kinkPts);
    }
  }

  return result;
}

// ===== Gradient-cross layout with local kink =====
const allCross = [];      // [{points: [{x,z}]}]  multi-segment cross streets
const allParallel = [];
const faceTints = [[60,100,60],[60,60,100],[100,80,50],[80,60,100],[60,100,100],[100,60,80]];
const faceStats = [];

for (let fi = 0; fi < faces.length; fi++) {
  const face = faces[fi];
  const faceSet = new Set(face.cells.map(c => c.gz * W + c.gx));

  // ------------------------------------------------------------------
  // Step 1: Compute average gradient direction (same as 007i)
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

  const ctX = -gradZ, ctZ = gradX;

  // ------------------------------------------------------------------
  // Step 2: Face extent along contour and gradient axes
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
  // Step 3: Sweep cross streets at CROSS_SPACING along contour axis.
  //         Collect fine-grained point lists (half-cell steps) for kink
  //         post-processing.
  // ------------------------------------------------------------------
  const crossStreetPoints = []; // [{ctOff, pts: [{x,z,grOff}]}]
  const firstCt = Math.ceil(minCt / CROSS_SPACING) * CROSS_SPACING;

  for (let ctOff = firstCt; ctOff <= maxCt + 1e-6; ctOff += CROSS_SPACING) {
    const lineOx = faceCx + ctX * ctOff;
    const lineOz = faceCz + ctZ * ctOff;

    const step = cs * 0.5;
    const reach = (maxGr - minGr) + cs * 2;
    const nSteps = Math.ceil(reach / step);

    // Collect all points along the walk, tagged with in-face status
    const walkPts = [];
    for (let si = -nSteps; si <= nSteps; si++) {
      const grOff = si * step;
      const wx = lineOx + gradX * grOff;
      const wz = lineOz + gradZ * grOff;
      const cgx2 = Math.round((wx - ox) / cs);
      const cgz2 = Math.round((wz - oz) / cs);
      if (cgx2 < 0 || cgx2 >= W || cgz2 < 0 || cgz2 >= H) continue;
      walkPts.push({ x: wx, z: wz, grOff, inFace: faceSet.has(cgz2 * W + cgx2) });
    }

    // Keep longest contiguous in-face run
    let bestRun = [], curRun = [];
    for (const pt of walkPts) {
      if (pt.inFace) { curRun.push(pt); }
      else { if (curRun.length > bestRun.length) bestRun = curRun; curRun = []; }
    }
    if (curRun.length > bestRun.length) bestRun = curRun;
    if (bestRun.length < 2) continue;

    const segStart = bestRun[0];
    const segEnd   = bestRun[bestRun.length - 1];
    const segLen   = Math.sqrt((segEnd.x - segStart.x) ** 2 + (segEnd.z - segStart.z) ** 2);
    if (segLen < MIN_STREET_LEN) continue;

    // ------------------------------------------------------------------
    // Step 3b: Apply kink post-processing using the full fine-grained run
    // ------------------------------------------------------------------
    const kinkedRun = applyKink(bestRun, gradX, gradZ);

    // Store the kinked cross street as a multi-point polyline
    allCross.push(kinkedRun.map(p => ({ x: p.x, z: p.z })));

    // ------------------------------------------------------------------
    // Step 4: Mark PARALLEL_SPACING junction points along the original
    //         (straight gradient) grOff range so adjacent cross streets
    //         share offsets and parallels connect cleanly.
    // ------------------------------------------------------------------
    const grMin = segStart.grOff;
    const grMax = segEnd.grOff;
    const firstGr = Math.ceil(grMin / PARALLEL_SPACING) * PARALLEL_SPACING;

    const pts = [];
    for (let grOff = firstGr; grOff <= grMax + 1e-6; grOff += PARALLEL_SPACING) {
      // Find the kinked run point closest to this grOff position
      // (kinked run may not have exact grOff values, so interpolate from the
      //  straight-gradient world position and snap to kinked geometry)
      const t = (grOff - grMin) / (grMax - grMin);
      if (t < 0 || t > 1) continue;

      // Position along the original straight gradient line
      const straightX = segStart.x + t * (segEnd.x - segStart.x);
      const straightZ = segStart.z + t * (segEnd.z - segStart.z);

      // Find closest point in kinkedRun by parameter t approximation
      const kIdx = Math.round(t * (kinkedRun.length - 1));
      const kp = kinkedRun[Math.max(0, Math.min(kinkedRun.length - 1, kIdx))];

      pts.push({ x: kp.x, z: kp.z, grOff });
    }

    if (pts.length > 0) {
      crossStreetPoints.push({ ctOff, pts });
    }
  }

  // ------------------------------------------------------------------
  // Step 5: Connect same-grOff points on adjacent cross streets → parallels
  // ------------------------------------------------------------------
  crossStreetPoints.sort((a, b) => a.ctOff - b.ctOff);

  let faceCross = 0, faceParallel = 0;

  for (let k = 0; k < crossStreetPoints.length - 1; k++) {
    const csA = crossStreetPoints[k];
    const csB = crossStreetPoints[k + 1];

    const mapA = new Map(csA.pts.map(p => [p.grOff, p]));
    const mapB = new Map(csB.pts.map(p => [p.grOff, p]));

    for (const [grOff, pA] of mapA) {
      const pB = mapB.get(grOff);
      if (!pB) continue;
      const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
      if (segLen < MIN_STREET_LEN) continue;
      allParallel.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
      faceParallel++;
    }
  }

  faceCross = crossStreetPoints.length;
  faceStats.push({ fi, band: face.band, cells: face.cells.length, cross: faceCross, parallel: faceParallel });
}

console.log(`${allCross.length} cross streets, ${allParallel.length} parallel streets`);
console.log('Face breakdown:');
for (const s of faceStats) {
  console.log(`  Face ${s.fi} band=${s.band} cells=${s.cells} cross=${s.cross} parallel=${s.parallel}`);
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

// Roads (white, 2px)
if (roadGrid) {
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      if (roadGrid.get(x + minGx, z + minGz) > 0) {
        // Draw 2px wide by also filling right/down neighbour
        for (let dz2 = 0; dz2 <= 1; dz2++) {
          for (let dx2 = 0; dx2 <= 1; dx2++) {
            const px = x + dx2, pz = z + dz2;
            if (px < cropW && pz < cropH) {
              const idx = (pz * cropW + px) * 3;
              pixels[idx] = 255; pixels[idx+1] = 255; pixels[idx+2] = 255;
            }
          }
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

// Cross streets (magenta, 1px) — polylines with kinks
for (const polyline of allCross) {
  for (let i = 0; i < polyline.length - 1; i++) {
    const p1 = polyline[i], p2 = polyline[i + 1];
    bres(pixels, cropW, cropH,
      Math.round((p1.x - ox) / cs) - minGx, Math.round((p1.z - oz) / cs) - minGz,
      Math.round((p2.x - ox) / cs) - minGx, Math.round((p2.z - oz) / cs) - minGz,
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
