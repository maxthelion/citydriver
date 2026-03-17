#!/usr/bin/env node

/**
 * Debug script: render river + elevation bitmaps at each stage
 * of the regional pipeline for a given seed.
 *
 * Usage:
 *   node scripts/debug-rivers.js [--seed 786031] [--out debug-rivers]
 *
 * Outputs numbered PNGs showing how rivers and elevation evolve.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

import { SeededRandom } from '../src/core/rng.js';
import { Grid2D } from '../src/core/Grid2D.js';
import { generateTectonics } from '../src/regional/generateTectonics.js';
import { generateGeology } from '../src/regional/generateGeology.js';
import { generateTerrain } from '../src/regional/generateTerrain.js';
import { planRiverCorridors } from '../src/regional/planRiverCorridors.js';
import { generateCoastline } from '../src/regional/generateCoastline.js';
import { PerlinNoise } from '../src/core/noise.js';
import {
  fillSinks, dinfFlowDirections, dinfFlowAccumulation, extractStreams,
  findConfluences, smoothRiverPaths,
} from '../src/core/flowAccumulation.js';
import {
  segmentsToVectorPaths, paintPathsOntoWaterMask, riverHalfWidth, channelProfile,
} from '../src/core/riverGeometry.js';
import {
  computeValleyDepthField, computeFloodplainField, applyTerrainFields,
} from '../src/regional/carveValleys.js';

// --- Args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const SEED = Number(getArg('--seed')) || 786031;
const outDir = getArg('--out') || `debug-rivers-${SEED}`;
const W = 256, H = 256, CELL_SIZE = 50, SEA_LEVEL = 0;

console.log(`Seed: ${SEED}, output: ${outDir}/`);

// --- Rendering helpers ---

function renderElevation(elevation, label, extras = {}) {
  const pixels = new Uint8Array(W * H * 3);
  const { waterMask, overlay } = extras;

  // Find elevation range for normalization
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < W * H; i++) {
    const v = elevation.data[i];
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  const range = maxH - minH || 1;

  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = (gz * W + gx) * 3;
      const h = elevation.get(gx, gz);

      if (waterMask && waterMask.get(gx, gz) > 0) {
        // Water: blue, darker = deeper
        const depth = Math.max(0, SEA_LEVEL - h);
        const v = Math.max(30, 180 - depth * 3);
        pixels[idx] = 20; pixels[idx + 1] = 40; pixels[idx + 2] = v;
      } else if (h < SEA_LEVEL) {
        // Below sea level but not in waterMask: dark blue-grey
        pixels[idx] = 40; pixels[idx + 1] = 50; pixels[idx + 2] = 80;
      } else {
        // Land: green-brown gradient by elevation
        const t = (h - SEA_LEVEL) / (maxH - SEA_LEVEL || 1);
        // Low = green, mid = brown, high = grey-white
        if (t < 0.3) {
          const s = t / 0.3;
          pixels[idx] = Math.round(50 + s * 80);
          pixels[idx + 1] = Math.round(120 - s * 30);
          pixels[idx + 2] = Math.round(40 + s * 20);
        } else if (t < 0.7) {
          const s = (t - 0.3) / 0.4;
          pixels[idx] = Math.round(130 + s * 40);
          pixels[idx + 1] = Math.round(90 + s * 30);
          pixels[idx + 2] = Math.round(60 + s * 40);
        } else {
          const s = (t - 0.7) / 0.3;
          pixels[idx] = Math.round(170 + s * 80);
          pixels[idx + 1] = Math.round(120 + s * 120);
          pixels[idx + 2] = Math.round(100 + s * 140);
        }
      }
    }
  }

  // Overlay if provided (function that stamps onto pixels)
  if (overlay) overlay(pixels);

  return { pixels, label, minH, maxH };
}

function renderGrid(grid, label, colorFn) {
  const pixels = new Uint8Array(W * H * 3);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = (gz * W + gx) * 3;
      const v = grid.get(gx, gz);
      const [r, g, b] = colorFn(v, gx, gz);
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
  }
  return { pixels, label };
}

function stampSegments(pixels, rivers, color = [50, 100, 220]) {
  function walk(seg) {
    for (const cell of seg.cells) {
      const { gx, gz } = cell;
      if (gx >= 0 && gx < W && gz >= 0 && gz < H) {
        const idx = (gz * W + gx) * 3;
        pixels[idx] = color[0]; pixels[idx + 1] = color[1]; pixels[idx + 2] = color[2];
      }
    }
    for (const child of (seg.children || [])) walk(child);
  }
  for (const root of rivers) walk(root);
}

function stampPaths(pixels, paths, color = [50, 100, 220]) {
  for (const path of paths) {
    const pts = path.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const gx = Math.round(p.x / CELL_SIZE);
      const gz = Math.round(p.z / CELL_SIZE);
      if (gx >= 0 && gx < W && gz >= 0 && gz < H) {
        // Stamp with width
        const hw = (p.width || 4) / 2;
        const r = Math.max(1, Math.ceil(hw / CELL_SIZE));
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = gx + dx, nz = gz + dz;
            if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
              if (Math.sqrt(dx * dx + dz * dz) * CELL_SIZE <= hw) {
                const idx = (nz * W + nx) * 3;
                pixels[idx] = color[0]; pixels[idx + 1] = color[1]; pixels[idx + 2] = color[2];
              }
            }
          }
        }
      }
    }
    if (path.children) stampPaths(pixels, path.children, color);
  }
}

function stampCorridors(pixels, corridors) {
  for (const corridor of corridors) {
    for (let i = 0; i < corridor.polyline.length - 1; i++) {
      const a = corridor.polyline[i];
      const b = corridor.polyline[i + 1];
      const dx = b.gx - a.gx, dz = b.gz - a.gz;
      const steps = Math.max(Math.abs(dx), Math.abs(dz)) || 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const gx = Math.round(a.gx + dx * t);
        const gz = Math.round(a.gz + dz * t);
        if (gx >= 0 && gx < W && gz >= 0 && gz < H) {
          const idx = (gz * W + gx) * 3;
          pixels[idx] = 255; pixels[idx + 1] = 100; pixels[idx + 2] = 50; // Orange
        }
      }
    }
  }
}

async function writePNG(data, filename) {
  const path = join(outDir, filename);
  await sharp(Buffer.from(data.pixels), { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toFile(path);
  const extra = data.minH !== undefined ? ` (elev ${data.minH.toFixed(1)} to ${data.maxH.toFixed(1)})` : '';
  console.log(`  ${filename} — ${data.label}${extra}`);
}

// === Run pipeline step by step ===
console.log('Generating...');
const rng = new SeededRandom(SEED);

// A0. Tectonics
const tectonics = generateTectonics({}, rng);
console.log(`  Tectonics: coast=${tectonics.coastEdges}, intensity=${tectonics.intensity.toFixed(2)}`);

// A0b. Corridors
const { corridors, corridorDist, corridorInfluence } = planRiverCorridors(
  { width: W, height: H, cellSize: CELL_SIZE }, tectonics, rng,
);
console.log(`  Corridors: ${corridors.length}`);

// A1. Geology
const geology = generateGeology({
  width: W, height: H, cellSize: CELL_SIZE,
  bandDirection: tectonics.bandDirection,
  bandCount: tectonics.bandCount,
  intrusionCount: tectonics.intrusionCount,
  rockBias: tectonics.rockBias,
}, rng);

// A2. Terrain
const terrain = generateTerrain(
  { width: W, height: H, cellSize: CELL_SIZE, seaLevel: SEA_LEVEL, tectonics, corridorInfluence },
  geology, rng,
);

// A4. Coastline
generateCoastline(
  { width: W, height: H, seaLevel: SEA_LEVEL },
  terrain.elevation, geology.erosionResistance, rng,
);

// === Now run hydrology step by step ===
const elevation = terrain.elevation;
const { erosionResistance, permeability } = geology;
const hydroRng = rng.fork('hydro');

// Snapshot: post-terrain
const postTerrainElev = elevation.clone();

// Step 1: Clone + meander noise
const filledElev = elevation.clone();
const hydroNoise = new PerlinNoise(hydroRng.fork('hydroMeander'));
for (let gz = 0; gz < H; gz++) {
  for (let gx = 0; gx < W; gx++) {
    const h = filledElev.get(gx, gz);
    if (h < SEA_LEVEL - 5) continue;
    const nx = gx / W, nz = gz / H;
    const micro = hydroNoise.fbm(nx * 40, nz * 40, { octaves: 2, persistence: 0.5, amplitude: 0.8 });
    filledElev.set(gx, gz, h + micro);
  }
}

// Step 2: Fill sinks
fillSinks(filledElev);

// Step 3: Flow directions + accumulation
const flowDirs = dinfFlowDirections(filledElev);
const rawAccumulation = dinfFlowAccumulation(filledElev, flowDirs);

// Geology-adjusted accumulation
const adjustedAccumulation = new Float32Array(rawAccumulation.length);
for (let gz = 0; gz < H; gz++) {
  for (let gx = 0; gx < W; gx++) {
    const idx = gz * W + gx;
    const perm = permeability.get(gx, gz);
    const permBoost = 1.0 + (1.0 - perm) * 0.6;
    adjustedAccumulation[idx] = rawAccumulation[idx] * permBoost;
  }
}

// Inject corridor entry accumulation
for (const corridor of corridors) {
  const entry = corridor.polyline[0];
  if (entry.gx >= 0 && entry.gx < W && entry.gz >= 0 && entry.gz < H) {
    const idx = entry.gz * W + entry.gx;
    adjustedAccumulation[idx] += corridor.entryAccumulation;
    let gx = entry.gx, gz = entry.gz;
    for (let step = 0; step < W * 2; step++) {
      const dir = flowDirs[gz * W + gx];
      if (dir < 0) break;
      const DX = [1, 1, 0, -1, -1, -1, 0, 1];
      const DZ = [0, 1, 1, 1, 0, -1, -1, -1];
      const nx = gx + DX[dir], nz = gz + DZ[dir];
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) break;
      adjustedAccumulation[nz * W + nx] += corridor.entryAccumulation;
      gx = nx; gz = nz;
    }
  }
}

// Step 4: Extract streams
const riverThreshold = 80, riverMajorThreshold = 800;
const thresholds = { stream: riverThreshold, river: riverThreshold * 5, majorRiver: riverMajorThreshold };
const rivers = extractStreams(adjustedAccumulation, flowDirs, filledElev, thresholds, SEA_LEVEL);
const confluences = findConfluences(adjustedAccumulation, flowDirs, filledElev, riverThreshold);

// Snapshot: pre-smoothing segments
const preSmooth = JSON.parse(JSON.stringify(rivers)); // deep copy cell coords

// Step 5: Smooth river paths
smoothRiverPaths(rivers, elevation, W, H, erosionResistance);

// Step 6: Carve floodplains (mild, on original elevation)
function carveFloodplains(elev, segs, width, height, seaLevel) {
  function processSegment(seg) {
    for (const cell of seg.cells) {
      const acc = cell.accumulation;
      if (acc < 200) continue;
      const hw = riverHalfWidth(acc);
      const riverElev = elev.get(cell.gx, cell.gz);
      if (riverElev < seaLevel) continue;
      const channelDepth = Math.min(1.2, Math.sqrt(acc) / 75 + 0.2);
      const cs = elev.cellSize || 50;
      const radiusCells = Math.ceil((hw + cs) / cs);
      for (let dz = -radiusCells; dz <= radiusCells; dz++) {
        for (let dx = -radiusCells; dx <= radiusCells; dx++) {
          const nx = cell.gx + dx, nz = cell.gz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
          const dist = Math.sqrt(dx * dx + dz * dz) * cs;
          const nd = dist / hw;
          const depthFraction = channelProfile(nd);
          if (depthFraction <= 0) continue;
          const currentElev = elev.get(nx, nz);
          if (currentElev < seaLevel) continue;
          const carve = channelDepth * depthFraction;
          if (carve > 0.05) {
            const baseElev = Math.max(riverElev, currentElev - carve);
            elev.set(nx, nz, Math.min(currentElev, baseElev));
          }
        }
      }
    }
    for (const child of (seg.children || [])) processSegment(child);
  }
  for (const root of segs) processSegment(root);
}

carveFloodplains(elevation, rivers, W, H, SEA_LEVEL);

// Step 7: Build initial waterMask (elevation < seaLevel)
const waterMask = new Grid2D(W, H, { type: 'uint8', cellSize: CELL_SIZE });
for (let gz = 0; gz < H; gz++) {
  for (let gx = 0; gx < W; gx++) {
    if (elevation.get(gx, gz) < SEA_LEVEL) waterMask.set(gx, gz, 1);
  }
}

// Snapshot: initial waterMask
const initialWaterMask = waterMask.clone();

// Step 8: Convert to vector paths
const riverPaths = segmentsToVectorPaths(rivers, CELL_SIZE, { smoothIterations: 2 });

// Step 9: Valley carving
const preValleyElev = elevation.clone();
const valleyDepthField = computeValleyDepthField(riverPaths, elevation, erosionResistance, CELL_SIZE);
const { floodplainField, floodplainTarget } = computeFloodplainField(
  riverPaths, elevation, waterMask, erosionResistance, CELL_SIZE, SEA_LEVEL,
);
applyTerrainFields(elevation, valleyDepthField, floodplainField, floodplainTarget, SEA_LEVEL);

// Step 10: Paint paths onto waterMask
paintPathsOntoWaterMask(waterMask, riverPaths, CELL_SIZE, W, H);

// === Write all PNGs ===
console.log('\nWriting PNGs...');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// 01 - Post-terrain elevation with corridor overlay
await writePNG(
  renderElevation(postTerrainElev, 'Post-terrain elevation + corridors', {
    overlay: (px) => stampCorridors(px, corridors),
  }),
  '01-terrain-with-corridors.png',
);

// 02 - Corridor influence field
await writePNG(
  renderGrid(corridorInfluence, 'Corridor influence (0=none, 1=full)', (v) => {
    if (v <= 0) return [20, 20, 20];
    const t = Math.min(1, v);
    return [Math.round(t * 255), Math.round(t * 100), 20];
  }),
  '02-corridor-influence.png',
);

// 03 - Filled elevation (after fillSinks)
await writePNG(
  renderElevation(filledElev, 'After fillSinks'),
  '03-filled-elevation.png',
);

// 04 - Flow accumulation (log-scaled)
await writePNG(
  renderGrid(
    { get: (gx, gz) => adjustedAccumulation[gz * W + gx], width: W, height: H },
    'Flow accumulation (log scale)',
    (v, gx, gz) => {
      const h = filledElev.get(gx, gz);
      if (h < SEA_LEVEL) return [20, 30, 60];
      if (v < riverThreshold) {
        const t = Math.min(1, Math.log(v + 1) / Math.log(riverThreshold));
        return [Math.round(30 + t * 30), Math.round(30 + t * 30), Math.round(30 + t * 30)];
      }
      const t = Math.min(1, Math.log(v) / Math.log(50000));
      return [20, Math.round(80 + t * 175), Math.round(200 + t * 55)];
    },
  ),
  '04-flow-accumulation.png',
);

// 05 - Extracted streams (pre-smoothing)
await writePNG(
  renderElevation(postTerrainElev, 'Extracted streams (pre-smooth)', {
    overlay: (px) => stampSegments(px, preSmooth, [255, 80, 80]),
  }),
  '05-streams-pre-smooth.png',
);

// 06 - Streams after smoothing
await writePNG(
  renderElevation(postTerrainElev, 'Streams after smoothRiverPaths', {
    overlay: (px) => stampSegments(px, rivers, [50, 100, 220]),
  }),
  '06-streams-post-smooth.png',
);

// 07 - After carveFloodplains (diff from original)
await writePNG(
  renderElevation(elevation, 'After carveFloodplains', {
    overlay: (px) => {
      // Highlight cells that changed
      for (let gz = 0; gz < H; gz++) {
        for (let gx = 0; gx < W; gx++) {
          const diff = postTerrainElev.get(gx, gz) - elevation.get(gx, gz);
          if (diff > 0.05) {
            const idx = (gz * W + gx) * 3;
            const t = Math.min(1, diff / 2);
            px[idx] = Math.round(50 + t * 205);
            px[idx + 1] = Math.round(100);
            px[idx + 2] = Math.round(220);
          }
        }
      }
    },
  }),
  '07-after-floodplain-carve.png',
);

// 08 - Initial waterMask (elevation < seaLevel)
await writePNG(
  renderElevation(elevation, 'Initial waterMask (elev < seaLevel)', {
    waterMask: initialWaterMask,
  }),
  '08-watermask-initial.png',
);

// 09 - River vector paths on elevation
await writePNG(
  renderElevation(preValleyElev, 'River vector paths', {
    overlay: (px) => stampPaths(px, riverPaths, [50, 100, 220]),
  }),
  '09-river-paths.png',
);

// 10 - Valley depth field
await writePNG(
  renderGrid(valleyDepthField, 'Valley depth field (carve amount)', (v) => {
    if (v <= 0) return [20, 20, 20];
    const t = Math.min(1, v / 15); // max 15m
    return [Math.round(t * 255), Math.round(50 + t * 50), 20];
  }),
  '10-valley-depth-field.png',
);

// 11 - After valley carving
await writePNG(
  renderElevation(elevation, 'After valley carving (applyTerrainFields)'),
  '11-after-valley-carve.png',
);

// 12 - Final waterMask (with river paths painted)
await writePNG(
  renderElevation(elevation, 'Final waterMask (with painted rivers)', {
    waterMask,
  }),
  '12-watermask-final.png',
);

// 13 - Final elevation + rivers composite
await writePNG(
  renderElevation(elevation, 'Final: elevation + waterMask + corridors', {
    waterMask,
    overlay: (px) => stampCorridors(px, corridors),
  }),
  '13-final-composite.png',
);

console.log(`\nDone → ${outDir}/`);
