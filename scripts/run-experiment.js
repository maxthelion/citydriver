#!/usr/bin/env bun
/**
 * Run an experiment: execute render-pipeline.js and write a manifest
 * that the experiments viewer can read.
 *
 * Usage:
 *   bun scripts/run-experiment.js --experiment 004 \
 *     --seeds "884469:27:95,42:15:50,12345:20:60" \
 *     --ticks 28 --layers reservations,zones,commercialValue \
 *     --archetype marketTown
 *
 * Or for custom render scripts:
 *   bun scripts/run-experiment.js --experiment 004 --script render-zone-roads.js \
 *     --seeds "884469:27:95"
 *
 * Writes:
 *   experiments/NNN-output/manifest.json
 *   experiments/NNN-output/*.png
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
};

const experiment = getArg('experiment', null);
if (!experiment) {
  console.error('Usage: bun scripts/run-experiment.js --experiment NNN [--seeds ...] [--ticks N] [--layers ...] [--archetype ...]');
  console.error('       bun scripts/run-experiment.js --experiment NNN --script render-zone-roads.js [--seeds ...]');
  process.exit(1);
}

const num = experiment.padStart(3, '0');
const outDir = `experiments/${num}-output`;
const seedsStr = getArg('seeds', '884469:27:95,42:15:50,12345:20:60');
const seeds = seedsStr.split(',').map(s => {
  const [seed, gx, gz] = s.split(':');
  return { seed, gx: gx || '27', gz: gz || '95' };
});
const ticks = getArg('ticks', '28');
const layersStr = getArg('layers', 'reservations');
const archetype = getArg('archetype', 'marketTown');
const customScript = getArg('script', null);

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Experiment ${num}`);
console.log(`Output: ${outDir}/`);
console.log(`Seeds: ${seeds.map(s => s.seed).join(', ')}`);
if (customScript) {
  console.log(`Script: ${customScript}`);
} else {
  console.log(`Layers: ${layersStr}`);
  console.log(`Ticks: ${ticks}, Archetype: ${archetype}`);
}
console.log('');

// Run renders
const totalStart = performance.now();
for (const { seed, gx, gz } of seeds) {
  console.log(`--- seed ${seed} ---`);
  const seedStart = performance.now();
  if (customScript) {
    const cmd = `bun scripts/${customScript} ${seed} ${gx} ${gz} ${outDir}`;
    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 300000 });
      console.log(output);
    } catch (e) {
      console.error(`Failed: ${e.message}`);
    }
  } else {
    const cmd = `bun scripts/render-pipeline.js --seed ${seed} --gx ${gx} --gz ${gz} --ticks ${ticks} --layers ${layersStr} --archetype ${archetype} --out ${outDir}`;
    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 300000 });
      console.log(output);
    } catch (e) {
      console.error(`Failed: ${e.message}`);
    }
  }
  console.log(`  seed ${seed}: ${((performance.now() - seedStart) / 1000).toFixed(1)}s\n`);
}
console.log(`Total: ${((performance.now() - totalStart) / 1000).toFixed(1)}s\n`);

// Scan output directory for PNGs and build manifest
const files = readdirSync(outDir).filter(f => f.endsWith('.png'));
const images = files.map(f => {
  // Parse filename: layer-seedNNN-tickNNN.png or layer-seedNNN.png
  const match = f.match(/^(.+)-seed(\d+)(?:-tick(\d+))?\.png$/);
  if (match) {
    return {
      file: f,
      path: `${num}-output/${f}`,
      layer: match[1],
      seed: match[2],
      tick: match[3] || null,
    };
  }
  return { file: f, path: `${num}-output/${f}`, layer: f.replace('.png', ''), seed: null, tick: null };
});

const manifest = {
  experiment: num,
  generated: new Date().toISOString(),
  seeds: seeds.map(s => s.seed),
  layers: customScript ? null : layersStr.split(','),
  archetype: customScript ? null : archetype,
  ticks: customScript ? null : parseInt(ticks),
  script: customScript || 'render-pipeline.js',
  images,
};

writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\nManifest written: ${outDir}/manifest.json (${images.length} images)`);

// Update root experiments/manifest.json
const rootManifestPath = 'experiments/manifest.json';
let rootManifest = [];
try {
  rootManifest = JSON.parse(require('fs').readFileSync(rootManifestPath, 'utf-8'));
} catch (e) {}

// Find or create entry for this experiment
const mdFile = readdirSync('experiments').find(f => f.startsWith(`${num}-`) && f.endsWith('.md'));
const existingIdx = rootManifest.findIndex(e => e.num === num);
const entry = {
  num,
  slug: mdFile ? mdFile.replace(`${num}-`, '').replace('.md', '') : 'unknown',
  md: mdFile || null,
  images: images.map(img => ({ path: img.path, layer: img.layer, seed: img.seed, tick: img.tick })),
};

if (existingIdx >= 0) {
  rootManifest[existingIdx] = entry;
} else {
  rootManifest.push(entry);
  rootManifest.sort((a, b) => a.num.localeCompare(b.num));
}

writeFileSync(rootManifestPath, JSON.stringify(rootManifest, null, 2));
console.log(`Root manifest updated: ${rootManifest.length} experiments`);
