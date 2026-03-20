#!/usr/bin/env bun
/**
 * Experiment 007n — Road-axis cross streets.
 *
 * Instead of using the terrain gradient direction for cross streets (007i),
 * use the direction of the nearest anchor road (arterial or collector) as
 * the "contour axis" for each terrain face. Cross streets are then
 * perpendicular to that road direction, guaranteeing perpendicular junctions
 * with the anchor road network.
 *
 * Algorithm per face:
 *  1. Find the nearest anchor road segment (arterial or collector) to the
 *     face centroid. Get its direction vector.
 *  2. Road direction → "contour axis". Cross streets are perpendicular to it.
 *  3. Sweep cross street lines at CROSS_SPACING intervals along the road axis.
 *  4. Each cross street: walk perpendicular to the road direction, clip to
 *     face cells (keep longest contiguous in-face run).
 *  5. Mark PARALLEL_SPACING points along each cross street.
 *  6. Connect same-offset points between adjacent cross streets → parallel streets.
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
const outDir = process.argv[5] || 'experiments/007n-output';
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

// ===== Anchor roads: arterial + collector =====
const anchorRoads = map.roads.filter(r =>
  (r.hierarchy === 'arterial' || r.hierarchy === 'collector') &&
  r.polyline && r.polyline.length >= 2
);
console.log(`Anchor roads (arterial+collector): ${anchorRoads.length}`);

/**
 * Find the nearest road segment (from anchorRoads) to a world-space point (wx, wz).
 * Returns { roadIdx, segIdx, distSq, dirX, dirZ } — the unit direction of the segment.
 */
function nearestAnchorSegment(wx, wz) {
  let bestDistSq = Infinity;
  let bestDirX = 1, bestDirZ = 0;
  let bestRoadIdx = -1, bestSegIdx = -1;

  for (let ri = 0; ri < anchorRoads.length; ri++) {
    const road = anchorRoads[ri];
    const pl = road.polyline;
    for (let si = 0; si < pl.length - 1; si++) {
      const ax = pl[si].x,   az = pl[si].z;
      const bx = pl[si+1].x, bz = pl[si+1].z;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1e-10) continue;

      // Project point onto segment, clamp to [0,1]
      const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / lenSq));
      const px = ax + t * dx - wx;
      const pz = az + t * dz - wz;
      const distSq = px * px + pz * pz;

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        const len = Math.sqrt(lenSq);
        bestDirX = dx / len;
        bestDirZ = dz / len;
        bestRoadIdx = ri;
        bestSegIdx = si;
      }
    }
  }

  return { roadIdx: bestRoadIdx, segIdx: bestSegIdx, distSq: bestDistSq, dirX: bestDirX, dirZ: bestDirZ };
}

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

// ===== Road-axis layout =====
const CROSS_SPACING = 90;     // metres between cross streets (along road direction)
const PARALLEL_SPACING = 35;  // metres between parallel streets (perpendicular to road)
const MIN_STREET_LEN = 20;    // metres — skip degenerate segments

const allCross = [];
const allParallel = [];
const faceTints = [[60,100,60],[60,60,100],[100,80,50],[80,60,100],[60,100,100],[100,60,80]];

// Track which anchor roads are used (for highlighting)
const usedAnchorRoadIndices = new Set();

// Statistics for logging
const faceStats = [];

