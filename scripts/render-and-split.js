#!/usr/bin/env bun
/**
 * Render a zone and split into grid cells for evaluation.
 *
 * Usage: bun scripts/render-and-split.js --script render-k3-survey.js --seed 884469 --gx 27 --gz 95 --out experiments/test-cells
 *
 * Runs the render script, finds all output PNGs, splits each into 2x4 grid cells.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync } from 'fs';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
};

const script = getArg('script', null);
const seed = getArg('seed', '884469');
const gx = getArg('gx', '27');
const gz = getArg('gz', '95');
const outDir = getArg('out', 'experiments/grid-cells-output');
const rows = parseInt(getArg('rows', '2'));
const cols = parseInt(getArg('cols', '4'));

if (!script) {
  console.error('Usage: bun scripts/render-and-split.js --script <render-script.js> --seed <seed> --gx <gx> --gz <gz> --out <outDir>');
  process.exit(1);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// Record existing PNGs so we can detect new ones
const existingPngs = new Set(
  existsSync(outDir) ? readdirSync(outDir).filter(f => f.endsWith('.png')) : []
);

// Run the render script
console.log(`Running: bun scripts/${script} ${seed} ${gx} ${gz} ${outDir}`);
const t0 = performance.now();
try {
  const output = execSync(`bun scripts/${script} ${seed} ${gx} ${gz} ${outDir}`, {
    encoding: 'utf-8',
    timeout: 300000,
    cwd: process.cwd(),
  });
  console.log(output);
} catch (e) {
  console.error(`Render failed: ${e.message}`);
  if (e.stdout) console.log(e.stdout);
  if (e.stderr) console.error(e.stderr);
  process.exit(1);
}
const renderTime = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`Render completed in ${renderTime}s`);

// Find all PNGs in outDir (both new and pre-existing, excluding already-split cells)
const allPngs = readdirSync(outDir)
  .filter(f => f.endsWith('.png') && !f.match(/-cell-\d+-\d+\.png$/));

if (allPngs.length === 0) {
  console.error(`No PNGs found in ${outDir} after render`);
  process.exit(1);
}

console.log(`\nSplitting ${allPngs.length} PNG(s) into ${rows}x${cols} grid cells...\n`);

let totalCells = 0;
for (const png of allPngs) {
  const pngPath = `${outDir}/${png}`;
  console.log(`--- ${png} ---`);
  try {
    const output = execSync(
      `bun scripts/split-grid-cells.js "${pngPath}" "${outDir}" ${rows} ${cols}`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    console.log(output);
    totalCells += rows * cols;
  } catch (e) {
    console.error(`  Split failed for ${png}: ${e.message}`);
  }
}

console.log(`\nDone: ${totalCells} grid cells from ${allPngs.length} image(s) in ${outDir}/`);
