#!/usr/bin/env bun
/**
 * Experiment 007h: Terrain face segmentation.
 *
 * Segments the selected zone into terrain faces (sub-zones with consistent
 * slope direction) using elevation-band splitting (25th/50th/75th percentile).
 * For each face:
 *   1. Find the top and bottom boundary edges (by average elevation).
 *   2. Subdivide both edges at regular intervals (every CROSS_SPACING metres).
 *   3. Connect corresponding points — uphill cross streets (magenta).
 *   4. Between each pair of adjacent cross streets, draw parallel contour
 *      streets at PARALLEL_SPACING intervals (cyan).
 *
 * Rendering:
 *   Green / blue / orange / purple tint  — terrain faces
 *   White (2px)                          — face boundaries
 *   Magenta (3px)                        — cross streets (uphill)
 *   Cyan (3px)                           — parallel contour streets
 *   Yellow                               — zone boundary
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

const seed   = parseInt(process.argv[2]) || 42;
const gx     = parseInt(process.argv[3]) || 27;
const gz     = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007h-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const CROSS_SPACING    = 90;   // metres between uphill cross streets along edge
const PARALLEL_SPACING = 35;   // metres between contour-parallel streets (depth)
const MIN_FACE_CELLS   = 500;  // discard tiny faces
const MIN_STREET_LEN   = 20;   // metres — skip very short streets

console.log(`Terrain face segmentation: seed=${seed} gx=${gx} gz=${gz}`);
const t0 = performance.now();

// ---- Setup ----
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
const w = map.width, h = map.height;
const cs = map.cellSize;
const originX = map.originX, originZ = map.originZ;

const elev = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
if (!elev) { console.error('No elevation layer'); process.exit(1); }

console.log(`${zones.length} zones after subdivision`);

// ---- Zone selection ----
const candidates = zones.filter(z =>
  z.cells.length > 2000 &&
  z.cells.length < 50000 &&
  z.boundary && z.boundary.length >= 4 &&
  z.avgSlope !== undefined
);
if (candidates.length === 0) { console.error('No suitable zone found'); process.exit(1); }

candidates.sort((a, b) => {
  const aDist = Math.abs(a.centroidGx - w / 2) + Math.abs(a.centroidGz - h / 2);
  const bDist = Math.abs(b.centroidGx - w / 2) + Math.abs(b.centroidGz - h / 2);
  return aDist - bDist;
});
const zone = candidates[0];

console.log(`\nSelected zone: ${zone.cells.length} cells, centroid (${zone.centroidGx.toFixed(1)}, ${zone.centroidGz.toFixed(1)})`);
console.log(`  avgSlope: ${zone.avgSlope.toFixed(3)},  slopeDir: (${zone.slopeDir.x.toFixed(2)}, ${zone.slopeDir.z.toFixed(2)})`);

// ---- Elevation helpers ----
function elevAtGrid(igx, igz) {
  return elev.get(igx, igz);
}
function elevAtWorld(wx, wz) {
  const gxf = (wx - originX) / cs;
  const gzf = (wz - originZ) / cs;
  return elev.sample(gxf, gzf);
}

// ---- Step 1: Segment zone into faces by elevation band ----
// Collect all cell elevations, find quartile thresholds.
const cellElevs = zone.cells.map(c => ({ ...c, e: elevAtGrid(c.gx, c.gz) }));
const sorted = [...cellElevs].sort((a, b) => a.e - b.e);
const n = sorted.length;
const q25 = sorted[Math.floor(n * 0.25)].e;
const q50 = sorted[Math.floor(n * 0.50)].e;
const q75 = sorted[Math.floor(n * 0.75)].e;

console.log(`\nElevation bands — q25=${q25.toFixed(1)} q50=${q50.toFixed(1)} q75=${q75.toFixed(1)}`);

// Assign each cell to a band: 0 (lowest) .. 3 (highest)
const cellBand = new Map();
for (const c of cellElevs) {
  let band = 0;
  if (c.e > q75)      band = 3;
  else if (c.e > q50) band = 2;
  else if (c.e > q25) band = 1;
  cellBand.set(c.gz * w + c.gx, band);
}

// Flood-fill within each band to create connected faces.
// This respects the zone membership and produces potentially multiple
// components per band (e.g. if a band is split by a higher band in between).
const zoneSet = new Set();
for (const c of zone.cells) zoneSet.add(c.gz * w + c.gx);

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const faces = [];         // each: { cells: [{gx,gz}], band }
const visited = new Set();

for (const c of zone.cells) {
  const key = c.gz * w + c.gx;
  if (visited.has(key)) continue;

  const band = cellBand.get(key);
  const faceCells = [];
  const queue = [c];
  visited.add(key);

  while (queue.length > 0) {
    const cur = queue.pop();
    faceCells.push(cur);
    for (const [dx, dz] of DIRS4) {
      const nx = cur.gx + dx, nz = cur.gz + dz;
      const nk = nz * w + nx;
      if (!zoneSet.has(nk) || visited.has(nk)) continue;
      if (cellBand.get(nk) !== band) continue;
      visited.add(nk);
      queue.push({ gx: nx, gz: nz });
    }
  }

  if (faceCells.length >= MIN_FACE_CELLS) {
    faces.push({ cells: faceCells, band });
  }
}

console.log(`  ${faces.length} terrain faces (>= ${MIN_FACE_CELLS} cells)`);
for (const f of faces) {
  const avgE = f.cells.reduce((s, c) => s + elevAtGrid(c.gx, c.gz), 0) / f.cells.length;
  console.log(`    band=${f.band}  cells=${f.cells.length}  avgElev=${avgE.toFixed(1)}`);
}

// ---- Step 2: For each face, find boundary cells and split into top/bottom edges ----

/**
 * Boundary cells: cells in the face that have at least one 4-connected
 * neighbour outside the face (either outside the zone or in a different face/band).
 */
