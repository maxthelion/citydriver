#!/usr/bin/env node

/**
 * CLI tool: generate a region + city and output debug PNGs
 * showing each pipeline step.
 *
 * Usage:
 *   node scripts/debug-city.js [--seed 12345] [--out dirname]
 *
 * Creates a folder containing:
 *   grid.png          — 4x4 composite of all 16 steps
 *   01-elevation.png  — individual tile per step
 *   02-slope.png
 *   ...
 */

import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { generateRegion } from '../src/regional/pipeline.js';
import { generateCityStepByStep } from '../src/city/pipelineDebug.js';
import { renderDebugGrid, renderRegionOverview } from '../src/rendering/debugTiles.js';
import { SeededRandom } from '../src/core/rng.js';
import sharp from 'sharp';

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const seed = Number(getArg('--seed')) || Math.floor(Math.random() * 100000);
const outDir = getArg('--out') || `debug-${seed}`;

console.log(`Seed: ${seed}`);
const rng = new SeededRandom(seed);

// Generate region
console.log('Generating region...');
const coastEdge = ['north', 'south', 'east', 'west'][seed % 4];
const regionalLayers = generateRegion({
  width: 256,
  height: 256,
  cellSize: 50,
  seaLevel: 0,
  coastEdges: [coastEdge],
}, rng.fork('region'));

// Pick biggest settlement
const settlements = regionalLayers.getData('settlements');
if (!settlements || settlements.length === 0) {
  console.error('No settlements generated. Try a different seed.');
  process.exit(1);
}
settlements.sort((a, b) => a.tier - b.tier);
const settlement = settlements[0];
console.log(`City: tier ${settlement.tier} at (${settlement.gx}, ${settlement.gz})`);

// Generate city step by step
console.log('Generating city...');
const radiusByTier = { 1: 40, 2: 30, 3: 20 };
const cityRadius = radiusByTier[settlement.tier] ?? 20;
const { cityLayers, roadGraph, steps } = generateCityStepByStep(
  regionalLayers, settlement, rng.fork('city'), { cityRadius, cityCellSize: 10 },
);

const params = cityLayers.getData('params');
console.log(`City grid: ${params.width}x${params.height}, ${steps.length} steps`);

// Render
console.log('Rendering...');
const { grid, tiles } = renderDebugGrid(cityLayers, roadGraph, steps);

// Create output directory
await mkdir(outDir, { recursive: true });

// Write region overview
const region = renderRegionOverview(regionalLayers, settlement, cityRadius);
const regionPath = join(outDir, '00-region.png');
await sharp(Buffer.from(region.data.buffer), { raw: { width: region.width, height: region.height, channels: 4 } })
  .png()
  .toFile(regionPath);
console.log(`  ${regionPath} (${region.width}x${region.height})`);

// Write 4x4 grid
const gridPath = join(outDir, 'grid.png');
await sharp(Buffer.from(grid.data.buffer), { raw: { width: grid.width, height: grid.height, channels: 4 } })
  .png()
  .toFile(gridPath);
console.log(`  ${gridPath} (${grid.width}x${grid.height})`);

// Write individual tiles
for (let i = 0; i < tiles.length; i++) {
  const tile = tiles[i];
  const num = String(i + 1).padStart(2, '0');
  const slug = tile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const tilePath = join(outDir, `${num}-${slug}.png`);
  await sharp(Buffer.from(tile.data.buffer), { raw: { width: tile.width, height: tile.height, channels: 4 } })
    .png()
    .toFile(tilePath);
}
console.log(`  + ${tiles.length} individual tiles`);

// Create/update "debug-latest" symlink
const latestLink = 'debug-latest';
try { await rm(latestLink, { force: true }); } catch {}
await symlink(outDir, latestLink);
console.log(`Done → ${outDir}/ (${latestLink} → ${outDir})`);
