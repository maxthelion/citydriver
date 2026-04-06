#!/usr/bin/env bun
/**
 * render-ridge-slope-bands.js — Direction + slope steepness band segmentation.
 *
 * Splits terrain by gradient direction (30°) AND steepness band
 * (flat <0.3, moderate 0.3-0.8, steep >0.8). A gentle coast and steep
 * hillside pointing the same way get separate faces.
 *
 * Usage: bun scripts/render-ridge-slope-bands.js <seed> <gx> <gz> [outDir]
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
const outDir = process.argv[5] || 'experiments/019f-output';
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

console.log('Segmenting terrain (30° dir + slope bands [0.3, 0.8])...');
const { faces, ridgeCells } = segmentTerrainV2(map, {
  dirTolerance: Math.PI / 6,
  slopeBands: [0.3, 0.8],
});
console.log(`Terrain faces: ${faces.length}, boundary cells: ${ridgeCells.size}`);
for (let i = 0; i < faces.length; i++) {
  const f = faces[i];
  let minE = Infinity, maxE = -Infinity, slopeSum = 0;
  for (const c of f.cells) {
    const e = elev.get(c.gx, c.gz);
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    if (c.gx > 0 && c.gx < W - 1 && c.gz > 0 && c.gz < H - 1) {
      const dx = (elev.get(c.gx + 1, c.gz) - elev.get(c.gx - 1, c.gz)) / 2;
      const dz = (elev.get(c.gx, c.gz + 1) - elev.get(c.gx, c.gz - 1)) / 2;
      slopeSum += Math.sqrt(dx * dx + dz * dz);
    }
  }
  const avgSlope = slopeSum / f.cells.length;
  const dirDeg = Math.round(Math.atan2(f.slopeDir.z, f.slopeDir.x) * 180 / Math.PI);
  console.log(`  Face ${i}: ${f.cells.length} cells, dir=${dirDeg}°, avgSlope=${avgSlope.toFixed(3)}, elev ${minE.toFixed(0)}-${maxE.toFixed(0)}m (${(maxE-minE).toFixed(0)}m range)`);
}

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

const faceColors = faces.map((_, i) => {
  const hue = (i * 137.508) % 360;
  return hslToRgb(hue, 0.6, 0.45);
});

const pixels = new Uint8Array(W * H * 3);
for (let z = 0; z < H; z++) {
  for (let x = 0; x < W; x++) {
    const v = (elev.get(x, z) - eBounds.min) / eRange;
    const grey = Math.round(40 + v * 180);
    const idx = (z * W + x) * 3;
    pixels[idx] = grey; pixels[idx + 1] = grey; pixels[idx + 2] = grey;
  }
}
if (waterMask) {
  for (let z = 0; z < H; z++)
    for (let x = 0; x < W; x++)
      if (waterMask.get(x, z) > 0) {
        const idx = (z * W + x) * 3;
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
      }
}

const FACE_ALPHA = 0.4;
for (let fi = 0; fi < faces.length; fi++) {
  const color = faceColors[fi];
  for (const c of faces[fi].cells) {
    if (c.gx < 0 || c.gx >= W || c.gz < 0 || c.gz >= H) continue;
    const idx = (c.gz * W + c.gx) * 3;
    pixels[idx]     = Math.round(pixels[idx]     * (1 - FACE_ALPHA) + color[0] * FACE_ALPHA);
    pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - FACE_ALPHA) + color[1] * FACE_ALPHA);
    pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - FACE_ALPHA) + color[2] * FACE_ALPHA);
  }
}

for (const key of ridgeCells) {
  const rgz = Math.floor(key / W);
  const rgx = key % W;
  if (rgx >= 0 && rgx < W && rgz >= 0 && rgz < H) {
    const idx = (rgz * W + rgx) * 3;
    pixels[idx] = 240; pixels[idx + 1] = 240; pixels[idx + 2] = 240;
  }
}

if (roadGrid) {
  for (let z = 0; z < H; z++)
    for (let x = 0; x < W; x++)
      if (roadGrid.get(x, z) > 0) {
        const idx = (z * W + x) * 3;
        pixels[idx] = 160; pixels[idx + 1] = 160; pixels[idx + 2] = 160;
      }
}

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

const header = `P6\n${W} ${H}\n255\n`;
const basePath = `${outDir}/ridge-slope-bands-seed${seed}`;
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
