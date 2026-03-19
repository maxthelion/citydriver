#!/usr/bin/env bun
/**
 * Experiment 007a: Terrain-split ribbon layout.
 *
 * Picks a medium-large zone near the centre, checks if slope direction
 * varies across it (>30°), and if so splits it into two sub-zones along
 * the centroid elevation contour. Ribbon layout runs independently in each
 * sub-zone; results rendered in different colours.
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { createZoneBoundaryRoads } from '../src/city/pipeline/zoneBoundaryRoads.js';
import { subdivideLargeZones } from '../src/city/pipeline/subdivideZones.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { extractZoneBoundary } from '../src/city/zoneExtraction.js';
import { computeRibbonOrientation, layoutRibbonStreets, adjustStreetToContour, CONTOUR_SLOPE_THRESHOLD } from '../src/city/ribbonLayout.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007a-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Terrain-split ribbon: seed=${seed} gx=${gx} gz=${gz}`);
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

// Pick a medium-large zone with slope data near the centre
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
  const aDist = Math.abs(a.centroidGx - w / 2) + Math.abs(a.centroidGz - h / 2);
  const bDist = Math.abs(b.centroidGx - w / 2) + Math.abs(b.centroidGz - h / 2);
  return aDist - bDist;
});
const zone = candidates[0];

console.log(`\nSelected zone: ${zone.cells.length} cells, centroid (${zone.centroidGx.toFixed(1)}, ${zone.centroidGz.toFixed(1)})`);
console.log(`  avgSlope: ${zone.avgSlope.toFixed(3)}, slopeDir: (${zone.slopeDir.x.toFixed(2)}, ${zone.slopeDir.z.toFixed(2)})`);

// ─── Terrain variation check ─────────────────────────────────────────────────

const elevation = map.hasLayer('elevation') ? map.getLayer('elevation') : null;

/**
 * Sample slope gradient direction at a world-space point.
 * Returns angle in radians.
 */
function slopeDirAngle(cells, sampleFrac) {
  // Pick a cell at the given fractional position (by bounding-box lerp)
  const minGx = Math.min(...cells.map(c => c.gx));
  const maxGx = Math.max(...cells.map(c => c.gx));
  const minGz = Math.min(...cells.map(c => c.gz));
  const maxGz = Math.max(...cells.map(c => c.gz));
  const targetGx = minGx + (maxGx - minGx) * sampleFrac;
  const targetGz = minGz + (maxGz - minGz) * sampleFrac;

  // Find closest cell
  let bestCell = cells[0];
  let bestD = Infinity;
  for (const c of cells) {
    const d = (c.gx - targetGx) ** 2 + (c.gz - targetGz) ** 2;
    if (d < bestD) { bestD = d; bestCell = c; }
  }

  if (!elevation) return 0;

  const { gx, gz } = bestCell;
  const e = elevation.get(gx, gz);
  const gxPlus = gx + 1 < w ? elevation.get(gx + 1, gz) - e : 0;
  const gzPlus = gz + 1 < h ? elevation.get(gx, gz + 1) - e : 0;
  return Math.atan2(gzPlus, gxPlus);
}

const SAMPLE_FRACS = [0.1, 0.3, 0.5, 0.7, 0.9];
const sampleAngles = SAMPLE_FRACS.map(f => slopeDirAngle(zone.cells, f));
console.log(`\nSlope direction samples (°): ${sampleAngles.map(a => (a * 180 / Math.PI).toFixed(1)).join(', ')}`);

// Angular spread — compare each pair of adjacent samples
let maxAngularDiff = 0;
for (let i = 0; i < sampleAngles.length - 1; i++) {
  let diff = Math.abs(sampleAngles[i] - sampleAngles[i + 1]);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  if (diff > maxAngularDiff) maxAngularDiff = diff;
}
console.log(`Max angular diff between adjacent samples: ${(maxAngularDiff * 180 / Math.PI).toFixed(1)}°`);

const SPLIT_THRESHOLD_DEG = 30;
const shouldSplit = maxAngularDiff * 180 / Math.PI > SPLIT_THRESHOLD_DEG;
console.log(`Terrain varies enough to split: ${shouldSplit}`);

// ─── Sub-zone creation ───────────────────────────────────────────────────────

/**
 * Build a sub-zone object from a cell list, ready for ribbon layout.
 */
