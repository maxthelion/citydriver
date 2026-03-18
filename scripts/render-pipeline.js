#!/usr/bin/env bun
/**
 * Unified pipeline renderer.
 *
 * Usage:
 *   bun scripts/render-pipeline.js --seed 884469 --gx 27 --gz 95 --ticks 28 \
 *     --layers reservations,zones,roadGrid,commercialValue \
 *     --out experiments/004-output
 *
 *   bun scripts/render-pipeline.js --seed 884469 --gx 27 --gz 95 --ticks 28 --list-layers
 *
 * Flags:
 *   --seed N          City seed (default: 884469)
 *   --gx N            Settlement grid X (default: 27)
 *   --gz N            Settlement grid Z (default: 95)
 *   --ticks N         Max ticks to run (default: 28)
 *   --layers a,b,c    Comma-separated layer names to render (default: reservations)
 *   --out DIR         Output directory (default: output)
 *   --list-layers     Print available layers and exit
 *   --archetype NAME  Archetype name (default: marketTown)
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';

// ── Layer manifest ──────────────────────────────────────────────────
// Each entry: { name, availableAfterTick, source, palette, description }
// source: 'layer' = map.getLayer(name), 'grid' = map[name], 'value' = map._valueLayers, 'influence' = map._influenceLayers
const LAYER_MANIFEST = [
  // Static (tick 0)
  { name: 'elevation',       tick: 0, source: 'layer', palette: 'terrain',  desc: 'Terrain height' },
  { name: 'slope',           tick: 0, source: 'layer', palette: 'heat',     desc: 'Terrain steepness' },
  { name: 'waterMask',       tick: 0, source: 'layer', palette: 'mask',     desc: 'Water vs land' },
  { name: 'buildability',    tick: 0, source: 'grid',  palette: 'heat',     desc: 'Building suitability' },

  // After tick 1
  { name: 'roadGrid',        tick: 1, source: 'layer', palette: 'mask',     desc: 'Road cells' },

  // After tick 2
  { name: 'landValue',       tick: 2, source: 'layer', palette: 'heat',     desc: 'Land value' },

  // After tick 3
  { name: 'zoneGrid',        tick: 3, source: 'layer', palette: 'zone',     desc: 'Development zones' },

  // After tick 4
  { name: 'centrality',      tick: 4, source: 'layer', palette: 'heat',     desc: 'Distance to nuclei' },
  { name: 'waterfrontness',  tick: 4, source: 'layer', palette: 'heat',     desc: 'Proximity to water' },
  { name: 'edgeness',        tick: 4, source: 'layer', palette: 'heat',     desc: 'Distance from centre' },
  { name: 'roadFrontage',    tick: 4, source: 'layer', palette: 'heat',     desc: 'Proximity to roads' },
  { name: 'downwindness',    tick: 4, source: 'layer', palette: 'heat',     desc: 'Wind direction' },

  // After tick 5+ (growth ticks)
  { name: 'reservations',    tick: 5, source: 'special', palette: 'reservation', desc: 'Reservation grid with roads overlay' },
  { name: 'reservationGrid', tick: 5, source: 'layer', palette: 'reservation', desc: 'Raw reservation grid' },

  // Influence layers (per growth tick)
  { name: 'developmentProximity',  tick: 5, source: 'influence', palette: 'heat', desc: 'Proximity to development' },
  { name: 'industrialProximity',   tick: 5, source: 'influence', palette: 'heat', desc: 'Proximity to industrial' },
  { name: 'civicProximity',        tick: 5, source: 'influence', palette: 'heat', desc: 'Proximity to civic' },
  { name: 'parkProximity',         tick: 5, source: 'influence', palette: 'heat', desc: 'Proximity to parks' },
  { name: 'residentialProximity',  tick: 5, source: 'influence', palette: 'heat', desc: 'Proximity to residential' },

  // Value layers (per growth tick)
  { name: 'commercialValue',       tick: 5, source: 'value', palette: 'heat', desc: 'Commercial suitability' },
  { name: 'industrialValue',       tick: 5, source: 'value', palette: 'heat', desc: 'Industrial suitability' },
  { name: 'civicValue',            tick: 5, source: 'value', palette: 'heat', desc: 'Civic suitability' },
  { name: 'openSpaceValue',        tick: 5, source: 'value', palette: 'heat', desc: 'Open space suitability' },
  { name: 'residentialFineValue',  tick: 5, source: 'value', palette: 'heat', desc: 'Residential fine suitability' },
  { name: 'residentialEstateValue', tick: 5, source: 'value', palette: 'heat', desc: 'Residential estate suitability' },
  { name: 'residentialQualityValue', tick: 5, source: 'value', palette: 'heat', desc: 'Residential quality suitability' },

  // Zone boundaries (special render)
  { name: 'zones',           tick: 3, source: 'special', palette: 'zone',   desc: 'Zone boundaries + nuclei' },
];

// ── Palettes ────────────────────────────────────────────────────────
function heatColor(v) {
  const r = Math.round(v < 0.5 ? 0 : (v - 0.5) * 2 * 255);
  const g = Math.round(v < 0.5 ? v * 2 * 255 : (1 - v) * 2 * 255);
  const b = Math.round(v < 0.5 ? (1 - v * 2) * 255 : 0);
  return [r, g, b];
}

const PALETTES = {
  heat: (v) => heatColor(v),
  gray: (v) => { const c = Math.round(v * 255); return [c, c, c]; },
  terrain: (v) => [Math.round(80 + v * 140), Math.round(120 + v * 80), Math.round(40 + v * 40)],
  mask: (v) => v > 0 ? [34, 102, 204] : [26, 26, 46],
  zone: (v) => {
    if (v === 0) return [26, 26, 46];
    const hue = (v * 137.508) % 360;
    const c = 0.5, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = 0.25;
    let r, g, b;
    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  },
  reservation: (v) => ({
    0: [26, 26, 46], 1: [255, 165, 0], 2: [128, 128, 128], 3: [0, 100, 255],
    4: [0, 200, 0], 5: [120, 90, 30], 6: [230, 200, 120], 7: [200, 60, 60],
    8: [180, 120, 220], 9: [0, 180, 180],
  }[v] || [26, 26, 46]),
};

// ── Parse args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

if (hasFlag('list-layers')) {
  console.log('Available layers:\n');
  console.log('Name                         Tick  Description');
  console.log('───────────────────────────  ────  ───────────────────────────');
  for (const l of LAYER_MANIFEST) {
    console.log(`${l.name.padEnd(29)} ${String(l.tick).padEnd(5)} ${l.desc}`);
  }
  process.exit(0);
}

const seed = parseInt(getArg('seed', '884469'));
const gxArg = parseInt(getArg('gx', '27'));
const gzArg = parseInt(getArg('gz', '95'));
const maxTicks = parseInt(getArg('ticks', '28'));
const outDir = getArg('out', 'output');
const archetypeName = getArg('archetype', 'marketTown');
const layerNames = (getArg('layers', 'reservations')).split(',').map(s => s.trim());

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Pipeline: seed=${seed} gx=${gxArg} gz=${gzArg} ticks=${maxTicks} archetype=${archetypeName}`);
console.log(`Layers: ${layerNames.join(', ')}`);
console.log(`Output: ${outDir}/`);

// ── Run pipeline ────────────────────────────────────────────────────
const { layers, settlement } = generateRegionFromSeed(seed, gxArg, gzArg);
if (!settlement) { console.error('No settlement found'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const archetype = ARCHETYPES[archetypeName];
if (!archetype) { console.error(`Unknown archetype: ${archetypeName}`); process.exit(1); }
const strategy = new LandFirstDevelopment(map, { archetype });

// Snapshot skeleton roads after tick 4
let skeletonRoadSnapshot = null;

let tick = 0;
while (tick < maxTicks) {
  const t0 = performance.now();
  const more = strategy.tick();
  tick++;
  console.log(`  tick ${tick}: ${(performance.now() - t0).toFixed(0)}ms${more ? '' : ' (done)'}`);

  if (tick === 4 && !skeletonRoadSnapshot) {
    const rg = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
    if (rg) {
      skeletonRoadSnapshot = new Uint8Array(rg.data.length);
      skeletonRoadSnapshot.set(rg.data);
    }
  }

  if (!more) break;
}
console.log(`Completed ${tick} ticks\n`);

// ── Render requested layers ─────────────────────────────────────────
const w = map.width, h = map.height;

for (const name of layerNames) {
  const manifest = LAYER_MANIFEST.find(l => l.name === name);
  if (!manifest) {
    // Try as raw layer name
    if (map.hasLayer(name)) {
      renderGridLayer(name, map.getLayer(name), 'heat');
    } else {
      console.log(`  SKIP: ${name} (unknown layer)`);
    }
    continue;
  }

  if (manifest.source === 'special') {
    if (name === 'reservations') renderReservationsWithRoads();
    else if (name === 'zones') renderZones();
    else console.log(`  SKIP: ${name} (no special renderer)`);
  } else if (manifest.source === 'layer') {
    const grid = map.hasLayer(name) ? map.getLayer(name) : null;
    if (grid) renderGridLayer(name, grid, manifest.palette);
    else console.log(`  SKIP: ${name} (layer not found)`);
  } else if (manifest.source === 'grid') {
    const grid = map[name];
    if (grid && grid.get) renderGridLayer(name, grid, manifest.palette);
    else console.log(`  SKIP: ${name} (grid not found)`);
  } else if (manifest.source === 'value') {
    const key = name.replace('Value', '');
    const arr = map._valueLayers?.[key];
    if (arr) renderFloat32Layer(name, arr, 'heat');
    else console.log(`  SKIP: ${name} (value layer not found)`);
  } else if (manifest.source === 'influence') {
    const arr = map._influenceLayers?.[name];
    if (arr) renderFloat32Layer(name, arr, 'heat');
    else console.log(`  SKIP: ${name} (influence layer not found)`);
  }
}

// ── Renderers ───────────────────────────────────────────────────────
function writePPM(filename, pixels) {
  const header = `P6\n${w} ${h}\n255\n`;
  const path = `${outDir}/${filename}.ppm`;
  writeFileSync(path, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  // Also write PNG if convert is available
  try {
    const { execSync } = require('child_process');
    execSync(`convert "${path}" "${outDir}/${filename}.png" 2>/dev/null`);
    console.log(`  ${filename}.png (${w}×${h})`);
  } catch {
    console.log(`  ${filename}.ppm (${w}×${h})`);
  }
}

function renderGridLayer(name, grid, palette) {
  const pixels = new Uint8Array(w * h * 3);
  const colorFn = PALETTES[palette] || PALETTES.heat;
  const needsNorm = palette === 'heat' || palette === 'gray' || palette === 'terrain';

  let min = Infinity, max = -Infinity;
  if (needsNorm) {
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++) {
        const v = grid.get(x, z);
        if (v < min) min = v;
        if (v > max) max = v;
      }
  }
  const range = max - min || 1;

  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let v = grid.get(x, z);
      if (needsNorm) v = (v - min) / range;
      const [r, g, b] = colorFn(v);
      const idx = (z * w + x) * 3;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
  }
  writePPM(`${name}-seed${seed}-tick${tick}`, pixels);
}

function renderFloat32Layer(name, arr, palette) {
  const pixels = new Uint8Array(w * h * 3);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < w * h; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  const range = max - min || 1;
  const colorFn = PALETTES[palette] || PALETTES.heat;

  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const v = (arr[z * w + x] - min) / range;
      const [r, g, b] = colorFn(v);
      const idx = (z * w + x) * 3;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
  }
  writePPM(`${name}-seed${seed}-tick${tick}`, pixels);
}

function renderReservationsWithRoads() {
  const resGrid = map.hasLayer('reservationGrid') ? map.getLayer('reservationGrid') : null;
  if (!resGrid) { console.log('  SKIP: reservations (no grid)'); return; }

  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const pixels = new Uint8Array(w * h * 3);
  const colorFn = PALETTES.reservation;

  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      let [r, g, b] = colorFn(resGrid.get(x, z));

      if (roadGrid && roadGrid.get(x, z) > 0) {
        if (skeletonRoadSnapshot && skeletonRoadSnapshot[i] > 0) {
          r = 255; g = 255; b = 255;
        } else {
          r = 255; g = 220; b = 100;
        }
      }

      const idx = i * 3;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
  }
  writePPM(`reservations-seed${seed}-tick${tick}`, pixels);
}

function renderZones() {
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

  // Zone fills + boundaries
  const zones = map.developmentZones;
  if (zones) {
    for (let zi = 0; zi < zones.length; zi++) {
      const zone = zones[zi];
      const hue = (zi * 137.508) % 360;
      const [zr, zg, zb] = PALETTES.zone(zi + 1);
      for (const c of zone.cells) {
        const idx = (c.gz * w + c.gx) * 3;
        pixels[idx] = zr; pixels[idx + 1] = zg; pixels[idx + 2] = zb;
      }
      if (zone.boundary) {
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
  }

  // Nuclei
  for (const n of map.nuclei) {
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const px = n.gx + dx, pz = n.gz + dz;
        if (px >= 0 && px < w && pz >= 0 && pz < h) {
          const idx = (pz * w + px) * 3;
          pixels[idx] = 255; pixels[idx + 1] = 0; pixels[idx + 2] = 0;
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
          pixels[idx] = 200; pixels[idx + 1] = 200; pixels[idx + 2] = 200;
        }
  }

  writePPM(`zones-seed${seed}-tick${tick}`, pixels);
}

function bresenham(pixels, w, h, x0, y0, x1, y1, r, g, b) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (let i = 0; i < dx + dy + 1; i++) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (y * w + x) * 3;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
