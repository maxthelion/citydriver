#!/usr/bin/env node

/**
 * Generate schematic close-up views of the city at plot level.
 * Renders 500m x 500m areas at 2px/m showing plot outlines, roads,
 * buildings, and dimension labels.
 *
 * Usage:
 *   node scripts/debug-schematic.js [--seed 12345] [--center cx,cz] [--out dirname]
 *
 * If --center is omitted, renders views centred on:
 *   1. City centre (old town)
 *   2. A peripheral neighborhood
 *   3. A waterfront/river area (if any)
 */

import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { generateRegion } from '../src/regional/pipeline.js';
import { generateCityStepByStep } from '../src/city/pipelineDebug.js';
import { renderSchematic } from '../src/rendering/schematicRenderer.js';
import { SeededRandom } from '../src/core/rng.js';
import sharp from 'sharp';

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const seed = Number(getArg('--seed')) || Math.floor(Math.random() * 100000);
const centerArg = getArg('--center');
const outDir = getArg('--out') || `schematic-${seed}`;

console.log(`Seed: ${seed}`);
const rng = new SeededRandom(seed);

// Generate region
console.log('Generating region...');
const coastEdge = ['north', 'south', 'east', 'west'][seed % 4];
const regionalLayers = generateRegion({
  width: 256, height: 256, cellSize: 50, seaLevel: 0,
  coastEdges: [coastEdge],
}, rng.fork('region'));

const settlements = regionalLayers.getData('settlements');
if (!settlements || settlements.length === 0) {
  console.error('No settlements generated. Try a different seed.');
  process.exit(1);
}
settlements.sort((a, b) => a.tier - b.tier);
const settlement = settlements[0];
console.log(`City: tier ${settlement.tier} at (${settlement.gx}, ${settlement.gz})`);

// Generate city
console.log('Generating city...');
const radiusByTier = { 1: 40, 2: 30, 3: 20 };
const cityRadius = radiusByTier[settlement.tier] ?? 20;
const { cityLayers, roadGraph } = generateCityStepByStep(
  regionalLayers, settlement, rng.fork('city'), { cityRadius, cityCellSize: 10 },
);

const params = cityLayers.getData('params');
const cs = params.cellSize;
const plots = cityLayers.getData('plots') || [];
const buildings = cityLayers.getData('buildings') || [];
const neighborhoods = cityLayers.getData('neighborhoods') || [];

console.log(`City: ${params.width}x${params.height}, ${plots.length} plots, ${buildings.length} buildings`);

await mkdir(outDir, { recursive: true });

// Determine view centres
const views = [];

if (centerArg) {
  const [cx, cz] = centerArg.split(',').map(Number);
  views.push({ name: 'custom', cx, cz });
} else {
  // 1. City centre
  const oldTown = neighborhoods[0];
  if (oldTown) {
    views.push({ name: 'centre', cx: oldTown.x, cz: oldTown.z });
  }

  // 2. Furthest neighborhood from centre
  if (neighborhoods.length > 1) {
    let maxDist = 0;
    let furthest = neighborhoods[1];
    for (let i = 1; i < neighborhoods.length; i++) {
      const n = neighborhoods[i];
      const dx = n.x - (oldTown?.x || 0);
      const dz = n.z - (oldTown?.z || 0);
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > maxDist) { maxDist = dist; furthest = n; }
    }
    views.push({ name: `edge-${furthest.type}`, cx: furthest.x, cz: furthest.z });
  }

  // 3. Waterfront neighborhood if any
  const waterfront = neighborhoods.find(n => n.type === 'waterfront');
  if (waterfront && waterfront !== neighborhoods[0]) {
    views.push({ name: 'waterfront', cx: waterfront.x, cz: waterfront.z });
  }

  // 4. Mid-point between centre and edge (transition zone)
  if (neighborhoods.length > 2) {
    const mid = neighborhoods[Math.floor(neighborhoods.length / 2)];
    views.push({ name: `mid-${mid.type}`, cx: mid.x, cz: mid.z });
  }
}

// Render each view
for (const view of views) {
  console.log(`Rendering ${view.name} at (${Math.round(view.cx)}, ${Math.round(view.cz)})...`);

  const buf = renderSchematic({
    cx: view.cx, cz: view.cz,
    cityLayers, roadGraph, plots, buildings,
  });

  const path = join(outDir, `${view.name}.png`);
  await sharp(Buffer.from(buf.data.buffer), {
    raw: { width: buf.width, height: buf.height, channels: 4 },
  }).png().toFile(path);
  console.log(`  ${path} (${buf.width}x${buf.height})`);
}

// Symlink
const latestLink = 'schematic-latest';
try { await rm(latestLink, { force: true }); } catch {}
await symlink(outDir, latestLink);
console.log(`Done → ${outDir}/ (${latestLink} → ${outDir})`);
