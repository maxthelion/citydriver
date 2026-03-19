#!/usr/bin/env bun
/**
 * Experiment 007f: Multi-edge construction lines.
 *
 * Fixes the coverage gap in 007e (which only started from the lowest edge,
 * leaving flat or opposite sides of the zone empty) by starting construction
 * lines from ALL boundary edges. Lines walk inward toward the zone centroid,
 * meeting in the middle.
 *
 * Algorithm:
 * 1. Walk the entire zone boundary perimeter, placing starting points every
 *    BASE_SPACING (35 m).
 * 2. For each starting point, walk INWARD toward the zone centroid. At each
 *    step the preferred direction is 70% toward centroid + 30% toward the
 *    highest neighbour. Among 8-connected in-zone neighbours, pick the one
 *    whose direction most closely matches the weighted target. Walk until
 *    within CENTROID_STOP_CELLS cells of the centroid, or leaving the zone,
 *    or hitting MAX_STEPS.
 * 3. Mark measured grid points every CONTOUR_INTERVAL (90 m) along each line.
 * 4. Connect Nth grid points between adjacent construction lines (adjacent =
 *    adjacent starting points around the boundary perimeter).
 * 5. Promote every PROMOTE_NTH construction line to a visible road.
 *
 * Rendering:
 *   - Terrain base (grey-green shaded)
 *   - Zone fill: green tint
 *   - Zone boundary: yellow (1 px)
 *   - Starting points: red dots (3x3)
 *   - Construction lines: dark green (1 px)
 *   - Promoted construction lines: magenta (3 px)
 *   - Contour connections between adjacent lines: cyan (3 px)
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
const gx   = parseInt(process.argv[3]) || 27;
const gz   = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007f-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const BASE_SPACING       = 35;   // metres between starting points around the perimeter
const CONTOUR_INTERVAL   = 90;   // metres between grid points along each construction line
const PROMOTE_NTH        = 4;    // every Nth construction line becomes a visible road
const MAX_STEPS          = 200;  // safety limit per walk
const CENTROID_STOP_CELLS = 20;  // stop when this close (grid cells) to centroid
const CENTROID_WEIGHT    = 0.7;  // weight toward centroid vs highest neighbour
const UPHILL_WEIGHT      = 0.3;  // weight toward highest neighbour

console.log(`Multi-edge construction lines: seed=${seed} gx=${gx} gz=${gz}`);
const t0 = performance.now();

const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });

// Run through tick 4 (spatial layers)
for (let i = 0; i < 4; i++) strategy.tick();

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

// Zone centroid in world coords
const centroidWX = originX + zone.centroidGx * cs;
const centroidWZ = originZ + zone.centroidGz * cs;

// Build a fast zone membership set (grid cells)
const zoneSet = new Set();
for (const c of zone.cells) {
  zoneSet.add(c.gz * w + c.gx);
}

// ---- Helper: grid coords -> elevation ----
function elevAtGrid(igx, igz) {
  return elev.get(igx, igz);
}

// ---- Step 1: Sample starting points evenly around the ENTIRE boundary perimeter ----
const boundary = zone.boundary;
const n = boundary.length;

// Compute cumulative arc-lengths around the closed boundary polyline
const boundaryLens = [0];
for (let i = 0; i < n; i++) {
  const p1 = boundary[i];
  const p2 = boundary[(i + 1) % n];
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  boundaryLens.push(boundaryLens[i] + Math.sqrt(dx*dx + dz*dz));
}
const totalPerimeter = boundaryLens[n]; // full closed-loop length

/**
 * Sample a world-coordinate point at arc-length d around the boundary.
 */