function getFaceBoundaryCells(faceCellSet) {
  const boundary = [];
  for (const key of faceCellSet) {
    const gxi = key % w;   // note: key = gz*w + gx so gx = key % w
    const gzi = (key - gxi) / w;
    for (const [dx, dz] of DIRS4) {
      const nk = (gzi + dz) * w + (gxi + dx);
      if (!faceCellSet.has(nk)) { boundary.push({ gx: gxi, gz: gzi }); break; }
    }
  }
  return boundary;
}

/**
 * Classify boundary cells: "top" (high elevation) or "bottom" (low elevation).
 * Strategy: sort boundary cells by elevation. Lower 40% = bottom, upper 40% = top.
 * The middle 20% are side-edge cells (not used for subdivision).
 */
function classifyEdgeCells(boundaryCells) {
  const sorted = [...boundaryCells].sort((a, b) =>
    elevAtGrid(a.gx, a.gz) - elevAtGrid(b.gx, b.gz)
  );
  const n = sorted.length;
  const topStart    = Math.floor(n * 0.60);
  const bottomEnd   = Math.floor(n * 0.40);
  return {
    bottomCells: sorted.slice(0, bottomEnd),
    topCells:    sorted.slice(topStart),
  };
}

/**
 * Build a world-coordinate polyline from a set of cells.
 * Sort cells along the dominant axis so the polyline is ordered (not a cloud).
 * Returns [{x, z}] in world coords.
 */
function cellsToOrderedPolyline(cells) {
  if (cells.length === 0) return [];
  if (cells.length === 1) {
    return [{ x: originX + cells[0].gx * cs, z: originZ + cells[0].gz * cs }];
  }

  // Find dominant axis by comparing spread in gx vs gz
  let minGx = Infinity, maxGx = -Infinity, minGz = Infinity, maxGz = -Infinity;
  for (const c of cells) {
    if (c.gx < minGx) minGx = c.gx;
    if (c.gx > maxGx) maxGx = c.gx;
    if (c.gz < minGz) minGz = c.gz;
    if (c.gz > maxGz) maxGz = c.gz;
  }
  const spreadX = maxGx - minGx;
  const spreadZ = maxGz - minGz;

  // Sort along dominant axis
  if (spreadX >= spreadZ) {
    cells = [...cells].sort((a, b) => a.gx - b.gx);
  } else {
    cells = [...cells].sort((a, b) => a.gz - b.gz);
  }

  return cells.map(c => ({ x: originX + c.gx * cs, z: originZ + c.gz * cs }));
}

