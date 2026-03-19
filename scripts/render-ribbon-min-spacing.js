#!/usr/bin/env bun
/**
 * Experiment 007b: Post-process parallel streets to enforce minimum spacing.
 * Streets that are too close to their neighbour are removed (dim red).
 * Surviving streets are rendered in cyan; cross streets in magenta.
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { createZoneBoundaryRoads } from '../src/city/pipeline/zoneBoundaryRoads.js';
import { subdivideLargeZones } from '../src/city/pipeline/subdivideZones.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { computeRibbonOrientation, layoutRibbonStreets, adjustStreetToContour, CONTOUR_SLOPE_THRESHOLD } from '../src/city/ribbonLayout.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007b-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Ribbon min-spacing: seed=${seed} gx=${gx} gz=${gz}`);
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

// Re-extract zones
extractZones(map);

const zones = map.developmentZones;
const w = map.width, h = map.height;
const cs = map.cellSize;

console.log(`${zones.length} zones after subdivision`);

// Pick a medium-large zone near the centre with proper metadata
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

candidates.sort((a, b) => {
  const aDist = Math.abs(a.centroidGx - w/2) + Math.abs(a.centroidGz - h/2);
  const bDist = Math.abs(b.centroidGx - w/2) + Math.abs(b.centroidGz - h/2);
  return aDist - bDist;
});
const zone = candidates[0];

console.log(`\nSelected zone: ${zone.cells.length} cells, centroid (${zone.centroidGx}, ${zone.centroidGz})`);
console.log(`  boundary: ${zone.boundary.length} vertices`);
console.log(`  avgSlope: ${zone.avgSlope.toFixed(3)}`);
console.log(`  nucleusIdx: ${zone.nucleusIdx}`);

// Run ribbon layout
const nucleus = map.nuclei[zone.nucleusIdx];
const direction = computeRibbonOrientation(zone, nucleus, cs);
console.log(`  ribbon direction: (${direction.dx.toFixed(2)}, ${direction.dz.toFixed(2)})`);

const streets = layoutRibbonStreets(zone, direction, cs, map.originX, map.originZ);
console.log(`  parallel streets (raw): ${streets.parallel.length}`);
console.log(`  spacing: ${streets.spacing}m`);

// Contour adjustment on raw parallel streets
if (zone.avgSlope > CONTOUR_SLOPE_THRESHOLD) {
  const elevation = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
  if (elevation) {
    for (let i = 0; i < streets.parallel.length; i++) {
      streets.parallel[i] = adjustStreetToContour(
        streets.parallel[i], elevation, zone.slopeDir, cs, map.originX, map.originZ
      );
    }
  }
}

// --- POST-PROCESSING: enforce minimum spacing ---
//
// The parallel array is sorted by perpendicular offset from the spine.
// For each adjacent pair, measure the minimum distance between them.
// If that distance < spacing * 0.6, mark the shorter street for removal.
//
// Distance metric: midpoint-to-midpoint distance (simple, fast).

const MIN_SPACING_RATIO = 0.6;
const minDist = streets.spacing * MIN_SPACING_RATIO;

/**
 * Midpoint of a (possibly multi-point) street polyline.
 */
function midpoint(street) {
  if (street.length === 2) {
    return {
      x: (street[0].x + street[1].x) / 2,
      z: (street[0].z + street[1].z) / 2,
    };
  }
  // Multi-point: use the middle vertex
  const mid = Math.floor(street.length / 2);
  return { x: street[mid].x, z: street[mid].z };
}

/**
 * Minimum distance between two streets — sample N points along each and
 * find the closest pair.
 */
