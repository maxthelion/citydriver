#!/usr/bin/env bun
/**
 * Experiment 007o — Straight compromise: gridBias blends terrain and road perpendicular.
 *
 * Based on 007i's face segmentation + gradient cross streets. The cross street direction
 * is computed as a blend of the terrain gradient and the nearest anchor road's perpendicular:
 *
 *   crossDir = normalize(GRID_BIAS * roadPerp + (1 - GRID_BIAS) * gradientDir)
 *
 * Three separate images are rendered for bias values 0.0, 0.5, and 1.0:
 *   - bias 0.0: pure terrain-following
 *   - bias 0.5: balanced blend
 *   - bias 1.0: pure grid (perpendicular to road)
 *
 * Parallel streets use 007k3's distance-indexed junction approach (35m spacing, index key).
 *
 * Output filenames:
 *   ribbon-zone-bias0-seed<N>.png
 *   ribbon-zone-bias05-seed<N>.png
 *   ribbon-zone-bias10-seed<N>.png
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
const outDir = process.argv[5] || 'experiments/007o-output';
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

// Pick same zone as 007i/007k — medium-large, near centre, has slope data
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

// ===== Collect anchor roads (arterial + collector) =====
const anchorRoads = (map.roads || []).filter(r =>
  r.hierarchy === 'arterial' || r.hierarchy === 'collector'
);
console.log(`Anchor roads: ${anchorRoads.length} (arterial/collector)`);

// Build a flat list of road segments for fast nearest-segment lookup.
// Each segment: { ax, az, bx, bz, dirX, dirZ, road }
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

/**
 * Find the nearest anchor road segment to a world-space point (px, pz).
 * Returns { seg, dist } or null.
 */
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
    if (dist < bestDist) {
      bestDist = dist;
      bestSeg = seg;
    }
  }
  return bestSeg ? { seg: bestSeg, dist: bestDist } : null;
}

// ===== Terrain face segmentation (same as 007i/007k) =====
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

// ===== Constants =====
const CROSS_SPACING    = 90;   // metres between cross streets (along contour axis)
const PARALLEL_SPACING = 35;   // metres of arc-length between parallel junctions (007k3 approach)
const MIN_STREET_LEN   = 20;   // metres — skip degenerate segments

const BIAS_VALUES = [
  { value: 0.0,  label: 'bias0'  },
  { value: 0.5,  label: 'bias05' },
  { value: 1.0,  label: 'bias10' },
];

const faceTints = [[60,100,60],[60,60,100],[100,80,50],[80,60,100],[60,100,100],[100,60,80]];

// Pre-compute per-face gradient, centroid, and nearest road segment
// (these don't change across bias values)
const faceData = [];

for (let fi = 0; fi < faces.length; fi++) {
  const face = faces[fi];
  const faceSet = new Set(face.cells.map(c => c.gz * W + c.gx));

  // ------------------------------------------------------------------
  // Compute average gradient direction for this face.
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

  // Face centroid in world coords
  let cxSum = 0, czSum = 0;
  for (const c of face.cells) { cxSum += c.gx; czSum += c.gz; }
  const faceCx = ox + (cxSum / face.cells.length) * cs;
  const faceCz = oz + (czSum / face.cells.length) * cs;

  // Nearest anchor road segment
  const nearestResult = findNearestAnchorSegment(faceCx, faceCz);

  faceData.push({
    fi,
    face,
    faceSet,
    gradX,
    gradZ,
    faceCx,
    faceCz,
    nearestSeg: nearestResult ? nearestResult.seg : null,
    nearestDist: nearestResult ? nearestResult.dist : Infinity,
  });
}

console.log(`Pre-computed ${faceData.length} faces`);

// ===== Generate streets and render for each bias value =====

