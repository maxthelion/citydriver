#!/usr/bin/env bun
/**
 * render-terrain-faces.js — Visualize terrain face segmentation.
 *
 * Shows how zones split into terrain faces by slope direction/steepness.
 * Each face is a different color. Cross streets are drawn per-face.
 *
 * Usage: bun scripts/render-terrain-faces.js <seed> <gx> <gz> [outDir]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';
import { segmentZoneIntoFaces } from '../src/city/pipeline/segmentTerrainFaces.js';
import { layCrossStreets } from '../src/city/incremental/crossStreets.js';

const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/terrain-faces-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

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

// Face colors (saturated, distinct)
const faceColors = [
  [80, 140, 80],   // green
  [80, 80, 160],   // blue
  [160, 100, 60],  // brown
  [140, 60, 140],  // purple
  [60, 140, 140],  // teal
  [160, 140, 60],  // gold
];

for (let zi = 0; zi < selectedZones.length; zi++) {
  const zone = selectedZones[zi];
  console.log(`\n=== Zone ${zi} ===`);
  console.log(`  ${zone.cells.length} cells, avgSlope=${zone.avgSlope.toFixed(3)}`);

  // Segment into faces
  const faces = segmentZoneIntoFaces(zone, map);
  console.log(`  Faces: ${faces.length}`);
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    console.log(`    Face ${fi}: ${f.cells.length} cells, slope=${f.avgSlope.toFixed(3)}, dir=(${f.slopeDir.x.toFixed(2)},${f.slopeDir.z.toFixed(2)})`);
  }

  // Bounding box
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

  const pixels = new Uint8Array(cropW * cropH * 3);

  // Terrain base
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

  // Color each face's cells
  for (let fi = 0; fi < faces.length; fi++) {
    const [fr, fg, fb] = faceColors[fi % faceColors.length];
    for (const c of faces[fi].cells) {
      const px = c.gx - minGx;
      const pz = c.gz - minGz;
      if (px >= 0 && px < cropW && pz >= 0 && pz < cropH) {
        const idx = (pz * cropW + px) * 3;
        pixels[idx] = Math.min(255, Math.round(pixels[idx] * 0.4 + fr * 0.6));
        pixels[idx + 1] = Math.min(255, Math.round(pixels[idx + 1] * 0.4 + fg * 0.6));
        pixels[idx + 2] = Math.min(255, Math.round(pixels[idx + 2] * 0.4 + fb * 0.6));
      }
    }
  }

  // Roads
  if (roadGrid) {
    for (let z = 0; z < cropH; z++)
      for (let x = 0; x < cropW; x++)
        if (roadGrid.get(x + minGx, z + minGz) > 0) {
          const idx = (z * cropW + x) * 3;
          pixels[idx] = 180; pixels[idx + 1] = 180; pixels[idx + 2] = 180;
        }
  }

  // Cross streets per face (magenta)
  for (const face of faces) {
    const { crossStreets } = layCrossStreets(face, map);
    for (const street of crossStreets) {
      const pts = street.points;
      for (let i = 1; i < pts.length; i++) {
        bres(pixels, cropW, cropH,
          Math.round((pts[i - 1].x - ox) / cs) - minGx,
          Math.round((pts[i - 1].z - oz) / cs) - minGz,
          Math.round((pts[i].x - ox) / cs) - minGx,
          Math.round((pts[i].z - oz) / cs) - minGz,
          255, 0, 255);
      }
    }
  }

  // Zone boundary (yellow)
  if (zone.boundary) {
    for (let i = 0; i < zone.boundary.length; i++) {
      const p1 = zone.boundary[i], p2 = zone.boundary[(i + 1) % zone.boundary.length];
      const x0 = Math.round((p1.x - ox) / cs) - minGx;
      const y0 = Math.round((p1.z - oz) / cs) - minGz;
      const x1 = Math.round((p2.x - ox) / cs) - minGx;
      const y1 = Math.round((p2.z - oz) / cs) - minGz;
      bres(pixels, cropW, cropH, x0, y0, x1, y1, 255, 255, 0);
      bres(pixels, cropW, cropH, x0 + 1, y0, x1 + 1, y1, 255, 255, 0);
    }
  }

  const header = `P6\n${cropW} ${cropH}\n255\n`;
  const basePath = `${outDir}/faces-zone${zi}-seed${seed}`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
  console.log(`  Written to ${basePath}.png (${cropW}x${cropH})`);
}

console.log(`\nTotal time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

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