function buildSubZone(cells, nucleusIdx, map) {
  if (cells.length === 0) return null;

  let sumGx = 0, sumGz = 0;
  let slopeSum = 0, lvSum = 0;
  let gradX = 0, gradZ = 0;

  for (const c of cells) {
    sumGx += c.gx;
    sumGz += c.gz;
    if (map.slope) slopeSum += map.slope.get(c.gx, c.gz);
    lvSum += map.landValue.get(c.gx, c.gz);
    if (map.elevation) {
      const e = map.elevation.get(c.gx, c.gz);
      if (c.gx > 0) gradX += e - map.elevation.get(c.gx - 1, c.gz);
      if (c.gz > 0) gradZ += e - map.elevation.get(c.gx, c.gz - 1);
    }
  }

  const centroidGx = sumGx / cells.length;
  const centroidGz = sumGz / cells.length;
  const avgSlope = map.slope ? slopeSum / cells.length : 0;
  const avgLandValue = lvSum / cells.length;
  const gradLen = Math.sqrt(gradX * gradX + gradZ * gradZ);
  const slopeDir = gradLen > 0.01
    ? { x: gradX / gradLen, z: gradZ / gradLen }
    : { x: 0, z: 0 };

  const nucleus = map.nuclei[nucleusIdx];
  const nwx = map.originX + nucleus.gx * cs;
  const nwz = map.originZ + nucleus.gz * cs;
  const cwx = map.originX + centroidGx * cs;
  const cwz = map.originZ + centroidGz * cs;
  const distFromNucleus = Math.sqrt((cwx - nwx) ** 2 + (cwz - nwz) ** 2);

  const boundary = extractZoneBoundary(cells, cs, map.originX, map.originZ);

  return {
    cells,
    centroidGx,
    centroidGz,
    avgSlope,
    avgLandValue,
    slopeDir,
    distFromNucleus,
    nucleusIdx,
    pressure: zone.pressure ?? 0.5,
    boundary,
  };
}

let subZones;

if (shouldSplit && elevation) {
  // Split cells by centroid elevation: cells above vs below
  const centElev = elevation.sample(zone.centroidGx, zone.centroidGz);
  console.log(`\nSplitting at centroid elevation: ${centElev.toFixed(2)}`);

  const above = [];
  const below = [];
  for (const c of zone.cells) {
    const e = elevation.get(c.gx, c.gz);
    if (e >= centElev) above.push(c);
    else below.push(c);
  }

  console.log(`  Above: ${above.length} cells, Below: ${below.length} cells`);

  const szA = buildSubZone(above, zone.nucleusIdx, map);
  const szB = buildSubZone(below, zone.nucleusIdx, map);

  subZones = [szA, szB].filter(sz => sz && sz.boundary && sz.boundary.length >= 3);
  console.log(`  Valid sub-zones: ${subZones.length}`);

  if (subZones.length === 0) {
    console.log('  Split produced no valid sub-zones; falling back to whole zone');
    subZones = [zone];
  }
} else {
  console.log('\nNo split: using whole zone');
  subZones = [zone];
}

// ─── Ribbon layout per sub-zone ───────────────────────────────────────────────

const nucleus = map.nuclei[zone.nucleusIdx];

const subZoneResults = subZones.map((sz, i) => {
  const direction = computeRibbonOrientation(sz, nucleus, cs);
  console.log(`\nSub-zone ${i}: ${sz.cells.length} cells`);
  console.log(`  centroid: (${sz.centroidGx.toFixed(1)}, ${sz.centroidGz.toFixed(1)})`);
  console.log(`  avgSlope: ${sz.avgSlope.toFixed(3)}, slopeDir: (${sz.slopeDir.x.toFixed(2)}, ${sz.slopeDir.z.toFixed(2)})`);
  console.log(`  ribbon direction: (${direction.dx.toFixed(2)}, ${direction.dz.toFixed(2)})`);

  const streets = layoutRibbonStreets(sz, direction, cs, map.originX, map.originZ);
  console.log(`  parallel streets: ${streets.parallel.length}, cross: ${streets.cross.length}, spacing: ${streets.spacing}m`);

  // Contour adjustment
  if (sz.avgSlope > CONTOUR_SLOPE_THRESHOLD && elevation) {
    for (let j = 0; j < streets.parallel.length; j++) {
      streets.parallel[j] = adjustStreetToContour(
        streets.parallel[j], elevation, sz.slopeDir, cs, map.originX, map.originZ
      );
    }
  }

  return { subZone: sz, streets };
});