function minDistBetweenStreets(st1, st2, samples = 5) {
  // Parametric samples along each segment
  function samplePts(st) {
    const pts = [];
    if (st.length === 2) {
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        pts.push({ x: st[0].x + t * (st[1].x - st[0].x), z: st[0].z + t * (st[1].z - st[0].z) });
      }
    } else {
      // Multi-point: evenly distribute sample indices over vertices
      for (let i = 0; i <= samples; i++) {
        const t = (i / samples) * (st.length - 1);
        const lo = Math.floor(t), hi = Math.min(lo + 1, st.length - 1);
        const frac = t - lo;
        pts.push({
          x: st[lo].x + frac * (st[hi].x - st[lo].x),
          z: st[lo].z + frac * (st[hi].z - st[lo].z),
        });
      }
    }
    return pts;
  }

  const pts1 = samplePts(st1);
  const pts2 = samplePts(st2);
  let best = Infinity;
  for (const p1 of pts1) {
    for (const p2 of pts2) {
      const d = Math.sqrt((p1.x - p2.x) ** 2 + (p1.z - p2.z) ** 2);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Length of a (possibly multi-point) street polyline.
 */
function streetLength(st) {
  let len = 0;
  for (let i = 0; i < st.length - 1; i++) {
    len += Math.sqrt((st[i+1].x - st[i].x) ** 2 + (st[i+1].z - st[i].z) ** 2);
  }
  return len;
}

// Walk adjacent pairs; mark streets to remove
const removed = new Set();

for (let i = 0; i < streets.parallel.length - 1; i++) {
  if (removed.has(i)) continue; // already removed, compare i+1 vs i+2 next iteration
  const j = i + 1;
  if (removed.has(j)) continue;

  const d = minDistBetweenStreets(streets.parallel[i], streets.parallel[j]);
  if (d < minDist) {
    // Remove the shorter one
    const lenI = streetLength(streets.parallel[i]);
    const lenJ = streetLength(streets.parallel[j]);
    removed.add(lenI <= lenJ ? i : j);
  }
}

const survivingParallel = streets.parallel.filter((_, i) => !removed.has(i));
const removedParallel = streets.parallel.filter((_, i) => removed.has(i));

console.log(`  removed (too close): ${removedParallel.length}`);
console.log(`  surviving parallel: ${survivingParallel.length}`);

// Re-generate cross streets only between surviving parallel streets
// (same algorithm as layoutRibbonStreets, but applied to survivingParallel)
const CROSS_STREET_INTERVAL = 90;
const MIN_STREET_LENGTH = 20;
const { dx, dz } = direction;
const cx = map.originX + zone.centroidGx * cs;
const cz = map.originZ + zone.centroidGz * cs;
const px = -dz, pz = dx;

const newCross = [];
for (let i = 0; i < survivingParallel.length - 1; i++) {
  const st1 = survivingParallel[i], st2 = survivingParallel[i + 1];

  const s1Start = (st1[0].x - cx) * dx + (st1[0].z - cz) * dz;
  const s1End   = (st1[st1.length-1].x - cx) * dx + (st1[st1.length-1].z - cz) * dz;
  const s2Start = (st2[0].x - cx) * dx + (st2[0].z - cz) * dz;
  const s2End   = (st2[st2.length-1].x - cx) * dx + (st2[st2.length-1].z - cz) * dz;

  const overlapStart = Math.max(Math.min(s1Start, s1End), Math.min(s2Start, s2End));
  const overlapEnd   = Math.min(Math.max(s1Start, s1End), Math.max(s2Start, s2End));
  if (overlapEnd - overlapStart < MIN_STREET_LENGTH) continue;

  for (let along = overlapStart + CROSS_STREET_INTERVAL / 2; along < overlapEnd; along += CROSS_STREET_INTERVAL) {
    const t1 = (along - Math.min(s1Start, s1End)) / Math.abs(s1End - s1Start);
    const t2 = (along - Math.min(s2Start, s2End)) / Math.abs(s2End - s2Start);
    if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) continue;

    // Interpolate along the polyline at parameter t
    function interpolatePoly(st, t) {
      if (st.length === 2) {
        return {
          x: st[0].x + t * (st[1].x - st[0].x),
          z: st[0].z + t * (st[1].z - st[0].z),
        };
      }
      const pos = t * (st.length - 1);
      const lo = Math.floor(pos), hi = Math.min(lo + 1, st.length - 1);
      const frac = pos - lo;
      return { x: st[lo].x + frac * (st[hi].x - st[lo].x), z: st[lo].z + frac * (st[hi].z - st[lo].z) };
    }

    const p1 = interpolatePoly(st1, t1);
    const p2 = interpolatePoly(st2, t2);
    newCross.push([p1, p2]);
  }
}

console.log(`  new cross streets: ${newCross.length}`);

// --- Render ---
const pixels = new Uint8Array(w * h * 3);

// Terrain base
const elev = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
if (elev) {
  const bounds = elev.bounds();
  const range = bounds.max - bounds.min || 1;
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++) {
      const v = (elev.get(x, z) - bounds.min) / range;
      const idx = (z * w + x) * 3;
      pixels[idx]     = Math.round(30 + v * 40);
      pixels[idx + 1] = Math.round(40 + v * 30);
      pixels[idx + 2] = Math.round(20 + v * 20);
    }
}
if (waterMask) {
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      if (waterMask.get(x, z) > 0) {
        const idx = (z * w + x) * 3;
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
      }
}

