#!/usr/bin/env bun
/**
 * Experiment 007g: Contour-line streets.
 *
 * Generates parallel streets by tracing actual elevation contour lines through
 * a zone. Contour lines ARE level streets by definition — the most
 * terrain-authentic approach.
 *
 * Algorithm:
 * 1. Find the elevation range within the zone (min → max).
 * 2. At every CONTOUR_INTERVAL metres of elevation, trace the contour line
 *    through the zone by scanning all zone cells and collecting cells where
 *    the elevation crosses that level (cell ≥ h, neighbour < h).
 * 3. Chain contour cells into polylines via BFS walk.
 * 4. Simplify each polyline with Ramer-Douglas-Peucker (tolerance ~15 m).
 * 5. Discard segments shorter than MIN_SEGMENT_LEN metres.
 * 6. Generate cross streets by connecting adjacent contour lines at 90 m
 *    intervals — for each sample point on the lower contour, find the nearest
 *    point on the upper contour (if within MAX_CROSS_DIST metres).
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

const seed    = parseInt(process.argv[2]) || 42;
const gx      = parseInt(process.argv[3]) || 27;
const gz      = parseInt(process.argv[4]) || 95;
const outDir  = process.argv[5] || 'experiments/007g-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const CONTOUR_INTERVAL  = 2;    // metres between contour levels
const RDP_TOLERANCE     = 15;   // metres — RDP simplification tolerance
const MIN_SEGMENT_LEN   = 40;   // metres — discard contour segments shorter than this
const CROSS_SPACING     = 90;   // metres — interval along contour for cross-street samples
const MAX_CROSS_DIST    = 200;  // metres — max distance for a cross-street connection

console.log(`Contour-line streets: seed=${seed} gx=${gx} gz=${gz}`);
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

const zones   = map.developmentZones;
const w       = map.width;
const h       = map.height;
const cs      = map.cellSize;
const originX = map.originX;
const originZ = map.originZ;

const elev = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
if (!elev) { console.error('No elevation layer'); process.exit(1); }

console.log(`${zones.length} zones after subdivision`);

// ---- Pick a medium-large zone ----
const candidates = zones.filter(z =>
  z.cells.length > 2000 &&
  z.cells.length < 50000 &&
  z.boundary && z.boundary.length >= 4 &&
  z.avgSlope !== undefined
);
if (candidates.length === 0) { console.error('No suitable zone found'); process.exit(1); }

// Prefer the zone nearest the map centre
candidates.sort((a, b) => {
  const aDist = Math.abs(a.centroidGx - w / 2) + Math.abs(a.centroidGz - h / 2);
  const bDist = Math.abs(b.centroidGx - w / 2) + Math.abs(b.centroidGz - h / 2);
  return aDist - bDist;
});
const zone = candidates[0];

console.log(`\nSelected zone: ${zone.cells.length} cells, centroid (${zone.centroidGx.toFixed(1)}, ${zone.centroidGz.toFixed(1)})`);
console.log(`  boundary: ${zone.boundary.length} vertices`);
console.log(`  avgSlope: ${zone.avgSlope.toFixed(3)}`);

// Build a fast zone membership set
const zoneSet = new Set();
for (const c of zone.cells) zoneSet.add(c.gz * w + c.gx);

// ---- Helpers ----
function elevAtGrid(igx, igz) { return elev.get(igx, igz); }
function gridToWorld(igx, igz) {
  return { x: originX + igx * cs, z: originZ + igz * cs };
}
function dist2(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
}
function dist(a, b) { return Math.sqrt(dist2(a, b)); }

// ---- Step 1: Elevation range within zone ----
let zoneElevMin = Infinity, zoneElevMax = -Infinity;
for (const c of zone.cells) {
  const e = elevAtGrid(c.gx, c.gz);
  if (e < zoneElevMin) zoneElevMin = e;
  if (e > zoneElevMax) zoneElevMax = e;
}
const elevRange = zoneElevMax - zoneElevMin;
console.log(`  elevation range: ${zoneElevMin.toFixed(1)} – ${zoneElevMax.toFixed(1)} m (range ${elevRange.toFixed(1)} m)`);

// ---- Step 2 & 3: Trace contour lines at each level ----
// For level h: a zone cell (gx, gz) is a contour cell if its elevation >= h
// and at least one 4-connected neighbour that is also in the zone has elevation < h.

const DIRS4 = [[1,0],[-1,0],[0,1],[0,-1]];

/**
 * Find all contour cells for level h, then chain them into polylines.
 * Returns an array of polylines, each as an array of {x,z} world-coord points.
 */
