#!/usr/bin/env bun
/**
 * render-parcels.js — Zone × Face intersection parcels.
 *
 * Each parcel is the overlap of one zone with one terrain face.
 * Renders: elevation base, water, semi-transparent parcel colors,
 * parcel boundaries (white), zone boundaries (yellow), roads (grey).
 *
 * Usage: bun scripts/render-parcels.js <seed> <gx> <gz> [outDir]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';
import { segmentTerrainV2 } from '../src/city/incremental/ridgeSegmentationV2.js';

const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/020-output';
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

console.log(`Map: ${W}x${H}, ${zones.length} zones`);

// === Segment terrain into faces ===
console.log('Segmenting terrain...');
const { faces } = segmentTerrainV2(map, {
  dirTolerance: Math.PI / 6,
  elevTolerance: 100,
  slopeBands: [0.3, 0.8],
});
console.log(`Terrain faces: ${faces.length}`);

// === Build face lookup: cell key → face index ===
const cellToFace = new Map();
for (let fi = 0; fi < faces.length; fi++) {
  for (const c of faces[fi].cells) {
    cellToFace.set(c.gz * W + c.gx, fi);
  }
}

// === Intersect zones × faces to create parcels ===
const parcels = []; // { zoneIdx, faceIdx, cells }
const parcelMap = new Map(); // "zi:fi" → parcel index

for (let zi = 0; zi < zones.length; zi++) {
  const zone = zones[zi];
  if (!zone.cells || zone.cells.length < 30) continue;

  for (const c of zone.cells) {
    const key = c.gz * W + c.gx;
    const fi = cellToFace.get(key);
    if (fi === undefined) continue;

    const pKey = `${zi}:${fi}`;
    let pi = parcelMap.get(pKey);
    if (pi === undefined) {
      pi = parcels.length;
      parcelMap.set(pKey, pi);
      parcels.push({ zoneIdx: zi, faceIdx: fi, cells: [] });
    }
    parcels[pi].cells.push(c);
  }
}

// Filter out tiny parcels
const MIN_PARCEL_CELLS = 50;
const validParcels = parcels.filter(p => p.cells.length >= MIN_PARCEL_CELLS);
const tinyParcels = parcels.filter(p => p.cells.length < MIN_PARCEL_CELLS);

// Log stats
console.log(`Parcels: ${parcels.length} total, ${validParcels.length} valid (≥${MIN_PARCEL_CELLS} cells), ${tinyParcels.length} tiny`);

let totalParcelCells = 0;
for (const p of validParcels) totalParcelCells += p.cells.length;
const avgSize = Math.round(totalParcelCells / validParcels.length);
const sizes = validParcels.map(p => p.cells.length).sort((a, b) => a - b);
console.log(`  Size: avg=${avgSize}, median=${sizes[Math.floor(sizes.length/2)]}, min=${sizes[0]}, max=${sizes[sizes.length-1]}`);

// Count how many parcels per zone
const parcelsPerZone = new Map();
for (const p of validParcels) {
  parcelsPerZone.set(p.zoneIdx, (parcelsPerZone.get(p.zoneIdx) || 0) + 1);
}
const ppzValues = [...parcelsPerZone.values()].sort((a, b) => a - b);
console.log(`  Parcels per zone: avg=${(validParcels.length / parcelsPerZone.size).toFixed(1)}, median=${ppzValues[Math.floor(ppzValues.length/2)]}, max=${ppzValues[ppzValues.length-1]}`);

// === Color generation ===
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const parcelColors = validParcels.map((_, i) => {
  const hue = (i * 137.508) % 360;
  return hslToRgb(hue, 0.6, 0.45);
});

// === Build parcel cell lookup for boundary detection ===
const cellToParcel = new Map();
for (let pi = 0; pi < validParcels.length; pi++) {
  for (const c of validParcels[pi].cells) {
    cellToParcel.set(c.gz * W + c.gx, pi);
  }
}
// Assign tiny parcel cells too (for boundary continuity)
for (const p of tinyParcels) {
  for (const c of p.cells) {
    cellToParcel.set(c.gz * W + c.gx, -1);
  }
}

// === Render ===
const pixels = new Uint8Array(W * H * 3);

// Layer 1: Elevation grayscale
for (let z = 0; z < H; z++) {
  for (let x = 0; x < W; x++) {
    const v = (elev.get(x, z) - eBounds.min) / eRange;
    const grey = Math.round(40 + v * 180);
    const idx = (z * W + x) * 3;
    pixels[idx] = grey; pixels[idx + 1] = grey; pixels[idx + 2] = grey;
  }
}

// Layer 2: Water
if (waterMask) {
  for (let z = 0; z < H; z++)
    for (let x = 0; x < W; x++)
      if (waterMask.get(x, z) > 0) {
        const idx = (z * W + x) * 3;
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
      }
}

// Layer 3: Parcel fills
const ALPHA = 0.4;
for (let pi = 0; pi < validParcels.length; pi++) {
  const color = parcelColors[pi];
  for (const c of validParcels[pi].cells) {
    if (c.gx < 0 || c.gx >= W || c.gz < 0 || c.gz >= H) continue;
    const idx = (c.gz * W + c.gx) * 3;
    pixels[idx]     = Math.round(pixels[idx]     * (1 - ALPHA) + color[0] * ALPHA);
    pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - ALPHA) + color[1] * ALPHA);
    pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - ALPHA) + color[2] * ALPHA);
  }
}

// Layer 4: Parcel boundaries (thin white — where adjacent cells are in different parcels)
for (let pi = 0; pi < validParcels.length; pi++) {
  for (const c of validParcels[pi].cells) {
    const key = c.gz * W + c.gx;
    for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nk = (c.gz + dz) * W + (c.gx + dx);
      const npi = cellToParcel.get(nk);
      if (npi !== undefined && npi !== pi) {
        const idx = (c.gz * W + c.gx) * 3;
        pixels[idx] = 220; pixels[idx + 1] = 220; pixels[idx + 2] = 220;
        break;
      }
    }
  }
}

// Layer 5: Roads
if (roadGrid) {
  for (let z = 0; z < H; z++)
    for (let x = 0; x < W; x++)
      if (roadGrid.get(x, z) > 0) {
        const idx = (z * W + x) * 3;
        pixels[idx] = 160; pixels[idx + 1] = 160; pixels[idx + 2] = 160;
      }
}

// Layer 6: Zone boundaries (yellow)
for (const zone of zones) {
  if (!zone.boundary || zone.boundary.length < 3) continue;
  const b = zone.boundary;
  for (let i = 0; i < b.length; i++) {
    const p1 = b[i], p2 = b[(i + 1) % b.length];
    const x0 = Math.round((p1.x - ox) / cs);
    const y0 = Math.round((p1.z - oz) / cs);
    const x1 = Math.round((p2.x - ox) / cs);
    const y1 = Math.round((p2.z - oz) / cs);
    bres(pixels, W, H, x0, y0, x1, y1, 255, 220, 0);
    bres(pixels, W, H, x0 + 1, y0, x1 + 1, y1, 255, 220, 0);
  }
}

// === Write ===
const header = `P6\n${W} ${H}\n255\n`;
const basePath = `${outDir}/parcels-seed${seed}`;
writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
console.log(`Written to ${basePath}.png (${W}x${H})`);
console.log(`Total time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

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
