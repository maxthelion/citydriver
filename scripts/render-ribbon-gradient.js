#!/usr/bin/env bun
/**
 * Experiment 007e: Gradient construction lines.
 *
 * Shoots uphill construction lines from the base edge of a zone, marks
 * measured intervals along each line, then connects corresponding points
 * between adjacent lines to form contour-following cross streets.
 * Every 3rd construction line is promoted to a visible street.
 *
 * Algorithm:
 * 1. Find base edge — lowest-elevation segment of the zone boundary.
 * 2. Mark regular points (BASE_SPACING) along the base edge.
 * 3. From each point, walk uphill following the gradient (highest elevation
 *    neighbour that's still inside the zone), step by step.
 * 4. Mark measured intervals (CONTOUR_INTERVAL) along each construction line.
 * 5. Connect corresponding points between adjacent construction lines —
 *    these follow contours naturally.
 * 6. Promote every PROMOTE_NTH construction line to a visible cross street.
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
const outDir = process.argv[5] || 'experiments/007e-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const BASE_SPACING    = 35;   // metres between construction line origins on base edge
const CONTOUR_INTERVAL = 90;  // metres between grid points along each construction line
const PROMOTE_NTH     = 3;    // every Nth construction line becomes a visible road
const STEP_SIZE       = 1;    // grid cells per uphill step
const MAX_STEPS       = 2000; // safety limit

console.log(`Gradient construction lines: seed=${seed} gx=${gx} gz=${gz}`);
const t0 = performance.now();

const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });

// Run through tick 4 (spatial layers)
runToStep(strategy, 'spatial');

// Add zone boundary roads + subdivide
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

// Pick a medium-large zone with proper metadata
const candidates = zones.filter(z =>
  z.cells.length > 2000 &&
  z.cells.length < 50000 &&
  z.boundary && z.boundary.length >= 4 &&
  z.avgSlope !== undefined
);

if (candidates.length === 0) {
  console.error('No suitable zone found');
  process.exit(1);
}

// Pick one nearest to centre
candidates.sort((a, b) => {
  const aDist = Math.abs(a.centroidGx - w/2) + Math.abs(a.centroidGz - h/2);
  const bDist = Math.abs(b.centroidGx - w/2) + Math.abs(b.centroidGz - h/2);
  return aDist - bDist;
});
const zone = candidates[0];

console.log(`\nSelected zone: ${zone.cells.length} cells, centroid (${zone.centroidGx.toFixed(1)}, ${zone.centroidGz.toFixed(1)})`);
console.log(`  boundary: ${zone.boundary.length} vertices`);
console.log(`  avgSlope: ${zone.avgSlope.toFixed(3)}`);
console.log(`  slopeDir: (${zone.slopeDir.x.toFixed(2)}, ${zone.slopeDir.z.toFixed(2)})`);

// Build a fast zone membership set (grid cells)
const zoneSet = new Set();
for (const c of zone.cells) {
  zoneSet.add(c.gz * w + c.gx);
}

// ---- Helper: point-in-polygon for zone boundary ----
function pointInPoly(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ---- Helper: world coords -> elevation ----
function elevAt(wx, wz) {
  const gxf = (wx - originX) / cs;
  const gzf = (wz - originZ) / cs;
  return elev.sample(gxf, gzf);
}

// ---- Helper: grid coords -> elevation ----
function elevAtGrid(igx, igz) {
  return elev.get(igx, igz);
}

// ---- Step 1: Find the base edge (lowest-elevation contiguous run of boundary) ----
// Because zones may have many short boundary segments, we find the single vertex
// with the globally lowest elevation, then extend outward along the boundary
// while vertices stay within a tolerance band above that minimum.
const boundary = zone.boundary;
const n = boundary.length;

// Compute elevation at every boundary vertex
const vertElev = boundary.map(p => elevAt(p.x, p.z));
const globalMin = Math.min(...vertElev);
const globalMax = Math.max(...vertElev);
const elevRange = globalMax - globalMin || 1;

// Threshold: accept vertices whose elevation is within 15% of the full range above min
const baseThreshold = globalMin + elevRange * 0.15;

// Find the vertex index with the globally lowest elevation
let lowestVertIdx = 0;
let lowestVert = Infinity;
for (let i = 0; i < n; i++) {
  if (vertElev[i] < lowestVert) { lowestVert = vertElev[i]; lowestVertIdx = i; }
}

// Expand from that vertex in both directions while elevation stays below threshold
let startIdx = lowestVertIdx;
let endIdx   = lowestVertIdx;
for (let step = 1; step < n; step++) {
  const prevIdx = (lowestVertIdx - step + n) % n;
  if (vertElev[prevIdx] > baseThreshold) break;
  startIdx = prevIdx;
}
for (let step = 1; step < n; step++) {
  const nextIdx = (lowestVertIdx + step) % n;
  if (vertElev[nextIdx] > baseThreshold) break;
  endIdx = nextIdx;
}

// Collect the base-edge polyline vertices in order
const basePolyline = [];
{
  let i = startIdx;
  while (true) {
    basePolyline.push(boundary[i]);
    if (i === endIdx) break;
    i = (i + 1) % n;
    if (i === startIdx) break; // safety
  }
}

// Compute total length of the base edge polyline
let baseLen = 0;
for (let i = 0; i < basePolyline.length - 1; i++) {
  const dx = basePolyline[i+1].x - basePolyline[i].x;
  const dz = basePolyline[i+1].z - basePolyline[i].z;
  baseLen += Math.sqrt(dx*dx + dz*dz);
}

// For rendering, keep first and last vertices as baseP1/baseP2
const baseP1 = basePolyline[0];
const baseP2 = basePolyline[basePolyline.length - 1];

// Average elevation of base edge vertices
const lowestAvgElev = basePolyline.reduce((s, p) => s + elevAt(p.x, p.z), 0) / basePolyline.length;

console.log(`  base edge: ${basePolyline.length} verts, length=${baseLen.toFixed(1)}m, avgElev=${lowestAvgElev.toFixed(1)}`);

// ---- Step 2: Sample points evenly along the base edge polyline ----
// Compute cumulative arc lengths of the base polyline
const baseLens = [0];
for (let i = 1; i < basePolyline.length; i++) {
  const dx = basePolyline[i].x - basePolyline[i-1].x;
  const dz = basePolyline[i].z - basePolyline[i-1].z;
  baseLens.push(baseLens[i-1] + Math.sqrt(dx*dx + dz*dz));
}

function sampleBasePolyline(d) {
  if (d <= 0) return { ...basePolyline[0] };
  if (d >= baseLens[baseLens.length - 1]) return { ...basePolyline[basePolyline.length - 1] };
  let lo = 0, hi = baseLens.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (baseLens[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - baseLens[lo]) / (baseLens[hi] - baseLens[lo]);
  return {
    x: basePolyline[lo].x + t * (basePolyline[hi].x - basePolyline[lo].x),
    z: basePolyline[lo].z + t * (basePolyline[hi].z - basePolyline[lo].z),
  };
}

const basePoints = [];
const numBasePoints = Math.max(2, Math.floor(baseLen / BASE_SPACING));
for (let i = 0; i <= numBasePoints; i++) {
  basePoints.push(sampleBasePolyline((i / numBasePoints) * baseLen));
}

console.log(`  base points: ${basePoints.length} (every ~${BASE_SPACING}m)`);

// ---- Step 3: Walk uphill from each base point ----
// Neighbours (8-connected)
const NEIGHBOURS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

/**
 * Walk uphill from a world-coordinate start point.
 * Returns an array of world-coordinate {x, z} points (the polyline).
 */