function traceContour(h) {
  // Collect contour cells
  const contourCells = new Set();
  for (const c of zone.cells) {
    const e = elevAtGrid(c.gx, c.gz);
    if (e < h) continue;  // cell is below — not a crossing cell
    // Check 4-connected neighbours for a below-h neighbour in the zone
    let hasBelowNeighbour = false;
    for (const [dx, dz] of DIRS4) {
      const nx = c.gx + dx, nz = c.gz + dz;
      if (!zoneSet.has(nz * w + nx)) continue;
      if (elevAtGrid(nx, nz) < h) { hasBelowNeighbour = true; break; }
    }
    if (hasBelowNeighbour) contourCells.add(c.gz * w + c.gx);
  }

  if (contourCells.size === 0) return [];

  // Chain contour cells into polylines via BFS
  const visited = new Set();
  const polylines = [];

  for (const key of contourCells) {
    if (visited.has(key)) continue;

    // BFS from this seed cell, walking through contour neighbours
    const chain = [];
    const queue = [key];
    visited.add(key);

    while (queue.length > 0) {
      const cur = queue.shift();
      chain.push(cur);
      const curGx = cur % w;
      const curGz = Math.floor(cur / w);

      // Walk 8-connected to stay connected through diagonal touching
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nk = (curGz + dz) * w + (curGx + dx);
          if (contourCells.has(nk) && !visited.has(nk)) {
            visited.add(nk);
            queue.push(nk);
          }
        }
      }
    }

    // Convert cell keys to world-coord points
    const pts = chain.map(k => {
      const cgx = k % w;
      const cgz = Math.floor(k / w);
      return gridToWorld(cgx, cgz);
    });

    polylines.push(pts);
  }

  return polylines;
}

// ---- Step 4: RDP simplification ----
function rdpSimplify(pts, tolerance) {
  if (pts.length <= 2) return pts;
  const tol2 = tolerance * tolerance;

  function perpendicularDist2(p, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 === 0) return dist2(p, a);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
    return dist2(p, { x: a.x + t * dx, z: a.z + t * dz });
  }

  function rdp(start, end, result) {
    let maxD2 = 0, maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d2 = perpendicularDist2(pts[i], pts[start], pts[end]);
      if (d2 > maxD2) { maxD2 = d2; maxIdx = i; }
    }
    if (maxD2 > tol2) {
      rdp(start, maxIdx, result);
      result.push(pts[maxIdx]);
      rdp(maxIdx, end, result);
    }
  }

  const result = [pts[0]];
  rdp(0, pts.length - 1, result);
  result.push(pts[pts.length - 1]);
  return result;
}

// ---- Step 5: Compute polyline length ----
function polylineLen(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i], pts[i-1]);
  return len;
}

// ---- Trace all contour levels ----
const contourLevels = [];  // [{h, polylines: [[{x,z},...], ...]}]

const levelMin = Math.ceil(zoneElevMin / CONTOUR_INTERVAL) * CONTOUR_INTERVAL;
const levelMax = Math.floor(zoneElevMax / CONTOUR_INTERVAL) * CONTOUR_INTERVAL;

console.log(`\nTracing contours from ${levelMin} to ${levelMax} m (every ${CONTOUR_INTERVAL} m)...`);

for (let h = levelMin; h <= levelMax; h += CONTOUR_INTERVAL) {
  const raw = traceContour(h);
  // Simplify and filter
  const simplified = raw
    .map(pts => rdpSimplify(pts, RDP_TOLERANCE))
    .filter(pts => pts.length >= 2 && polylineLen(pts) >= MIN_SEGMENT_LEN);
  if (simplified.length > 0) {
    contourLevels.push({ h, polylines: simplified });
  }
}

const totalContourSegs = contourLevels.reduce((s, l) => s + l.polylines.length, 0);
console.log(`  ${contourLevels.length} levels with contours, ${totalContourSegs} total segments`);

// ---- Step 6: Cross streets between adjacent contour levels ----
// Arc-length utilities for sampling along a polyline
function arcLengths(pts) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i-1] + dist(pts[i], pts[i-1]));
  return lens;
}

