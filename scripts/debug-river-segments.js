#!/usr/bin/env node

/**
 * Render river segment tree roots as color-coded bitmap.
 * Each root gets a distinct color. Major rivers are thicker.
 * Also renders the two largest rivers separately for clarity.
 *
 * Usage: node scripts/debug-river-segments.js [--seed 786031]
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

import { generateRegion } from '../src/regional/pipeline.js';
import { SeededRandom } from '../src/core/rng.js';

const args = process.argv.slice(2);
const SEED = Number(args[args.indexOf('--seed') + 1]) || 786031;
const outDir = `debug-rivers-${SEED}`;
const W = 256, H = 256, CELL_SIZE = 50;

console.log(`Seed: ${SEED}`);
const rng = new SeededRandom(SEED);
const layers = generateRegion({ width: W, height: H, cellSize: CELL_SIZE, seaLevel: 0 }, rng);

const elevation = layers.getGrid('elevation');
const rivers = layers.getData('rivers');
const riverPaths = layers.getData('riverPaths');

await mkdir(outDir, { recursive: true });

// --- Helpers ---

function makeElevationBg() {
  const pixels = new Uint8Array(W * H * 3);
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < W * H; i++) {
    if (elevation.data[i] < minH) minH = elevation.data[i];
    if (elevation.data[i] > maxH) maxH = elevation.data[i];
  }
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = (gz * W + gx) * 3;
      const h = elevation.get(gx, gz);
      if (h < 0) {
        pixels[idx] = 25; pixels[idx + 1] = 35; pixels[idx + 2] = 55;
      } else {
        const v = Math.min(220, Math.max(40, 40 + (h / maxH) * 180));
        pixels[idx] = v; pixels[idx + 1] = v; pixels[idx + 2] = v;
      }
    }
  }
  return pixels;
}

// Distinct colors for roots
const COLORS = [
  [255, 80, 80], [80, 180, 255], [80, 255, 120], [255, 200, 50],
  [200, 80, 255], [255, 130, 50], [50, 255, 220], [255, 80, 180],
  [180, 255, 80], [80, 80, 255], [255, 255, 80], [80, 255, 255],
  [255, 80, 255], [180, 130, 80], [80, 180, 130], [200, 200, 200],
];

function colorForRoot(i) {
  return COLORS[i % COLORS.length];
}

function stampSegmentCells(pixels, seg, color, thick) {
  for (const cell of seg.cells) {
    const { gx, gz } = cell;
    const r = thick ? 1 : 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
          const idx = (nz * W + nx) * 3;
          pixels[idx] = color[0]; pixels[idx + 1] = color[1]; pixels[idx + 2] = color[2];
        }
      }
    }
  }
  for (const child of (seg.children || [])) stampSegmentCells(pixels, child, color, thick);
}

function countCells(seg) {
  let n = seg.cells.length;
  for (const c of (seg.children || [])) n += countCells(c);
  return n;
}

function countSegs(seg) {
  let n = 1;
  for (const c of (seg.children || [])) n += countSegs(c);
  return n;
}

async function writePNG(pixels, filename, label) {
  const path = join(outDir, filename);
  await sharp(Buffer.from(pixels), { raw: { width: W, height: H, channels: 3 } })
    .png().toFile(path);
  console.log(`  ${filename} — ${label}`);
}

// === Image 1: All roots, color-coded ===
{
  const px = makeElevationBg();

  // Sort roots by size so small ones render on top (visible)
  const sorted = rivers.map((r, i) => ({ root: r, i })).sort((a, b) => countCells(b.root) - countCells(a.root));

  for (const { root, i } of sorted) {
    const thick = root.rank === 'majorRiver' || root.rank === 'river';
    stampSegmentCells(px, root, colorForRoot(i), thick);
  }

  await writePNG(px, '14-all-roots-colored.png',
    `All ${rivers.length} roots color-coded (${rivers.filter(r => r.rank === 'majorRiver').length} major, ${rivers.filter(r => r.rank === 'river').length} river, ${rivers.filter(r => r.rank === 'stream').length} stream)`);
}

// === Image 2: Only major rivers + rivers (no streams) ===
{
  const px = makeElevationBg();

  const significant = rivers
    .map((r, i) => ({ root: r, i }))
    .filter(({ root }) => root.rank === 'majorRiver' || root.rank === 'river');

  for (const { root, i } of significant) {
    stampSegmentCells(px, root, colorForRoot(i), true);
  }

  await writePNG(px, '15-rivers-only.png',
    `Rivers + majorRivers only (${significant.length} roots)`);
}

// === Image 3: Largest river isolated ===
{
  const px = makeElevationBg();

  const largest = rivers.reduce((best, r, i) =>
    (r.flowVolume > best.flowVolume ? { ...r, _i: i } : best),
    { flowVolume: 0 });

  stampSegmentCells(px, rivers[largest._i], [50, 150, 255], true);

  // Label with stats
  const nc = countCells(rivers[largest._i]);
  const ns = countSegs(rivers[largest._i]);
  await writePNG(px, '16-largest-river.png',
    `Largest river: root ${largest._i}, ${ns} segs, ${nc} cells, flowVol ${largest.flowVolume}`);
}

// === Image 4: Second largest river isolated ===
{
  const px = makeElevationBg();

  const sorted = [...rivers].sort((a, b) => b.flowVolume - a.flowVolume);
  const second = sorted[1];
  const idx = rivers.indexOf(second);

  stampSegmentCells(px, second, [255, 100, 50], true);

  const nc = countCells(second);
  const ns = countSegs(second);
  await writePNG(px, '17-second-river.png',
    `2nd largest river: root ${idx}, ${ns} segs, ${nc} cells, flowVol ${second.flowVolume}`);
}

// === Image 5: Disconnected single-segment roots only ===
{
  const px = makeElevationBg();

  const disconnected = rivers
    .map((r, i) => ({ root: r, i }))
    .filter(({ root }) => countSegs(root) === 1);

  for (const { root, i } of disconnected) {
    stampSegmentCells(px, root, [255, 50, 50], false);
  }

  await writePNG(px, '18-disconnected-streams.png',
    `Disconnected single-segment roots: ${disconnected.length} of ${rivers.length}`);
}

// === Image 6: riverPaths (vector paths) with width ===
{
  const px = makeElevationBg();

  function stampPath(path, color) {
    const pts = path.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.01) continue;
      const steps = Math.ceil(len / (CELL_SIZE * 0.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px_ = a.x + dx * t;
        const pz_ = a.z + dz * t;
        const hw = ((a.width * (1 - t) + b.width * t) / 2);
        const r = Math.max(0, Math.ceil(hw / CELL_SIZE));
        const cgx = Math.round(px_ / CELL_SIZE);
        const cgz = Math.round(pz_ / CELL_SIZE);
        for (let ddz = -r; ddz <= r; ddz++) {
          for (let ddx = -r; ddx <= r; ddx++) {
            const nx = cgx + ddx, nz = cgz + ddz;
            if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
              if (Math.sqrt(ddx * ddx + ddz * ddz) * CELL_SIZE <= hw) {
                const idx = (nz * W + nx) * 3;
                px[idx] = color[0]; px[idx + 1] = color[1]; px[idx + 2] = color[2];
              }
            }
          }
        }
      }
    }
    for (const child of (path.children || [])) stampPath(child, color);
  }

  for (let i = 0; i < riverPaths.length; i++) {
    stampPath(riverPaths[i], colorForRoot(i));
  }

  await writePNG(px, '19-river-paths-with-width.png',
    `All ${riverPaths.length} vector paths rendered at width`);
}

console.log('Done.');