function walkUphill(startX, startZ) {
  const line = [{ x: startX, z: startZ }];

  let curGx = Math.round((startX - originX) / cs);
  let curGz = Math.round((startZ - originZ) / cs);

  for (let step = 0; step < MAX_STEPS; step++) {
    let bestElev = -Infinity;
    let bestGx = -1, bestGz = -1;

    for (const [dx, dz] of NEIGHBOURS) {
      const nx = curGx + dx;
      const nz = curGz + dz;
      // Must be within zone
      if (!zoneSet.has(nz * w + nx)) continue;
      const e = elevAtGrid(nx, nz);
      if (e > bestElev) {
        bestElev = e;
        bestGx = nx;
        bestGz = nz;
      }
    }

    // No uphill neighbour in zone, or stuck at peak
    if (bestGx === -1) break;
    if (elevAtGrid(curGx, curGz) >= bestElev - 0.001) {
      // Elevation not increasing — we're at a local maximum
      break;
    }

    curGx = bestGx;
    curGz = bestGz;
    line.push({
      x: originX + curGx * cs,
      z: originZ + curGz * cs,
    });
  }

  return line;
}

// Compute cumulative arc-lengths along a polyline
function arcLengths(polyline) {
  const lens = [0];
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].x - polyline[i-1].x;
    const dz = polyline[i].z - polyline[i-1].z;
    lens.push(lens[i-1] + Math.sqrt(dx*dx + dz*dz));
  }
  return lens;
}