for (const { value: GRID_BIAS, label: biasLabel } of BIAS_VALUES) {
  console.log(`\n--- GRID_BIAS=${GRID_BIAS} (${biasLabel}) ---`);

  const allCross    = [];
  const allParallel = [];
  const faceNearestSegs = [];
  const faceStats   = [];

  for (const fd of faceData) {
    const { fi, face, faceSet, gradX, gradZ, faceCx, faceCz, nearestSeg } = fd;

    // ------------------------------------------------------------------
    // Blend: crossDir = normalize(GRID_BIAS * roadPerp + (1-GRID_BIAS) * gradientDir)
    // ------------------------------------------------------------------
    let crossX, crossZ;

    if (nearestSeg) {
      // Road perpendicular: rotate road direction 90°
      // roadPerp = (-seg.dirZ, seg.dirX)
      const perpX = -nearestSeg.dirZ;
      const perpZ =  nearestSeg.dirX;

      // Choose perpendicular direction that aligns with gradient (avoid anti-gradient flip)
      const dot = gradX * perpX + gradZ * perpZ;
      const rpX = dot >= 0 ? perpX : -perpX;
      const rpZ = dot >= 0 ? perpZ : -perpZ;

      // Blend
      const blendX = GRID_BIAS * rpX + (1 - GRID_BIAS) * gradX;
      const blendZ = GRID_BIAS * rpZ + (1 - GRID_BIAS) * gradZ;
      const blendMag = Math.sqrt(blendX*blendX + blendZ*blendZ);
      crossX = blendMag > 1e-6 ? blendX / blendMag : gradX;
      crossZ = blendMag > 1e-6 ? blendZ / blendMag : gradZ;

      faceNearestSegs.push({ fi, seg: nearestSeg });
    } else {
      // No anchor road — fall back to pure terrain gradient
      crossX = gradX;
      crossZ = gradZ;
      faceNearestSegs.push(null);
    }

    // Contour direction (perpendicular to cross direction)
    const ctX = -crossZ, ctZ = crossX;

    // ------------------------------------------------------------------
    // Find face extent along the cross and contour directions
    // ------------------------------------------------------------------
    let minCt = Infinity, maxCt = -Infinity;
    let minGr = Infinity, maxGr = -Infinity;

    for (const c of face.cells) {
      const wx = ox + c.gx * cs;
      const wz = oz + c.gz * cs;
      const projCt = (wx - faceCx) * ctX + (wz - faceCz) * ctZ;
      const projGr = (wx - faceCx) * crossX + (wz - faceCz) * crossZ;
      if (projCt < minCt) minCt = projCt;
      if (projCt > maxCt) maxCt = projCt;
      if (projGr < minGr) minGr = projGr;
      if (projGr > maxGr) maxGr = projGr;
    }

    // ------------------------------------------------------------------
    // Sweep cross streets at CROSS_SPACING along the contour axis.
    // Use 007k3 distance-indexed junction approach for parallel streets.
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
        const wx = lineOx + crossX * grOff;
        const wz = lineOz + crossZ * grOff;

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

      allCross.push([
        { x: segStart.wx, z: segStart.wz },
        { x: segEnd.wx,   z: segEnd.wz   },
      ]);

      // 007k3 distance-indexed junctions:
      // Walk cross street measuring arc-length; every PARALLEL_SPACING metres
      // record junction with sequential index as key.
      const junctionMap = new Map(); // key = sequential index (integer)
      const profile = bestRun;
      let distAccum = 0;
      let pointIndex = 0;

      for (let si = 0; si < profile.length; si++) {
        if (si > 0) {
          const ddx = profile[si].wx - profile[si - 1].wx;
          const ddz = profile[si].wz - profile[si - 1].wz;
          distAccum += Math.sqrt(ddx * ddx + ddz * ddz);
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

    // Connect matching distance indices between adjacent cross streets → parallel streets
    crossStreets.sort((a, b) => a.ctOff - b.ctOff);

    let faceCrossCount = crossStreets.length;
    let faceParallel = 0;

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

    faceStats.push({ fi, band: face.band, cells: face.cells.length, cross: faceCrossCount, parallel: faceParallel });
  }

  console.log(`${allCross.length} cross streets, ${allParallel.length} parallel streets`);
  for (const s of faceStats) {
    console.log(`  Face ${s.fi} band=${s.band} cells=${s.cells} cross=${s.cross} parallel=${s.parallel}`);
  }

  // ===== Render =====

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

  // Face boundaries (grey, faint — 1px)
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

  // Nearest anchor road segments per face — white (2px)
  for (const entry of faceNearestSegs) {
    if (!entry) continue;
    const { seg } = entry;
    const x0 = Math.round((seg.ax - ox) / cs) - minGx;
    const z0 = Math.round((seg.az - oz) / cs) - minGz;
    const x1 = Math.round((seg.bx - ox) / cs) - minGx;
    const z1 = Math.round((seg.bz - oz) / cs) - minGz;
    bresThick(pixels, cropW, cropH, x0, z0, x1, z1, 255, 255, 255, 2);
  }

  // Cross streets (magenta, 1px) — blended direction
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

  const header = `P6\n${cropW} ${cropH}\n255\n`;
  const basePath = `${outDir}/ribbon-zone-${biasLabel}-seed${seed}`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
  console.log(`Written to ${basePath}.png (${cropW}x${cropH})`);
}

console.log(`\nTotal: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// === Bresenham line draw (1px) ===
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

// === Thick Bresenham line draw (thickness px) ===
function bresThick(pixels, w, h, x0, y0, x1, y1, r, g, b, thickness) {
  const half = Math.floor(thickness / 2);
  for (let off = -half; off <= half; off++) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 1e-6) continue;
    const px = Math.round(-dy / len * off);
    const py = Math.round( dx / len * off);
    bres(pixels, w, h, x0+px, y0+py, x1+px, y1+py, r, g, b);
  }
}