// ---- Polyline utilities ----
function arcLengths(polyline) {
  const lens = [0];
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].x - polyline[i - 1].x;
    const dz = polyline[i].z - polyline[i - 1].z;
    lens.push(lens[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  return lens;
}

function sampleAtDist(polyline, lens, d) {
  const total = lens[lens.length - 1];
  if (d <= 0) return { ...polyline[0] };
  if (d >= total) return { ...polyline[polyline.length - 1] };
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

function polylineLength(polyline) {
  if (polyline.length < 2) return 0;
  const lens = arcLengths(polyline);
  return lens[lens.length - 1];
}

/**
 * Sample N+1 evenly-spaced points along a polyline (including endpoints).
 */
function subdividePolyline(polyline, spacing) {
  const lens = arcLengths(polyline);
  const total = lens[lens.length - 1];
  if (total < spacing) return [sampleAtDist(polyline, lens, 0), sampleAtDist(polyline, lens, total)];
  const count = Math.max(1, Math.floor(total / spacing));
  const pts = [];
  for (let i = 0; i <= count; i++) {
    pts.push(sampleAtDist(polyline, lens, (i / count) * total));
  }
  return pts;
}

// ---- Step 3 & 4: Per-face, generate cross streets and parallel streets ----
const allCrossStreets    = [];   // [{p1, p2}]
const allParallelStreets = [];   // [{p1, p2}]
const faceData           = [];   // for rendering

for (let fi = 0; fi < faces.length; fi++) {
  const face = faces[fi];
  const faceCellSet = new Set(face.cells.map(c => c.gz * w + c.gx));

  const boundaryCells = getFaceBoundaryCells(faceCellSet);
  const { bottomCells, topCells } = classifyEdgeCells(boundaryCells);

  const bottomPoly = cellsToOrderedPolyline(bottomCells);
  const topPoly    = cellsToOrderedPolyline(topCells);

  const bottomLen = polylineLength(bottomPoly);
  const topLen    = polylineLength(topPoly);

  console.log(`\n  Face ${fi} (band=${face.band}): boundary=${boundaryCells.length}  bottom=${bottomCells.length}  top=${topCells.length}`);
  console.log(`    bottomLen=${bottomLen.toFixed(0)}m  topLen=${topLen.toFixed(0)}m`);

  if (bottomPoly.length < 2 || topPoly.length < 2 || bottomLen < MIN_STREET_LEN || topLen < MIN_STREET_LEN) {
    console.log('    Skipping face — edges too short');
    faceData.push({ face, boundaryCells, crossStreets: [], parallelStreets: [] });
    continue;
  }

  // Subdivide both edges at CROSS_SPACING intervals
  const bottomPts = subdividePolyline(bottomPoly, CROSS_SPACING);
  const topPts    = subdividePolyline(topPoly,    CROSS_SPACING);

  // Align the number of points: use the min count
  const numPts = Math.min(bottomPts.length, topPts.length);

  console.log(`    cross street pairs: ${numPts - 1} strips (${numPts} points per edge)`);

  // Step 3: Connect corresponding points — uphill cross streets
  const faceCStar = [];
  for (let i = 0; i < numPts; i++) {
    const b = bottomPts[i];
    const t = topPts[i];
    const len = Math.sqrt((t.x - b.x) ** 2 + (t.z - b.z) ** 2);
    if (len < MIN_STREET_LEN) continue;
    faceCStar.push([b, t]);
    allCrossStreets.push([b, t]);
  }

  // Step 4: Fill each strip between adjacent cross streets with parallel streets
  const facePStar = [];
  for (let i = 0; i < faceCStar.length - 1; i++) {
    const leftBot  = faceCStar[i][0];
    const leftTop  = faceCStar[i][1];
    const rightBot = faceCStar[i + 1][0];
    const rightTop = faceCStar[i + 1][1];

    // Find the average depth of the strip (height of cross street)
    const leftLen  = Math.sqrt((leftTop.x  - leftBot.x)  ** 2 + (leftTop.z  - leftBot.z)  ** 2);
    const rightLen = Math.sqrt((rightTop.x - rightBot.x) ** 2 + (rightTop.z - rightBot.z) ** 2);
    const stripDepth = (leftLen + rightLen) / 2;

    const numParallel = Math.floor(stripDepth / PARALLEL_SPACING);
    if (numParallel < 1) continue;

    for (let j = 1; j < numParallel; j++) {
      const t = j / numParallel;
      // Interpolate along the left cross street
      const lx = leftBot.x  + t * (leftTop.x  - leftBot.x);
      const lz = leftBot.z  + t * (leftTop.z  - leftBot.z);
      // Interpolate along the right cross street
      const rx = rightBot.x + t * (rightTop.x - rightBot.x);
      const rz = rightBot.z + t * (rightTop.z - rightBot.z);

      const len = Math.sqrt((rx - lx) ** 2 + (rz - lz) ** 2);
      if (len < MIN_STREET_LEN) continue;

      const seg = [{ x: lx, z: lz }, { x: rx, z: rz }];
      facePStar.push(seg);
      allParallelStreets.push(seg);
    }
  }

  console.log(`    parallel streets: ${facePStar.length}`);
  faceData.push({ face, boundaryCells, crossStreets: faceCStar, parallelStreets: facePStar });
}

console.log(`\nTotal cross streets: ${allCrossStreets.length}`);
console.log(`Total parallel streets: ${allParallelStreets.length}`);

// ---- Render ----
const pixels = new Uint8Array(w * h * 3);

// Terrain base (dark elevation shading)
{
  let eMin = Infinity, eMax = -Infinity;
  for (let iz = 0; iz < h; iz++)
    for (let ix = 0; ix < w; ix++) {
      const v = elev.get(ix, iz);
      if (v < eMin) eMin = v;
      if (v > eMax) eMax = v;
    }
  const range = eMax - eMin || 1;
  for (let iz = 0; iz < h; iz++)
    for (let ix = 0; ix < w; ix++) {
      const v = (elev.get(ix, iz) - eMin) / range;
      const idx = (iz * w + ix) * 3;
      pixels[idx]     = Math.round(30 + v * 40);
      pixels[idx + 1] = Math.round(40 + v * 30);
      pixels[idx + 2] = Math.round(20 + v * 20);
    }
}

// Water mask
const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
if (waterMask) {
  for (let iz = 0; iz < h; iz++)
    for (let ix = 0; ix < w; ix++)
      if (waterMask.get(ix, iz) > 0) {
        const idx = (iz * w + ix) * 3;
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
      }
}

// All zones — faint warm tint
for (const z of zones) {
  for (const c of z.cells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx]     = Math.min(255, pixels[idx]     + 12);
    pixels[idx + 1] = Math.min(255, pixels[idx + 1] + 8);
    pixels[idx + 2] = Math.min(255, pixels[idx + 2] + 6);
  }
}

// Terrain faces — distinct tints per band
const FACE_TINTS = [
  [30, 80, 30],    // band 0 — low elevation — green
  [20, 50, 100],   // band 1 — blue
  [100, 60, 20],   // band 2 — orange
  [80, 20, 100],   // band 3 — purple
];

for (let fi = 0; fi < faceData.length; fi++) {
  const { face } = faceData[fi];
  const tint = FACE_TINTS[face.band % FACE_TINTS.length];
  for (const c of face.cells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx]     = tint[0];
    pixels[idx + 1] = tint[1];
    pixels[idx + 2] = tint[2];
  }
}