// Sample a point at a given arc-length distance along a polyline
function sampleAtDist(polyline, lens, d) {
  if (d <= 0) return { ...polyline[0] };
  if (d >= lens[lens.length - 1]) return { ...polyline[polyline.length - 1] };
  // Binary search
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

// Build construction lines and their measured grid points
const constructionLines = [];  // each: { polyline, gridPoints: [{x,z,dist}] }

for (const bp of basePoints) {
  const polyline = walkUphill(bp.x, bp.z);
  if (polyline.length < 2) continue;

  const lens = arcLengths(polyline);
  const totalLen = lens[lens.length - 1];

  // Mark grid points at CONTOUR_INTERVAL intervals
  const gridPoints = [];
  for (let d = CONTOUR_INTERVAL; d <= totalLen; d += CONTOUR_INTERVAL) {
    gridPoints.push({ ...sampleAtDist(polyline, lens, d), dist: d });
  }

  constructionLines.push({ polyline, gridPoints });
}

console.log(`  construction lines: ${constructionLines.length}`);
console.log(`  avg grid points per line: ${(constructionLines.reduce((s,l) => s + l.gridPoints.length, 0) / constructionLines.length).toFixed(1)}`);

// ---- Step 5: Connect corresponding grid points between adjacent construction lines ----
const contourConnections = [];  // [{p1, p2}] — the "parallel" / contour-following streets

for (let k = 0; k < constructionLines.length - 1; k++) {
  const lineA = constructionLines[k];
  const lineB = constructionLines[k + 1];

  const mapA = new Map(lineA.gridPoints.map(p => [p.dist, p]));
  const mapB = new Map(lineB.gridPoints.map(p => [p.dist, p]));

  for (const [dist, pA] of mapA) {
    const pB = mapB.get(dist);
    if (!pB) continue;

    const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
    if (segLen < 5) continue;  // skip degenerate connections

    contourConnections.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
  }
}

// ---- Step 6: Promoted cross streets (every PROMOTE_NTH construction line) ----
const promotedLines = constructionLines
  .filter((_, i) => i % PROMOTE_NTH === 0)
  .map(l => l.polyline);

console.log(`  contour connections: ${contourConnections.length}`);
console.log(`  promoted cross streets: ${promotedLines.length}`);

// ---- Render ----
const pixels = new Uint8Array(w * h * 3);

// Terrain base
const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
{
  const bounds = elev.bounds ? elev.bounds() : { min: 0, max: 1 };
  // Compute bounds manually if needed
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
      pixels[idx]   = Math.round(30 + v * 40);
      pixels[idx+1] = Math.round(40 + v * 30);
      pixels[idx+2] = Math.round(20 + v * 20);
    }
}
if (waterMask) {
  for (let iz = 0; iz < h; iz++)
    for (let ix = 0; ix < w; ix++)
      if (waterMask.get(ix, iz) > 0) {
        const idx = (iz * w + ix) * 3;
        pixels[idx] = 15; pixels[idx+1] = 30; pixels[idx+2] = 60;
      }
}