function sampleBoundary(d) {
  // Wrap distance to [0, totalPerimeter)
  d = ((d % totalPerimeter) + totalPerimeter) % totalPerimeter;
  // Binary search for the segment
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (boundaryLens[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - boundaryLens[lo]) / (boundaryLens[lo + 1] - boundaryLens[lo]);
  const p1 = boundary[lo];
  const p2 = boundary[(lo + 1) % n];
  return {
    x: p1.x + t * (p2.x - p1.x),
    z: p1.z + t * (p2.z - p1.z),
  };
}

const numStartPoints = Math.max(4, Math.floor(totalPerimeter / BASE_SPACING));
const startPoints = [];
for (let i = 0; i < numStartPoints; i++) {
  startPoints.push(sampleBoundary((i / numStartPoints) * totalPerimeter));
}

console.log(`  perimeter: ${totalPerimeter.toFixed(1)}m`);
console.log(`  starting points: ${startPoints.length} (every ~${BASE_SPACING}m)`);

// ---- Step 2: Walk inward from each starting point ----
// Neighbours (8-connected)
const NEIGHBOURS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

/**
 * Walk inward from a world-coordinate start point toward the zone centroid.
 *
 * Direction choice: weighted blend of
 *   - 70% toward centroid (normalized)
 *   - 30% toward the highest-elevation neighbour
 *
 * Among the 8-connected in-zone neighbours, choose the one whose direction
 * vector most closely matches the weighted target (maximum dot product).
 *
 * Stops when:
 *   - Within CENTROID_STOP_CELLS of the centroid
 *   - No valid in-zone neighbour found
 *   - MAX_STEPS reached
 *
 * Returns an array of world-coordinate {x, z} points.
 */
function walkInward(startX, startZ) {
  const line = [{ x: startX, z: startZ }];

  let curGx = Math.round((startX - originX) / cs);
  let curGz = Math.round((startZ - originZ) / cs);

  // Per-walk visited set (prevents tight loops)
  const visited = new Set();
  visited.add(curGz * w + curGx);

  for (let step = 0; step < MAX_STEPS; step++) {
    // Check proximity to centroid
    const dcx = zone.centroidGx - curGx;
    const dcz = zone.centroidGz - curGz;
    if (Math.sqrt(dcx*dcx + dcz*dcz) <= CENTROID_STOP_CELLS) break;

    // Normalized direction toward centroid
    const centDist = Math.sqrt(dcx*dcx + dcz*dcz) || 1;
    const tdx = dcx / centDist;
    const tdz = dcz / centDist;

    // Find highest-elevation in-zone unvisited neighbour (for uphill weight)
    let maxElev = -Infinity;
    for (const [ndx, ndz] of NEIGHBOURS) {
      const nx = curGx + ndx;
      const nz = curGz + ndz;
      if (!zoneSet.has(nz * w + nx)) continue;
      if (visited.has(nz * w + nx)) continue;
      const e = elevAtGrid(nx, nz);
      if (e > maxElev) maxElev = e;
    }

    // Weighted target direction
    // For the uphill component: among neighbours, find the one with highest elev
    // and use its direction. If no valid neighbour, fall back to centroid only.
    let uphillDx = 0, uphillDz = 0;
    if (maxElev > -Infinity) {
      for (const [ndx, ndz] of NEIGHBOURS) {
        const nx = curGx + ndx;
        const nz = curGz + ndz;
        if (!zoneSet.has(nz * w + nx)) continue;
        if (visited.has(nz * w + nx)) continue;
        if (Math.abs(elevAtGrid(nx, nz) - maxElev) < 0.001) {
          uphillDx = ndx;
          uphillDz = ndz;
          break;
        }
      }
    }
    const uphillLen = Math.sqrt(uphillDx*uphillDx + uphillDz*uphillDz) || 1;
    const uhx = uphillDx / uphillLen;
    const uhz = uphillDz / uphillLen;

    // Weighted blend
    let tgtDx = CENTROID_WEIGHT * tdx + UPHILL_WEIGHT * uhx;
    let tgtDz = CENTROID_WEIGHT * tdz + UPHILL_WEIGHT * uhz;
    const tgtLen = Math.sqrt(tgtDx*tgtDx + tgtDz*tgtDz) || 1;
    tgtDx /= tgtLen;
    tgtDz /= tgtLen;

    // Pick the neighbour whose direction best matches the weighted target
    let bestDot = -Infinity;
    let bestNx = -1, bestNz = -1;

    for (const [ndx, ndz] of NEIGHBOURS) {
      const nx = curGx + ndx;
      const nz = curGz + ndz;
      if (!zoneSet.has(nz * w + nx)) continue;
      if (visited.has(nz * w + nx)) continue;

      const nlen = Math.sqrt(ndx*ndx + ndz*ndz);
      const dot = (ndx/nlen) * tgtDx + (ndz/nlen) * tgtDz;
      if (dot > bestDot) {
        bestDot = dot;
        bestNx = nx;
        bestNz = nz;
      }
    }

    if (bestNx === -1) break; // no valid in-zone unvisited neighbour

    curGx = bestNx;
    curGz = bestNz;
    visited.add(curGz * w + curGx);
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

// ---- Build construction lines and their measured grid points ----
const constructionLines = []; // each: { polyline, gridPoints: [{x, z, dist}], startPoint }

for (const sp of startPoints) {
  const polyline = walkInward(sp.x, sp.z);
  if (polyline.length < 2) continue;

  const lens = arcLengths(polyline);
  const totalLen = lens[lens.length - 1];

  // Mark grid points at CONTOUR_INTERVAL intervals
  const gridPoints = [];
  for (let d = CONTOUR_INTERVAL; d <= totalLen; d += CONTOUR_INTERVAL) {
    gridPoints.push({ ...sampleAtDist(polyline, lens, d), dist: d });
  }

  constructionLines.push({ polyline, gridPoints, startPoint: sp });
}

console.log(`  construction lines: ${constructionLines.length}`);
const totalGP = constructionLines.reduce((s, l) => s + l.gridPoints.length, 0);
console.log(`  avg grid points per line: ${constructionLines.length > 0 ? (totalGP / constructionLines.length).toFixed(1) : 0}`);

// ---- Step 4: Connect Nth grid points between adjacent construction lines ----
// "Adjacent" = adjacent in the startPoints ordering (which is around the perimeter)
const contourConnections = []; // [{p1, p2}]

for (let k = 0; k < constructionLines.length - 1; k++) {
  const lineA = constructionLines[k];
  const lineB = constructionLines[k + 1];

  const mapA = new Map(lineA.gridPoints.map(p => [p.dist, p]));
  const mapB = new Map(lineB.gridPoints.map(p => [p.dist, p]));

  for (const [dist, pA] of mapA) {
    const pB = mapB.get(dist);
    if (!pB) continue;

    const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
    if (segLen < 5) continue; // skip degenerate connections

    contourConnections.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
  }
}

// Also connect the last line back to the first (wrap around perimeter)
{
  const lineA = constructionLines[constructionLines.length - 1];
  const lineB = constructionLines[0];
  if (lineA && lineB) {
    const mapA = new Map(lineA.gridPoints.map(p => [p.dist, p]));
    const mapB = new Map(lineB.gridPoints.map(p => [p.dist, p]));
    for (const [dist, pA] of mapA) {
      const pB = mapB.get(dist);
      if (!pB) continue;
      const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
      if (segLen < 5) continue;
      contourConnections.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
    }
  }
}

// ---- Step 5: Promoted construction lines (every PROMOTE_NTH) ----
const promotedLines = constructionLines
  .filter((_, i) => i % PROMOTE_NTH === 0)
  .map(l => l.polyline);

console.log(`  contour connections: ${contourConnections.length}`);
console.log(`  promoted lines: ${promotedLines.length}`);

// ---- Render ----
const pixels = new Uint8Array(w * h * 3);

// Terrain base
const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
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

// Zone boundary (yellow, 1 px)
for (let i = 0; i < boundary.length; i++) {
  const p1 = boundary[i], p2 = boundary[(i+1) % boundary.length];
  bresenham(pixels, w, h,
    Math.round((p1.x - originX) / cs), Math.round((p1.z - originZ) / cs),
    Math.round((p2.x - originX) / cs), Math.round((p2.z - originZ) / cs),
    255, 255, 0, 1);
}

// Construction lines (dark green, 1 px)
for (const { polyline } of constructionLines) {
  for (let i = 0; i < polyline.length - 1; i++) {
    bresenham(pixels, w, h,
      Math.round((polyline[i].x   - originX) / cs), Math.round((polyline[i].z   - originZ) / cs),
      Math.round((polyline[i+1].x - originX) / cs), Math.round((polyline[i+1].z - originZ) / cs),
      0, 100, 0, 1);
  }
}

// Contour connections (cyan, 3 px)
for (const seg of contourConnections) {
  const p1gx = Math.round((seg[0].x - originX) / cs);
  const p1gz = Math.round((seg[0].z - originZ) / cs);
  const p2gx = Math.round((seg[1].x - originX) / cs);
  const p2gz = Math.round((seg[1].z - originZ) / cs);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      bresenham(pixels, w, h, p1gx+dx, p1gz+dz, p2gx+dx, p2gz+dz, 0, 255, 255, 1);
}

// Promoted construction lines (magenta, 3 px)
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

// Starting points (red dots, 3x3)
for (const sp of startPoints) {
  const spGx = Math.round((sp.x - originX) / cs);
  const spGz = Math.round((sp.z - originZ) / cs);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const px2 = spGx + dx, pz2 = spGz + dz;
      if (px2 >= 0 && px2 < w && pz2 >= 0 && pz2 < h) {
        const idx = (pz2 * w + px2) * 3;
        pixels[idx] = 255; pixels[idx+1] = 30; pixels[idx+2] = 30;
      }
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
