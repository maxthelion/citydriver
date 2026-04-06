#!/usr/bin/env bun
/**
 * render-ridge-faces.js — Ridge/valley terrain face segmentation + per-face cross streets.
 *
 * For each of the top 3 zones:
 * - Runs segmentByRidges to split into terrain faces
 * - Colors each face a different hue
 * - Draws ridge/valley cells as white dots
 * - Runs layCrossStreets per-face and draws cross streets in magenta
 * - Draws zone boundary in yellow, roads in grey, contour lines
 *
 * Usage: bun scripts/render-ridge-faces.js <seed> <gx> <gz> [outDir]
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
import { segmentByRidges } from '../src/city/incremental/ridgeSegmentation.js';

// === CLI ===
const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/019-output';
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

// === Zone selection (same as render-cross-streets.js) ===
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

// Face colors (distinct hues)
const FACE_COLORS = [
  [60, 120, 60],    // green
  [60, 60, 140],    // blue
  [140, 60, 60],    // red
  [120, 100, 40],   // olive
  [60, 120, 120],   // teal
  [120, 60, 120],   // purple
];

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

  // Run ridge segmentation
  const { faces, ridgeCells } = segmentByRidges(zone, map);
  console.log(`  Faces: ${faces.length}, ridge cells: ${ridgeCells.size}`);

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    console.log(`    Face ${fi}: ${face.cells.length} cells, slopeDir=(${face.slopeDir.x.toFixed(3)}, ${face.slopeDir.z.toFixed(3)})`);
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

  // Color face cells
  for (let fi = 0; fi < faces.length; fi++) {
    const color = FACE_COLORS[fi % FACE_COLORS.length];
    for (const c of faces[fi].cells) {
      const px = c.gx - minGx;
      const pz = c.gz - minGz;
      if (px >= 0 && px < cropW && pz >= 0 && pz < cropH) {
        const v = (elev.get(c.gx, c.gz) - eBounds.min) / eRange;
        const bright = 0.5 + v * 0.5;
        const idx = (pz * cropW + px) * 3;
        pixels[idx]     = Math.round(color[0] * bright);
        pixels[idx + 1] = Math.round(color[1] * bright);
        pixels[idx + 2] = Math.round(color[2] * bright);
      }
    }
  }

  // Elevation contour lines (dark green, every 5m)
  const contourInterval = 5;
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const e = elev.get(gx2, gz2);
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

  // Face boundary cells as thin white line
  for (const key of ridgeCells) {
    const rgz = Math.floor(key / W);
    const rgx = key % W;
    const px = rgx - minGx;
    const pz = rgz - minGz;
    if (px >= 0 && px < cropW && pz >= 0 && pz < cropH) {
      const idx = (pz * cropW + px) * 3;
      pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
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

  // Per-face cross streets (magenta polylines)
  let totalStreets = 0;
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    const { crossStreets, gradDir } = layCrossStreets(face, map);
    console.log(`    Face ${fi} cross streets: ${crossStreets.length}, gradDir=(${gradDir.x.toFixed(3)}, ${gradDir.z.toFixed(3)})`);
    totalStreets += crossStreets.length;

    for (const street of crossStreets) {
      const pts = street.points;
      for (let i = 1; i < pts.length; i++) {
        bres(pixels, cropW, cropH,
          Math.round((pts[i - 1].x - ox) / cs) - minGx, Math.round((pts[i - 1].z - oz) / cs) - minGz,
          Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
          255, 0, 255);
      }
      // Start dot (green)
      const sx = Math.round((pts[0].x - ox) / cs) - minGx;
      const sz = Math.round((pts[0].z - oz) / cs) - minGz;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (sx + dx >= 0 && sx + dx < cropW && sz + dz >= 0 && sz + dz < cropH) {
            const idx = ((sz + dz) * cropW + (sx + dx)) * 3;
            pixels[idx] = 0; pixels[idx + 1] = 255; pixels[idx + 2] = 0;
          }
      // End dot (white)
      const ex = Math.round((pts[pts.length - 1].x - ox) / cs) - minGx;
      const ez = Math.round((pts[pts.length - 1].z - oz) / cs) - minGz;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (ex + dx >= 0 && ex + dx < cropW && ez + dz >= 0 && ez + dz < cropH) {
            const idx = ((ez + dz) * cropW + (ex + dx)) * 3;
            pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
          }
    }
  }
  console.log(`  Total cross streets: ${totalStreets}`);

  // Zone boundary (bright yellow, drawn last)
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
  const basePath = `${outDir}/ridge-faces-zone${zi}-seed${seed}`;
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
