#!/usr/bin/env bun
/**
 * Pick a subdivided zone and run ribbon layout in it.
 * Renders: zones with one highlighted, ribbon streets inside it.
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
const outDir = process.argv[5] || 'experiments/006-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Ribbon in zone: seed=${seed} gx=${gx} gz=${gz}`);
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

// Print zone stats
const sizes = zones.map(z => z.cells.length).sort((a, b) => b - a);
console.log(`Sizes: ${sizes.slice(0, 10).join(', ')}...`);
console.log(`Zones with boundary: ${zones.filter(z => z.boundary && z.boundary.length >= 3).length}`);
console.log(`Zones with slope data: ${zones.filter(z => z.avgSlope !== undefined).length}`);

// Pick a medium-large zone that has proper metadata
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

// Pick one near the centre
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

// Run ribbon layout on this zone
const nucleus = map.nuclei[zone.nucleusIdx];
const direction = computeRibbonOrientation(zone, nucleus, cs);
console.log(`  ribbon direction: (${direction.dx.toFixed(2)}, ${direction.dz.toFixed(2)})`);

const streets = layoutRibbonStreets(zone, direction, cs, map.originX, map.originZ);
console.log(`  parallel streets: ${streets.parallel.length}`);
console.log(`  cross streets: ${streets.cross.length}`);
console.log(`  spacing: ${streets.spacing}m`);

// Contour adjustment
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

// Render
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
for (const z of zones) {
  for (const c of z.cells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx] = Math.min(255, pixels[idx] + 20);
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

// Ribbon streets (cyan, 3px)
for (const st of streets.parallel) {
  if (st.length < 2) continue;
  for (let i = 0; i < st.length - 1; i++) {
    const p1gx = Math.round((st[i].x - map.originX) / cs);
    const p1gz = Math.round((st[i].z - map.originZ) / cs);
    const p2gx = Math.round((st[i+1].x - map.originX) / cs);
    const p2gz = Math.round((st[i+1].z - map.originZ) / cs);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        bresenham(pixels, w, h, p1gx+dx, p1gz+dz, p2gx+dx, p2gz+dz, 0, 255, 255);
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
    for (let dx = 0; dx <= 1; dx++)
      bresenham(pixels, w, h, p1gx+dx, p1gz+dz, p2gx+dx, p2gz+dz, 255, 0, 255);
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
