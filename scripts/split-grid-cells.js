#!/usr/bin/env bun
/**
 * Split a rendered zone image into grid cells for focused visual review.
 *
 * Usage: bun scripts/split-grid-cells.js input.png [outDir] [rows] [cols]
 *
 * Defaults: outDir = same directory as input, rows = 2, cols = 4
 * Output: input-cell-0-0.png, input-cell-0-1.png, ... input-cell-1-3.png
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';

const inputPath = process.argv[2];
if (!inputPath || !existsSync(inputPath)) {
  console.error('Usage: bun scripts/split-grid-cells.js input.png [outDir] [rows] [cols]');
  if (inputPath) console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const outDir = process.argv[3] || dirname(inputPath);
const rows = parseInt(process.argv[4]) || 2;
const cols = parseInt(process.argv[5]) || 4;

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// Detect ImageMagick v7 (magick) vs v6 (convert/identify)
let hasMagick = false;
try { execSync('magick --version', { stdio: 'ignore' }); hasMagick = true; } catch {}
const identifyCmd = hasMagick ? 'magick identify' : 'identify';
const convertCmd = hasMagick ? 'magick' : 'convert';

// Read image dimensions via ImageMagick identify
const identifyOut = execSync(`${identifyCmd} -format "%w %h" "${inputPath}"`, { encoding: 'utf-8' }).trim();
const [imageWidth, imageHeight] = identifyOut.split(' ').map(Number);

if (!imageWidth || !imageHeight) {
  console.error(`Could not read dimensions from ${inputPath}: ${identifyOut}`);
  process.exit(1);
}

console.log(`Input: ${inputPath} (${imageWidth}x${imageHeight})`);
console.log(`Grid: ${rows} rows x ${cols} cols`);

const cellWidth = Math.floor(imageWidth / cols);
const cellHeight = Math.floor(imageHeight / rows);
console.log(`Cell size: ${cellWidth}x${cellHeight}`);

const stem = basename(inputPath, '.png');
const outputs = [];

for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    const x = col * cellWidth;
    const y = row * cellHeight;
    const outPath = join(outDir, `${stem}-cell-${row}-${col}.png`);

    execSync(
      `${convertCmd} "${inputPath}" -crop ${cellWidth}x${cellHeight}+${x}+${y} +repage "${outPath}"`,
      { encoding: 'utf-8' }
    );

    outputs.push(outPath);
    console.log(`  ${outPath} (${cellWidth}x${cellHeight}+${x}+${y})`);
  }
}

console.log(`\nDone: ${outputs.length} cells written to ${outDir}/`);