function sampleAtDist(pts, lens, d) {
  if (d <= 0) return { ...pts[0] };
  if (d >= lens[lens.length - 1]) return { ...pts[pts.length - 1] };
  let lo = 0, hi = lens.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lens[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - lens[lo]) / (lens[hi] - lens[lo]);
  return {
    x: pts[lo].x + t * (pts[hi].x - pts[lo].x),
    z: pts[lo].z + t * (pts[hi].z - pts[lo].z),
  };
}

/**
 * Find the closest point on any polyline in `upper` to point `p`.
 * Returns the closest world-coord point, or null if beyond MAX_CROSS_DIST.
 */
function closestOnContour(p, upperPolylines) {
  let bestDist = MAX_CROSS_DIST;
  let bestPt = null;

  for (const pts of upperPolylines) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      let t = 0;
      if (len2 > 0) t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
      const cx = a.x + t * dx, cz = a.z + t * dz;
      const d = Math.sqrt((p.x - cx) ** 2 + (p.z - cz) ** 2);
      if (d < bestDist) { bestDist = d; bestPt = { x: cx, z: cz }; }
    }
  }

  return bestPt;
}

const crossStreets = [];  // [{p1, p2}]

for (let i = 0; i < contourLevels.length - 1; i++) {
  const lower = contourLevels[i];
  const upper = contourLevels[i + 1];

  for (const lowerPts of lower.polylines) {
    const lens = arcLengths(lowerPts);
    const totalLen = lens[lens.length - 1];
    const numSamples = Math.max(1, Math.floor(totalLen / CROSS_SPACING));

    for (let s = 0; s <= numSamples; s++) {
      const d = (s / numSamples) * totalLen;
      const p = sampleAtDist(lowerPts, lens, d);
      const q = closestOnContour(p, upper.polylines);
      if (q) {
        crossStreets.push([p, q]);
      }
    }
  }
}

console.log(`  cross streets: ${crossStreets.length}`);
console.log(`  time so far: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// ---- Render ----
const pixels = new Uint8Array(w * h * 3);
const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;

// Terrain base (grayscale elevation)
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
      pixels[idx]   = Math.round(30 + v * 40);
      pixels[idx+1] = Math.round(40 + v * 30);
      pixels[idx+2] = Math.round(20 + v * 20);
    }
}

// Water
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

// Selected zone — green tint
for (const c of zone.cells) {
  const idx = (c.gz * w + c.gx) * 3;
  pixels[idx]   = 50;
  pixels[idx+1] = 90;
  pixels[idx+2] = 50;
}

// Existing roads (white)
const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
if (roadGrid) {
  for (let iz = 0; iz < h; iz++)
    for (let ix = 0; ix < w; ix++)
      if (roadGrid.get(ix, iz) > 0) {
        const idx = (iz * w + ix) * 3;
        pixels[idx] = 180; pixels[idx+1] = 180; pixels[idx+2] = 180;
      }
}

// Zone boundary (yellow, 1px)
const boundary = zone.boundary;
for (let i = 0; i < boundary.length; i++) {
  const p1 = boundary[i], p2 = boundary[(i+1) % boundary.length];
  bresenham(pixels, w, h,
    Math.round((p1.x - originX) / cs), Math.round((p1.z - originZ) / cs),
    Math.round((p2.x - originX) / cs), Math.round((p2.z - originZ) / cs),
    255, 255, 0, 1);
}

// Contour streets (cyan, 3px)
for (const { polylines } of contourLevels) {
  for (const pts of polylines) {
    for (let i = 0; i < pts.length - 1; i++) {
      const x1 = Math.round((pts[i].x   - originX) / cs);
      const z1 = Math.round((pts[i].z   - originZ) / cs);
      const x2 = Math.round((pts[i+1].x - originX) / cs);
      const z2 = Math.round((pts[i+1].z - originZ) / cs);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          bresenham(pixels, w, h, x1+dx, z1+dz, x2+dx, z2+dz, 0, 220, 255, 1);
    }
  }
}

// Cross streets (magenta, 2px)
for (const [p, q] of crossStreets) {
  const x1 = Math.round((p.x - originX) / cs);
  const z1 = Math.round((p.z - originZ) / cs);
  const x2 = Math.round((q.x - originX) / cs);
  const z2 = Math.round((q.z - originZ) / cs);
  for (let dz = -1; dz <= 1; dz += 2)
    for (let dx = -1; dx <= 1; dx += 2)
      bresenham(pixels, w, h, x1+dx, z1+dz, x2+dx, z2+dz, 255, 0, 220, 1);
  bresenham(pixels, w, h, x1, z1, x2, z2, 255, 0, 220, 1);
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
