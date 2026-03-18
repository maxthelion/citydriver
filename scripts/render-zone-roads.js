#!/usr/bin/env bun
/**
 * Render zone boundary roads experiment.
 * Shows: terrain + zones + arterial roads + new zone boundary roads
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { createZoneBoundaryRoads } from '../src/city/pipeline/zoneBoundaryRoads.js';
import { writeFileSync } from 'fs';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/004-output';

console.log(`Zone boundary roads: seed=${seed} gx=${gx} gz=${gz}`);

const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });

// Run through tick 3 (extractZones)
for (let i = 0; i < 3; i++) strategy.tick();

const w = map.width, h = map.height;

// Snapshot road grid before adding zone boundary roads
const roadGridBefore = new Uint8Array(w * h);
const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
if (roadGrid) {
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      roadGridBefore[z * w + x] = roadGrid.get(x, z);
}

// Create zone boundary roads
const result = createZoneBoundaryRoads(map);

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

// Water
if (waterMask) {
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      if (waterMask.get(x, z) > 0) {
        const idx = (z * w + x) * 3;
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
      }
}

// Zone fills (faint)
const zones = map.developmentZones;
if (zones) {
  for (let zi = 0; zi < zones.length; zi++) {
    const zone = zones[zi];
    const hue = (zi * 137.508) % 360;
    const c = 0.3, x2 = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = 0.15;
    let r, g, b;
    if (hue < 60) [r, g, b] = [c, x2, 0];
    else if (hue < 120) [r, g, b] = [x2, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x2];
    else if (hue < 240) [r, g, b] = [0, x2, c];
    else if (hue < 300) [r, g, b] = [x2, 0, c];
    else [r, g, b] = [c, 0, x2];
    for (const cell of zone.cells) {
      const idx = (cell.gz * w + cell.gx) * 3;
      pixels[idx] = Math.round((r + m) * 255);
      pixels[idx + 1] = Math.round((g + m) * 255);
      pixels[idx + 2] = Math.round((b + m) * 255);
    }
  }
}

// Arterial roads (white)
if (roadGrid) {
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      if (roadGridBefore[z * w + x] > 0) {
        const idx = (z * w + x) * 3;
        pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
      }
}

// New zone boundary roads (yellow)
if (roadGrid) {
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      if (roadGrid.get(x, z) > 0 && roadGridBefore[z * w + x] === 0) {
        const idx = (z * w + x) * 3;
        pixels[idx] = 255; pixels[idx + 1] = 220; pixels[idx + 2] = 0;
      }
}

// Junction candidates (red dots)
for (const j of result.junctions) {
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const px = j.gx + dx, pz = j.gz + dz;
      if (px >= 0 && px < w && pz >= 0 && pz < h) {
        const idx = (pz * w + px) * 3;
        pixels[idx] = 255; pixels[idx + 1] = 0; pixels[idx + 2] = 0;
      }
    }
}

const { execSync } = require('child_process');
const { mkdirSync, existsSync } = require('fs');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const ppmPath = `${outDir}/zone-roads-seed${seed}.ppm`;
const pngPath = `${outDir}/zone-roads-seed${seed}.png`;
const header = `P6\n${w} ${h}\n255\n`;
writeFileSync(ppmPath, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
try { execSync(`convert "${ppmPath}" "${pngPath}" 2>/dev/null`); } catch {}
console.log(`Written to ${pngPath}`);