// All zones — faint tint
for (const z of zones) {
  for (const c of z.cells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx]   = Math.min(255, pixels[idx]   + 15);
    pixels[idx+1] = Math.min(255, pixels[idx+1] + 10);
    pixels[idx+2] = Math.min(255, pixels[idx+2] + 8);
  }
}

// Highlight selected zone — green tint
for (const c of zone.cells) {
  const idx = (c.gz * w + c.gx) * 3;
  pixels[idx]   = 50;
  pixels[idx+1] = 90;
  pixels[idx+2] = 50;
}

// Roads (white)
const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
if (roadGrid) {
  for (let iz = 0; iz < h; iz++)
    for (let ix = 0; ix < w; ix++)
      if (roadGrid.get(ix, iz) > 0) {
        const idx = (iz * w + ix) * 3;
        pixels[idx] = 180; pixels[idx+1] = 180; pixels[idx+2] = 180;
      }
}

// Zone boundary (yellow)
for (let i = 0; i < boundary.length; i++) {
  const p1 = boundary[i], p2 = boundary[(i+1) % boundary.length];
  bresenham(pixels, w, h,
    Math.round((p1.x - originX) / cs), Math.round((p1.z - originZ) / cs),
    Math.round((p2.x - originX) / cs), Math.round((p2.z - originZ) / cs),
    255, 255, 0, 1);
}

// Base edge (bright red, 3px) — draw every segment of the base polyline
for (let i = 0; i < basePolyline.length - 1; i++) {
  const bx1 = Math.round((basePolyline[i].x   - originX) / cs);
  const bz1 = Math.round((basePolyline[i].z   - originZ) / cs);
  const bx2 = Math.round((basePolyline[i+1].x - originX) / cs);
  const bz2 = Math.round((basePolyline[i+1].z - originZ) / cs);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      bresenham(pixels, w, h, bx1+dx, bz1+dz, bx2+dx, bz2+dz, 255, 30, 30, 1);
}

// Construction lines (thin dark green, 1px)
for (const { polyline } of constructionLines) {
  for (let i = 0; i < polyline.length - 1; i++) {
    bresenham(pixels, w, h,
      Math.round((polyline[i].x   - originX) / cs), Math.round((polyline[i].z   - originZ) / cs),
      Math.round((polyline[i+1].x - originX) / cs), Math.round((polyline[i+1].z - originZ) / cs),
      0, 100, 0, 1);
  }
}

// Contour connections (cyan, 3px)
for (const seg of contourConnections) {
  const p1gx = Math.round((seg[0].x - originX) / cs);
  const p1gz = Math.round((seg[0].z - originZ) / cs);
  const p2gx = Math.round((seg[1].x - originX) / cs);
  const p2gz = Math.round((seg[1].z - originZ) / cs);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      bresenham(pixels, w, h, p1gx+dx, p1gz+dz, p2gx+dx, p2gz+dz, 0, 255, 255, 1);
}

// Promoted cross streets (magenta, 3px)
for (const polyline of promotedLines) {
  for (let i = 0; i < polyline.length - 1; i++) {
    const x1 = Math.round((polyline[i].x   - originX) / cs);
    const z1 = Math.round((polyline[i].z   - originZ) / cs);
    const x2 = Math.round((polyline[i+1].x - originX) / cs);
    const z2 = Math.round((polyline[i+1].z - originZ) / cs);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        bresenham(pixels, w, h, x1+dx, z1+dz, x2+dx, z2+dz, 255, 0, 255, 1);
  }
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
      pixels[idx] = r; pixels[idx+1] = g; pixels[idx+2] = b;
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
  }
}
