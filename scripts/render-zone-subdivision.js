#!/usr/bin/env bun
/**
 * Render zones before and after zone boundary roads.
 * Shows how secondary roads subdivide large zones into smaller parcels.
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { createZoneBoundaryRoads } from '../src/city/pipeline/zoneBoundaryRoads.js';
import { subdivideLargeZones } from '../src/city/pipeline/subdivideZones.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/005-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Zone subdivision: seed=${seed} gx=${gx} gz=${gz}`);

const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });

// Run through tick 3 (extractZones)
for (let i = 0; i < 3; i++) strategy.tick();

const w = map.width, h = map.height;

// Capture first-level zones
const firstZones = map.developmentZones;
const firstZoneCount = firstZones ? firstZones.length : 0;
const firstZoneSizes = firstZones ? firstZones.map(z => z.cells.length).sort((a, b) => b - a) : [];
console.log(`First zones: ${firstZoneCount}, sizes: ${firstZoneSizes.slice(0, 10).join(', ')}...`);

// Render first-level zones
renderZones(map, firstZones, `${outDir}/zones-before-seed${seed}`);

// Add zone boundary roads
createZoneBoundaryRoads(map);

// Subdivide large zones by cutting roads through their interior
subdivideLargeZones(map);

// Re-extract zones — roads now split the old zones
extractZones(map);

const secondZones = map.developmentZones;
const secondZoneCount = secondZones ? secondZones.length : 0;
const secondZoneSizes = secondZones ? secondZones.map(z => z.cells.length).sort((a, b) => b - a) : [];
console.log(`Second zones: ${secondZoneCount}, sizes: ${secondZoneSizes.slice(0, 10).join(', ')}...`);

// Render second-level zones
renderZones(map, secondZones, `${outDir}/zones-after-seed${seed}`);

// Render roads-only
renderRoads(map, `${outDir}/roads-seed${seed}`);

console.log(`\nSubdivision: ${firstZoneCount} → ${secondZoneCount} zones`);
console.log(`Largest zone: ${firstZoneSizes[0] || 0} → ${secondZoneSizes[0] || 0} cells`);
console.log(`Median zone: ${firstZoneSizes[Math.floor(firstZoneCount/2)] || 0} → ${secondZoneSizes[Math.floor(secondZoneCount/2)] || 0} cells`);

// ── Render helpers ──────────────────────────────────────────────────

function renderZones(map, zones, basePath) {
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

  // Zone fills
  if (zones) {
    for (let zi = 0; zi < zones.length; zi++) {
      const zone = zones[zi];
      const [r, g, b] = zoneColor(zi);
      for (const c of zone.cells) {
        const idx = (c.gz * w + c.gx) * 3;
        pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
      }
    }
    // Boundaries
    for (let zi = 0; zi < zones.length; zi++) {
      const zone = zones[zi];
      if (!zone.boundary || zone.boundary.length < 3) continue;
      const b = zone.boundary;
      for (let i = 0; i < b.length; i++) {
        const p1 = b[i], p2 = b[(i + 1) % b.length];
        bresenham(pixels, w, h,
          Math.round((p1.x - map.originX) / map.cellSize),
          Math.round((p1.z - map.originZ) / map.cellSize),
          Math.round((p2.x - map.originX) / map.cellSize),
          Math.round((p2.z - map.originZ) / map.cellSize),
          255, 255, 255);
      }
    }
  }

  // Roads
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  if (roadGrid) {
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        if (roadGrid.get(x, z) > 0) {
          const idx = (z * w + x) * 3;
          pixels[idx] = 220; pixels[idx + 1] = 220; pixels[idx + 2] = 220;
        }
  }

  writePNG(basePath, pixels);
}

function renderRoads(map, basePath) {
  const pixels = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h * 3; i += 3) {
    pixels[i] = 20; pixels[i + 1] = 20; pixels[i + 2] = 30;
  }

  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  if (waterMask) {
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        if (waterMask.get(x, z) > 0) {
          const idx = (z * w + x) * 3;
          pixels[idx] = 10; pixels[idx + 1] = 15; pixels[idx + 2] = 35;
        }
  }

  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  if (roadGrid) {
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        if (roadGrid.get(x, z) > 0) {
          for (let dz = 0; dz <= 1; dz++)
            for (let dx = 0; dx <= 1; dx++) {
              const px = x + dx, pz = z + dz;
              if (px < w && pz < h) {
                const idx = (pz * w + px) * 3;
                pixels[idx] = 200; pixels[idx + 1] = 200; pixels[idx + 2] = 200;
              }
            }
        }
  }

  writePNG(basePath, pixels);
}

function writePNG(basePath, pixels) {
  const header = `P6\n${w} ${h}\n255\n`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
  console.log(`Written to ${basePath}.png`);
}

function zoneColor(i) {
  const hue = (i * 137.508) % 360;
  const c = 0.5, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = 0.2;
  let r, g, b;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

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