// ─── Render ───────────────────────────────────────────────────────────────────

const pixels = new Uint8Array(w * h * 3);

// Terrain base
const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
if (elevation) {
  const bounds = elevation.bounds();
  const range = bounds.max - bounds.min || 1;
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++) {
      const v = (elevation.get(x, z) - bounds.min) / range;
      const idx = (z * w + x) * 3;
      pixels[idx] = Math.round(30 + v * 40);
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
for (const zone of zones) {
  for (const c of zone.cells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx] = Math.min(255, pixels[idx] + 20);
    pixels[idx + 1] = Math.min(255, pixels[idx + 1] + 15);
    pixels[idx + 2] = Math.min(255, pixels[idx + 2] + 10);
  }
}

// Sub-zone cell colours — two distinct tints
const subZoneColours = [
  [60, 100, 60],   // green tint — above centroid
  [60, 60, 110],   // blue tint  — below centroid
];

for (let i = 0; i < subZones.length; i++) {
  const [cr, cg, cb] = subZoneColours[i % subZoneColours.length];
  for (const c of subZones[i].cells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx] = cr; pixels[idx + 1] = cg; pixels[idx + 2] = cb;
  }
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

// Sub-zone boundaries (yellow / orange)
const boundaryColours = [[255, 255, 0], [255, 160, 0]];
for (let i = 0; i < subZones.length; i++) {
  const [br, bg, bb] = boundaryColours[i % boundaryColours.length];
  const b = subZones[i].boundary;
  if (!b) continue;
  for (let j = 0; j < b.length; j++) {
    const p1 = b[j], p2 = b[(j + 1) % b.length];
    bresenham(pixels, w, h,
      Math.round((p1.x - map.originX) / cs), Math.round((p1.z - map.originZ) / cs),
      Math.round((p2.x - map.originX) / cs), Math.round((p2.z - map.originZ) / cs),
      br, bg, bb);
  }
}

// Ribbon streets — cyan for sub-zone 0, lime for sub-zone 1
const parallelColours = [[0, 255, 255], [0, 255, 100]];
const crossColours    = [[255, 0, 255], [255, 100, 0]];

for (let i = 0; i < subZoneResults.length; i++) {
  const { streets } = subZoneResults[i];
  const [pr, pg, pb] = parallelColours[i % parallelColours.length];
  const [cr2, cg2, cb2] = crossColours[i % crossColours.length];

  for (const st of streets.parallel) {
    if (st.length < 2) continue;
    for (let j = 0; j < st.length - 1; j++) {
      const p1gx = Math.round((st[j].x - map.originX) / cs);
      const p1gz = Math.round((st[j].z - map.originZ) / cs);
      const p2gx = Math.round((st[j + 1].x - map.originX) / cs);
      const p2gz = Math.round((st[j + 1].z - map.originZ) / cs);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          bresenham(pixels, w, h, p1gx + dx, p1gz + dz, p2gx + dx, p2gz + dz, pr, pg, pb);
    }
  }

  for (const st of streets.cross) {
    if (st.length < 2) continue;
    const p1gx = Math.round((st[0].x - map.originX) / cs);
    const p1gz = Math.round((st[0].z - map.originZ) / cs);
    const p2gx = Math.round((st[1].x - map.originX) / cs);
    const p2gz = Math.round((st[1].z - map.originZ) / cs);
    for (let dz = 0; dz <= 1; dz++)
      for (let dx = 0; dx <= 1; dx++)
        bresenham(pixels, w, h, p1gx + dx, p1gz + dz, p2gx + dx, p2gz + dz, cr2, cg2, cb2);
  }
}

// Nucleus (red dot)
if (nucleus) {
  for (let dz = -3; dz <= 3; dz++)
    for (let dx = -3; dx <= 3; dx++) {
      const px = nucleus.gx + dx, pz = nucleus.gz + dz;
      if (px >= 0 && px < w && pz >= 0 && pz < h) {
        const idx = (pz * w + px) * 3;
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

// ─── Bresenham line draw ──────────────────────────────────────────────────────

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
    if (e2 < dx) { err += dx; y += sy; }
  }
}