// Existing roads (grey)
const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
if (roadGrid) {
  for (let iz = 0; iz < h; iz++)
    for (let ix = 0; ix < w; ix++)
      if (roadGrid.get(ix, iz) > 0) {
        const idx = (iz * w + ix) * 3;
        pixels[idx] = 180; pixels[idx + 1] = 180; pixels[idx + 2] = 180;
      }
}

// Zone boundary (yellow, 1px)
{
  const bnd = zone.boundary;
  for (let i = 0; i < bnd.length; i++) {
    const p1 = bnd[i], p2 = bnd[(i + 1) % bnd.length];
    bresenham(pixels, w, h,
      Math.round((p1.x - originX) / cs), Math.round((p1.z - originZ) / cs),
      Math.round((p2.x - originX) / cs), Math.round((p2.z - originZ) / cs),
      255, 255, 0, 1);
  }
}

// Face boundary cells (white, 2px)
for (const { boundaryCells } of faceData) {
  for (const c of boundaryCells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx] = 220; pixels[idx + 1] = 220; pixels[idx + 2] = 220;
  }
}

// Parallel contour streets (cyan, 3px)
for (const seg of allParallelStreets) {
  const x1 = Math.round((seg[0].x - originX) / cs);
  const z1 = Math.round((seg[0].z - originZ) / cs);
  const x2 = Math.round((seg[1].x - originX) / cs);
  const z2 = Math.round((seg[1].z - originZ) / cs);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      bresenham(pixels, w, h, x1 + dx, z1 + dz, x2 + dx, z2 + dz, 0, 220, 220, 1);
}

// Cross streets — uphill connections (magenta, 3px)
for (const seg of allCrossStreets) {
  const x1 = Math.round((seg[0].x - originX) / cs);
  const z1 = Math.round((seg[0].z - originZ) / cs);
  const x2 = Math.round((seg[1].x - originX) / cs);
  const z2 = Math.round((seg[1].z - originZ) / cs);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      bresenham(pixels, w, h, x1 + dx, z1 + dz, x2 + dx, z2 + dz, 255, 0, 255, 1);
}

// Write image
const header = `P6\n${w} ${h}\n255\n`;
const basePath = `${outDir}/ribbon-zone-seed${seed}`;
writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
console.log(`\nWritten to ${basePath}.png`);
console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// ---- Bresenham line draw ----
function bresenham(pixels, w, h, x0, y0, x1, y1, r, g, b) {
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
    if (e2 <  dx) { err += dx; y += sy; }
  }
}