for (let fi = 0; fi < faces.length; fi++) {
  const face = faces[fi];

  // Build a fast lookup set for this face
  const faceSet = new Set(face.cells.map(c => c.gz * W + c.gx));

  // ------------------------------------------------------------------
  // Step 1: Find the nearest anchor road segment to this face's centroid.
  //
  // The road's direction becomes the "contour axis" (roads run parallel
  // to themselves). Cross streets are perpendicular to the road direction.
  // ------------------------------------------------------------------
  let cxSum = 0, czSum = 0;
  for (const c of face.cells) { cxSum += c.gx; czSum += c.gz; }
  const faceCx = ox + (cxSum / face.cells.length) * cs;
  const faceCz = oz + (czSum / face.cells.length) * cs;

  if (anchorRoads.length === 0) continue;

  const nearest = nearestAnchorSegment(faceCx, faceCz);
  if (nearest.roadIdx < 0) continue;

  usedAnchorRoadIndices.add(nearest.roadIdx);

  // Road direction (unit vector along road): this is the "contour axis"
  // Cross streets run perpendicular to the road direction.
  const ctX = nearest.dirX;   // road / contour axis
  const ctZ = nearest.dirZ;
  // Perpendicular to road = cross street direction
  const crossX = -ctZ;        // perpendicular: cross streets run in this direction
  const crossZ =  ctX;

  // ------------------------------------------------------------------
  // Step 2: Find face extent along the road (contour) axis and the
  // perpendicular (cross-street) axis.
  // ------------------------------------------------------------------
  let minCt = Infinity, maxCt = -Infinity;
  let minCr = Infinity, maxCr = -Infinity;

  for (const c of face.cells) {
    const wx = ox + c.gx * cs;
    const wz = oz + c.gz * cs;
    const projCt = (wx - faceCx) * ctX + (wz - faceCz) * ctZ;
    const projCr = (wx - faceCx) * crossX + (wz - faceCz) * crossZ;
    if (projCt < minCt) minCt = projCt;
    if (projCt > maxCt) maxCt = projCt;
    if (projCr < minCr) minCr = projCr;
    if (projCr > maxCr) maxCr = projCr;
  }

  // ------------------------------------------------------------------
  // Step 3: Sweep cross streets at CROSS_SPACING along the road axis.
  //
  // Each cross street line runs in the cross-street direction (perpendicular
  // to the road). We walk cell-by-cell at half-cell steps and keep the
  // longest contiguous in-face run.
  // ------------------------------------------------------------------

  const crossStreetPoints = []; // [{ctOff, pts: [{x,z,crOff}]}]

  // Snap first sweep position to a multiple of CROSS_SPACING
  const firstCt = Math.ceil(minCt / CROSS_SPACING) * CROSS_SPACING;

  for (let ctOff = firstCt; ctOff <= maxCt + 1e-6; ctOff += CROSS_SPACING) {
    // Origin of this sweep line in world coords
    const lineOx = faceCx + ctX * ctOff;
    const lineOz = faceCz + ctZ * ctOff;

    // Walk along cross-street direction (perpendicular to road), step = half a cell
    const step = cs * 0.5;
    const reach = (maxCr - minCr) + cs * 2;
    const nSteps = Math.ceil(reach / step);

    const inFacePoints = [];

    for (let si = -nSteps; si <= nSteps; si++) {
      const crOff = si * step;
      const wx = lineOx + crossX * crOff;
      const wz = lineOz + crossZ * crOff;

      // Convert to grid cell
      const cgx = Math.round((wx - ox) / cs);
      const cgz = Math.round((wz - oz) / cs);
      if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) continue;

      const inFace = faceSet.has(cgz * W + cgx);
      inFacePoints.push({ wx, wz, crOff, inFace });
    }

    // Extract contiguous in-face runs and keep the longest
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

    // Store the cross street segment
    allCross.push([
      { x: segStart.wx, z: segStart.wz },
      { x: segEnd.wx,   z: segEnd.wz   },
    ]);

    // Step 4: Mark PARALLEL_SPACING points along the cross-street offset range.
    const crMin = segStart.crOff;
    const crMax = segEnd.crOff;
    const firstCr = Math.ceil(crMin / PARALLEL_SPACING) * PARALLEL_SPACING;

    const pts = [];
    for (let crOff = firstCr; crOff <= crMax + 1e-6; crOff += PARALLEL_SPACING) {
      const t = (crOff - crMin) / (crMax - crMin);
      if (t < 0 || t > 1) continue;
      pts.push({
        x: segStart.wx + t * (segEnd.wx - segStart.wx),
        z: segStart.wz + t * (segEnd.wz - segStart.wz),
        crOff,
      });
    }

    if (pts.length > 0) {
      crossStreetPoints.push({ ctOff, pts });
    }
  }

  // Step 5: Connect same-crOff points on adjacent cross streets → parallel streets.
  crossStreetPoints.sort((a, b) => a.ctOff - b.ctOff);

  let faceCross = 0, faceParallel = 0;

  for (let k = 0; k < crossStreetPoints.length - 1; k++) {
    const csA = crossStreetPoints[k];
    const csB = crossStreetPoints[k + 1];

    const mapA = new Map(csA.pts.map(p => [p.crOff, p]));
    const mapB = new Map(csB.pts.map(p => [p.crOff, p]));

    for (const [crOff, pA] of mapA) {
      const pB = mapB.get(crOff);
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

// All roads (grey, 1px)
const roadGrid = map.getLayer('roadGrid');
if (roadGrid) {
  for (let z = 0; z < cropH; z++)
    for (let x = 0; x < cropW; x++)
      if (roadGrid.get(x + minGx, z + minGz) > 0) {
        const idx = (z * cropW + x) * 3;
        pixels[idx] = 150; pixels[idx+1] = 150; pixels[idx+2] = 150;
      }
}

// Anchor roads used (white, 3px) — highlight with thick line
for (const ri of usedAnchorRoadIndices) {
  const road = anchorRoads[ri];
  const pl = road.polyline;
  for (let si = 0; si < pl.length - 1; si++) {
    const x0 = Math.round((pl[si].x - ox) / cs) - minGx;
    const z0 = Math.round((pl[si].z - oz) / cs) - minGz;
    const x1 = Math.round((pl[si+1].x - ox) / cs) - minGx;
    const z1 = Math.round((pl[si+1].z - oz) / cs) - minGz;
    // Draw 3px wide: centre + offset in each neighbour direction
    for (const [dx, dz] of [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
      bres(pixels, cropW, cropH, x0+dx, z0+dz, x1+dx, z1+dz, 255, 255, 255);
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

// Cross streets (magenta, 1px) — perpendicular to nearest anchor road
for (const seg of allCross) {
  bres(pixels, cropW, cropH,
    Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
    Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
    255, 0, 255);
}

// Parallel streets (cyan, 1px) — parallel to anchor road direction
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