// All zones faint
for (const z of zones) {
  for (const c of z.cells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx]     = Math.min(255, pixels[idx]     + 20);
    pixels[idx + 1] = Math.min(255, pixels[idx + 1] + 15);
    pixels[idx + 2] = Math.min(255, pixels[idx + 2] + 10);
  }
}

// Highlight selected zone
for (const c of zone.cells) {
  const idx = (c.gz * w + c.gx) * 3;
  pixels[idx] = 60; pixels[idx + 1] = 100; pixels[idx + 2] = 60;
}

// Roads (white)
const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
if (roadGrid) {
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      if (roadGrid.get(x, z) > 0) {
        const idx = (z * w + x) * 3;
        pixels[idx] = 180; pixels[idx + 1] = 180; pixels[idx + 2] = 180;
      }
}

// Zone boundary (yellow)
if (zone.boundary) {
  const b = zone.boundary;
  for (let i = 0; i < b.length; i++) {
    const p1 = b[i], p2 = b[(i + 1) % b.length];
    bresenham(pixels, w, h,
      Math.round((p1.x - map.originX) / cs), Math.round((p1.z - map.originZ) / cs),
      Math.round((p2.x - map.originX) / cs), Math.round((p2.z - map.originZ) / cs),
      255, 255, 0);
  }
}

// Removed streets (dim red) — drawn first so surviving streets paint over
for (const st of removedParallel) {
  if (st.length < 2) continue;
  for (let i = 0; i < st.length - 1; i++) {
    const p1gx = Math.round((st[i].x   - map.originX) / cs);
    const p1gz = Math.round((st[i].z   - map.originZ) / cs);
    const p2gx = Math.round((st[i+1].x - map.originX) / cs);
    const p2gz = Math.round((st[i+1].z - map.originZ) / cs);
    bresenham(pixels, w, h, p1gx, p1gz, p2gx, p2gz, 120, 30, 30);
  }
}

// Surviving parallel streets (cyan, 3px)
for (const st of survivingParallel) {
  if (st.length < 2) continue;
  for (let i = 0; i < st.length - 1; i++) {
    const p1gx = Math.round((st[i].x   - map.originX) / cs);
    const p1gz = Math.round((st[i].z   - map.originZ) / cs);
    const p2gx = Math.round((st[i+1].x - map.originX) / cs);
    const p2gz = Math.round((st[i+1].z - map.originZ) / cs);
    for (let dz = -1; dz <= 1; dz++)
      for (let ddx = -1; ddx <= 1; ddx++)
        bresenham(pixels, w, h, p1gx+ddx, p1gz+dz, p2gx+ddx, p2gz+dz, 0, 255, 255);
  }
}

// Cross streets (magenta, 2px)
for (const st of newCross) {
  if (st.length < 2) continue;
  const p1gx = Math.round((st[0].x - map.originX) / cs);
  const p1gz = Math.round((st[0].z - map.originZ) / cs);
  const p2gx = Math.round((st[1].x - map.originX) / cs);
  const p2gz = Math.round((st[1].z - map.originZ) / cs);
  for (let dz = 0; dz <= 1; dz++)
    for (let ddx = 0; ddx <= 1; ddx++)
      bresenham(pixels, w, h, p1gx+ddx, p1gz+dz, p2gx+ddx, p2gz+dz, 255, 0, 255);
}

// Nucleus (red dot)
if (nucleus) {
  for (let dz = -3; dz <= 3; dz++)
    for (let ddx = -3; ddx <= 3; ddx++) {
      const npx = nucleus.gx + ddx, npz = nucleus.gz + dz;
      if (npx >= 0 && npx < w && npz >= 0 && npz < h) {
        const idx = (npz * w + npx) * 3;
        pixels[idx] = 255; pixels[idx + 1] = 0; pixels[idx + 2] = 0;
      }
    }
}

const header = `P6\n${w} ${h}\n255\n`;
const basePath = `${outDir}/ribbon-zone-seed${seed}`;
writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
console.log(`\nWritten to ${basePath}.png`);
console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

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
    if (e2 < dx)  { err += dx; y += sy; }
  }
}
