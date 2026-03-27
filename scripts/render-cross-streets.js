#!/usr/bin/env bun
/**
 * render-cross-streets.js — Cross streets only (no ribbons).
 *
 * Renders the vector-march cross street algorithm from
 * wiki/pages/laying-zone-cross-streets.md.
 *
 * Usage: bun scripts/render-cross-streets.js <seed> <gx> <gz> [outDir]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';
import { layCrossStreets } from '../src/city/incremental/crossStreets.js';

// === CLI ===
const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/cross-streets-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// === Pipeline setup ===
const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
runToStep(strategy, 'spatial');

const zones = map.developmentZones;
const W = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');
const roadGrid = map.getLayer('roadGrid');
const waterMask = map.getLayer('waterMask');
const eBounds = elev.bounds();
const eRange = eBounds.max - eBounds.min || 1;

// === Zone selection ===
const candidates = zones.filter(z =>
  z.cells.length > 500 &&
  z.boundary && z.boundary.length >= 4 && z.avgSlope !== undefined
);
candidates.sort((a, b) => {
  const ad = Math.abs(a.centroidGx - W / 2) + Math.abs(a.centroidGz - H / 2);
  const bd = Math.abs(b.centroidGx - W / 2) + Math.abs(b.centroidGz - H / 2);
  return ad - bd;
});
const selectedZones = candidates.slice(0, 3);

if (selectedZones.length === 0) {
  console.error('No suitable zones found');
  process.exit(1);
}

console.log(`Found ${candidates.length} candidate zones, rendering ${selectedZones.length}`);

// === Process each zone ===
for (let zi = 0; zi < selectedZones.length; zi++) {
  const zone = selectedZones[zi];
  console.log(`\n=== Zone ${zi} ===`);
  console.log(`  ${zone.cells.length} cells, avgSlope=${zone.avgSlope.toFixed(3)}`);

  // Zone bounding box for cropped render
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
  console.log(`  Crop: ${cropW}x${cropH} at (${minGx},${minGz})`);

  // Run cross street algorithm
  const { crossStreets, gradDir } = layCrossStreets(zone, map);

  console.log(`  Gradient: (${gradDir.x.toFixed(3)}, ${gradDir.z.toFixed(3)})`);
  console.log(`  Cross streets: ${crossStreets.length}`);
  for (const cs2 of crossStreets) {
    console.log(`    length=${cs2.length.toFixed(0)}m, points=${cs2.points.length}`);
  }

  // ===== Render =====
  const pixels = new Uint8Array(cropW * cropH * 3);

  // Terrain base (elevation grayscale)
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const v = (elev.get(gx2, gz2) - eBounds.min) / eRange;
      const idx = (z * cropW + x) * 3;
      if (waterMask && waterMask.get(gx2, gz2) > 0) {
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 80;
      } else {
        const grey = Math.round(40 + v * 80);
        pixels[idx] = grey; pixels[idx + 1] = grey; pixels[idx + 2] = grey;
      }
    }
  }

  // Elevation contour lines (dark green, every 5m of elevation)
  const contourInterval = 5;
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const e = elev.get(gx2, gz2);
      // Check if any neighbour crosses a contour line
      let isContour = false;
      const eBin = Math.floor(e / contourInterval);
      if (gx2 + 1 < W && Math.floor(elev.get(gx2 + 1, gz2) / contourInterval) !== eBin) isContour = true;
      if (gz2 + 1 < H && Math.floor(elev.get(gx2, gz2 + 1) / contourInterval) !== eBin) isContour = true;
      if (isContour) {
        const idx = (z * cropW + x) * 3;
        pixels[idx] = Math.min(255, pixels[idx] + 30);
        pixels[idx + 1] = Math.min(255, pixels[idx + 1] + 50);
        pixels[idx + 2] = Math.min(255, pixels[idx + 2] + 20);
      }
    }
  }

  // Roads (light grey)
  if (roadGrid) {
    for (let z = 0; z < cropH; z++)
      for (let x = 0; x < cropW; x++)
        if (roadGrid.get(x + minGx, z + minGz) > 0) {
          const idx = (z * cropW + x) * 3;
          pixels[idx] = 150; pixels[idx + 1] = 150; pixels[idx + 2] = 150;
        }
  }

  // Cross streets (magenta polylines)
  for (const street of crossStreets) {
    const pts = street.points;
    for (let i = 1; i < pts.length; i++) {
      bres(pixels, cropW, cropH,
        Math.round((pts[i - 1].x - ox) / cs) - minGx, Math.round((pts[i - 1].z - oz) / cs) - minGz,
        Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
        255, 0, 255);
    }
    // Start dot (green, 3px)
    const sx = Math.round((pts[0].x - ox) / cs) - minGx;
    const sz = Math.round((pts[0].z - oz) / cs) - minGz;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (sx + dx >= 0 && sx + dx < cropW && sz + dz >= 0 && sz + dz < cropH) {
          const idx = ((sz + dz) * cropW + (sx + dx)) * 3;
          pixels[idx] = 0; pixels[idx + 1] = 255; pixels[idx + 2] = 0;
        }
    // End dot (white, 3px)
    const ex = Math.round((pts[pts.length - 1].x - ox) / cs) - minGx;
    const ez = Math.round((pts[pts.length - 1].z - oz) / cs) - minGz;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (ex + dx >= 0 && ex + dx < cropW && ez + dz >= 0 && ez + dz < cropH) {
          const idx = ((ez + dz) * cropW + (ex + dx)) * 3;
          pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
        }
  }

  // Zone boundary (bright yellow, drawn last so it's on top)
  if (zone.boundary) {
    for (let i = 0; i < zone.boundary.length; i++) {
      const p1 = zone.boundary[i], p2 = zone.boundary[(i + 1) % zone.boundary.length];
      const x0 = Math.round((p1.x - ox) / cs) - minGx;
      const y0 = Math.round((p1.z - oz) / cs) - minGz;
      const x1 = Math.round((p2.x - ox) / cs) - minGx;
      const y1 = Math.round((p2.z - oz) / cs) - minGz;
      bres(pixels, cropW, cropH, x0, y0, x1, y1, 255, 255, 0);
      bres(pixels, cropW, cropH, x0 + 1, y0, x1 + 1, y1, 255, 255, 0);
      bres(pixels, cropW, cropH, x0, y0 + 1, x1, y1 + 1, 255, 255, 0);
    }
  }

  // === Write output ===
  const header = `P6\n${cropW} ${cropH}\n255\n`;
  const basePath = `${outDir}/cross-streets-zone${zi}-seed${seed}`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
  console.log(`  Written to ${basePath}.png (${cropW}x${cropH})`);
}

console.log(`\nTotal time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// === Bresenham line draw ===
function bres(pixels, w, h, x0, y0, x1, y1, r, g, b) {
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
