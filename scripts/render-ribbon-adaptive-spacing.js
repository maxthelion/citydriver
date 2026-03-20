#!/usr/bin/env bun
/**
 * Experiment 007c: Adaptive ribbon spacing — enforce minimum distance DURING generation.
 *
 * Instead of post-processing (007b), we filter parallel streets as we generate them:
 * each newly clipped segment is accepted only if its midpoint is at least
 * spacing * 0.7 from the previously accepted segment's midpoint.
 *
 * Cross streets are then regenerated between the accepted parallel streets only.
 *
 * Rendering: accepted parallel streets in cyan, skipped streets in dim red,
 * cross streets in magenta.
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { createZoneBoundaryRoads } from '../src/city/pipeline/zoneBoundaryRoads.js';
import { subdivideLargeZones } from '../src/city/pipeline/subdivideZones.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { computeRibbonOrientation, adjustStreetToContour, CONTOUR_SLOPE_THRESHOLD } from '../src/city/ribbonLayout.js';
import { ribbonSpacingForPressure } from '../src/city/developmentPressure.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';

const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007c-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Ribbon adaptive-spacing: seed=${seed} gx=${gx} gz=${gz}`);
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
console.log(`  slopeDir: (${zone.slopeDir.x.toFixed(2)}, ${zone.slopeDir.z.toFixed(2)})`);
console.log(`  nucleusIdx: ${zone.nucleusIdx}`);

const nucleus = map.nuclei[zone.nucleusIdx];
const direction = computeRibbonOrientation(zone, nucleus, cs);
console.log(`  ribbon direction: (${direction.dx.toFixed(2)}, ${direction.dz.toFixed(2)})`);

// -----------------------------------------------------------------------
// Inline modified layoutRibbonStreets with adaptive spacing filter
// -----------------------------------------------------------------------

const CROSS_STREET_INTERVAL = 90;  // metres between cross streets
const MIN_STREET_LENGTH = 20;      // metres — skip streets shorter than this
const MIN_SPACING_RATIO = 0.7;     // minimum spacing as fraction of nominal spacing

function clipLineToPolygon(p1, p2, polygon) {
  const dx = p2.x - p1.x, dz = p2.z - p1.z;
  const n = polygon.length;
  const intersections = [];

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const edx = b.x - a.x, edz = b.z - a.z;
    const denom = dx * edz - dz * edx;
    if (Math.abs(denom) < 1e-10) continue;

    const t = ((a.x - p1.x) * edz - (a.z - p1.z) * edx) / denom;
    const u = ((a.x - p1.x) * dz - (a.z - p1.z) * dx) / denom;

    if (u >= 0 && u <= 1 && t >= 0 && t <= 1) {
      intersections.push(t);
    }
  }

  if (intersections.length < 2) {
    const mx = (p1.x + p2.x) / 2, mz = (p1.z + p2.z) / 2;
    if (pointInPoly(mx, mz, polygon)) return [[p1, p2]];
    return [];
  }

  intersections.sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < intersections.length - 1; i += 2) {
    const t0 = intersections[i];
    const t1 = intersections[i + 1];
    if (t1 - t0 < 1e-6) continue;
    segments.push([
      { x: p1.x + t0 * dx, z: p1.z + t0 * dz },
      { x: p1.x + t1 * dx, z: p1.z + t1 * dz },
    ]);
  }

  return segments;
}

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

function segMidpoint(seg) {
  return {
    x: (seg[0].x + seg[1].x) / 2,
    z: (seg[0].z + seg[1].z) / 2,
  };
}

function dist2d(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

/**
 * Adaptive version of layoutRibbonStreets.
 *
 * Generates candidate lines at the normal spacing offsets. After clipping each
 * to the boundary polygon, checks whether the segment's midpoint is at least
 * spacing * MIN_SPACING_RATIO away from the last ACCEPTED segment's midpoint.
 * Segments that fail this check are collected as `skipped` for debug rendering.
 *
 * Cross streets are only generated between accepted parallel streets.
 */
