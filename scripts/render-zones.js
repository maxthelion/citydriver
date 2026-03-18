#!/usr/bin/env bun
/**
 * Render zone boundaries as a standalone bitmap.
 * Usage: bun scripts/render-zones.js [seed] [gx] [gz]
 * Output: output/zones-seed{N}.ppm
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;

console.log(`Generating zones: seed=${seed} gx=${gx} gz=${gz}`);

const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });

// Run through tick 3 (extractZones)
for (let i = 0; i < 3; i++) strategy.tick();

const w = map.width;
const h = map.height;

// Base: dark background with terrain hint
const pixels = new Uint8Array(w * h * 3);
const elev = map.getLayer('elevation');
const waterMask = map.getLayer('waterMask');

// Terrain base
if (elev) {
  const bounds = elev.bounds();
  const range = bounds.max - bounds.min || 1;
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const v = (elev.get(gx, gz) - bounds.min) / range;
      const idx = (gz * w + gx) * 3;
      pixels[idx] = Math.round(30 + v * 40);
      pixels[idx + 1] = Math.round(40 + v * 30);
      pixels[idx + 2] = Math.round(20 + v * 20);
    }
  }
}

// Water
if (waterMask) {
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (waterMask.get(gx, gz) > 0) {
        const idx = (gz * w + gx) * 3;
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
      }
    }
  }
}

// Fill zones with faint colour
const zones = map.developmentZones;
if (zones) {
  const hueStep = 137.508;
  for (let zi = 0; zi < zones.length; zi++) {
    const zone = zones[zi];
    const hue = (zi * hueStep) % 360;
    const [zr, zg, zb] = hslToRgb(hue, 0.4, 0.25);
    for (const c of zone.cells) {
      const idx = (c.gz * w + c.gx) * 3;
      pixels[idx] = zr;
      pixels[idx + 1] = zg;
      pixels[idx + 2] = zb;
    }
  }

  // Draw zone boundaries as bright lines
  for (let zi = 0; zi < zones.length; zi++) {
    const zone = zones[zi];
    if (!zone.boundary || zone.boundary.length < 3) continue;
    const hue = (zi * hueStep) % 360;
    const [br, bg, bb] = hslToRgb(hue, 0.7, 0.6);
    const b = zone.boundary;
    for (let i = 0; i < b.length; i++) {
      const p1 = b[i];
      const p2 = b[(i + 1) % b.length];
      drawLine(pixels, w, h,
        Math.round((p1.x - map.originX) / map.cellSize),
        Math.round((p1.z - map.originZ) / map.cellSize),
        Math.round((p2.x - map.originX) / map.cellSize),
        Math.round((p2.z - map.originZ) / map.cellSize),
        br, bg, bb);
    }
  }
}

// Draw nuclei as white dots
for (const n of map.nuclei) {
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const px = n.gx + dx, pz = n.gz + dz;
      if (px >= 0 && px < w && pz >= 0 && pz < h) {
        const idx = (pz * w + px) * 3;
        pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
      }
    }
  }
}

// Draw roads
const roadGrid = map.getLayer('roadGrid');
if (roadGrid) {
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (roadGrid.get(gx, gz) > 0) {
        const idx = (gz * w + gx) * 3;
        pixels[idx] = 200; pixels[idx + 1] = 200; pixels[idx + 2] = 200;
      }
    }
  }
}

const header = `P6\n${w} ${h}\n255\n`;
const outPath = `output/zones-seed${seed}.ppm`;
await Bun.write(outPath, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
console.log(`Written to ${outPath} (${w}×${h})`);
console.log(`Zones: ${zones?.length || 0}, Nuclei: ${map.nuclei.length}`);

function drawLine(pixels, w, h, x0, y0, x1, y1, r, g, b) {
  const dx = Math.abs(x1 - x0), dz = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sz = y0 < y1 ? 1 : -1;
  let err = dx - dz;
  let x = x0, z = y0;
  for (let i = 0; i < dx + dz + 1; i++) {
    if (x >= 0 && x < w && z >= 0 && z < h) {
      const idx = (z * w + x) * 3;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; x += sx; }
    if (e2 < dx) { err += dx; z += sz; }
  }
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