function layoutRibbonStreetsAdaptive(zone, direction, cellSize, originX, originZ) {
  const boundary = zone.boundary;
  if (!boundary || boundary.length < 3) {
    return { spine: [], parallel: [], skipped: [], cross: [], spacing: 30 };
  }

  const spacing = ribbonSpacingForPressure(zone.pressure ?? 0.5);
  const minDist = spacing * MIN_SPACING_RATIO;
  const { dx, dz } = direction;
  const px = -dz, pz = dx;   // perpendicular direction

  const cx = originX + zone.centroidGx * cellSize;
  const cz = originZ + zone.centroidGz * cellSize;

  // Find zone extent along perpendicular and street axes
  let minPerp = Infinity, maxPerp = -Infinity;
  let minAlong = Infinity, maxAlong = -Infinity;
  for (const pt of boundary) {
    const projPerp = (pt.x - cx) * px + (pt.z - cz) * pz;
    if (projPerp < minPerp) minPerp = projPerp;
    if (projPerp > maxPerp) maxPerp = projPerp;
    const projAlong = (pt.x - cx) * dx + (pt.z - cz) * dz;
    if (projAlong < minAlong) minAlong = projAlong;
    if (projAlong > maxAlong) maxAlong = projAlong;
  }

  // Collect candidate segments (all clipped lines, before spacing filter)
  // We sweep in order: 0, +spacing, -spacing, +2*spacing, -2*spacing, ...
  // To enforce spacing relative to the last ACCEPTED in each direction we keep
  // separate trackers per side (+/-).  After collection we merge and sort by
  // perpendicular offset so cross-street logic stays consistent.

  const accepted = [];   // [{seg, perp}] ordered as we accept them
  const skipped = [];    // segments rejected by the spacing filter

  // Separate last-accepted midpoint per sign to avoid positive side gating on
  // negative side progress and vice versa.
  const lastAccepted = { 1: null, '-1': null };

  for (let offset = 0; offset <= maxPerp + spacing; offset += spacing) {
    for (const sign of [1, -1]) {
      if (offset === 0 && sign === -1) continue;
      const actualOffset = offset * sign;
      if (actualOffset < minPerp - spacing || actualOffset > maxPerp + spacing) continue;

      const lineCx = cx + px * actualOffset;
      const lineCz = cz + pz * actualOffset;
      const p1 = { x: lineCx + dx * (minAlong - 50), z: lineCz + dz * (minAlong - 50) };
      const p2 = { x: lineCx + dx * (maxAlong + 50), z: lineCz + dz * (maxAlong + 50) };

      const segments = clipLineToPolygon(p1, p2, boundary);
      for (const seg of segments) {
        const len = Math.sqrt((seg[1].x - seg[0].x) ** 2 + (seg[1].z - seg[0].z) ** 2);
        if (len < MIN_STREET_LENGTH) continue;

        const mid = segMidpoint(seg);
        const sideKey = String(sign);
        const prev = lastAccepted[sideKey];

        if (prev !== null && dist2d(mid, prev) < minDist) {
          // Too close to the last accepted on this side — skip
          skipped.push(seg);
        } else {
          // Accept this segment
          accepted.push({ seg, perp: actualOffset });
          lastAccepted[sideKey] = mid;
        }
      }
    }
  }

  // Sort accepted by perpendicular offset (matches original layoutRibbonStreets sort)
  accepted.sort((a, b) => a.perp - b.perp);
  const parallel = accepted.map(a => a.seg);

  // Spine: the segment at (or nearest to) offset 0
  const spineEntry = accepted.find(a => a.perp === 0) || accepted[0];
  const spine = spineEntry ? spineEntry.seg : [];

  // Generate cross streets between adjacent accepted parallel streets
  const cross = [];
  for (let i = 0; i < parallel.length - 1; i++) {
    const st1 = parallel[i], st2 = parallel[i + 1];

    const s1Start = (st1[0].x - cx) * dx + (st1[0].z - cz) * dz;
    const s1End   = (st1[1].x - cx) * dx + (st1[1].z - cz) * dz;
    const s2Start = (st2[0].x - cx) * dx + (st2[0].z - cz) * dz;
    const s2End   = (st2[1].x - cx) * dx + (st2[1].z - cz) * dz;

    const overlapStart = Math.max(Math.min(s1Start, s1End), Math.min(s2Start, s2End));
    const overlapEnd   = Math.min(Math.max(s1Start, s1End), Math.max(s2Start, s2End));
    if (overlapEnd - overlapStart < MIN_STREET_LENGTH) continue;

    for (let along = overlapStart + CROSS_STREET_INTERVAL / 2; along < overlapEnd; along += CROSS_STREET_INTERVAL) {
      const t1 = (along - Math.min(s1Start, s1End)) / Math.abs(s1End - s1Start);
      const t2 = (along - Math.min(s2Start, s2End)) / Math.abs(s2End - s2Start);
      if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) continue;

      const p1x = st1[0].x + t1 * (st1[1].x - st1[0].x);
      const p1z = st1[0].z + t1 * (st1[1].z - st1[0].z);
      const p2x = st2[0].x + t2 * (st2[1].x - st2[0].x);
      const p2z = st2[0].z + t2 * (st2[1].z - st2[0].z);

      cross.push([{ x: p1x, z: p1z }, { x: p2x, z: p2z }]);
    }
  }

  return { spine, parallel, skipped, cross, spacing };
}

// -----------------------------------------------------------------------
// Run adaptive layout
// -----------------------------------------------------------------------

const streets = layoutRibbonStreetsAdaptive(zone, direction, cs, map.originX, map.originZ);
console.log(`  parallel streets (accepted): ${streets.parallel.length}`);
console.log(`  skipped (too close):         ${streets.skipped.length}`);
console.log(`  cross streets:               ${streets.cross.length}`);
console.log(`  spacing: ${streets.spacing}m`);

// Contour adjustment on accepted parallel streets
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

// -----------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------

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

// Skipped streets (dim red) — drawn first so accepted streets paint over them
for (const st of streets.skipped) {
  if (st.length < 2) continue;
  const p1gx = Math.round((st[0].x - map.originX) / cs);
  const p1gz = Math.round((st[0].z - map.originZ) / cs);
  const p2gx = Math.round((st[1].x - map.originX) / cs);
  const p2gz = Math.round((st[1].z - map.originZ) / cs);
  bresenham(pixels, w, h, p1gx, p1gz, p2gx, p2gz, 120, 30, 30);
}

// Accepted parallel streets (cyan, 3px)
for (const st of streets.parallel) {
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
for (const st of streets.cross) {
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
