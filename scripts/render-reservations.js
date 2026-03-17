#!/usr/bin/env bun
/**
 * Run city generation to a target tick and save the reservation grid as a PPM image.
 * Usage: bun scripts/render-reservations.js [seed] [gx] [gz] [ticks]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const maxTicks = parseInt(process.argv[5]) || 50;

console.log(`Generating: seed=${seed} gx=${gx} gz=${gz} ticks=${maxTicks}`);

// Generate region
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) {
  console.error('No settlement found at those coordinates');
  process.exit(1);
}

// Setup city
const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const archetype = ARCHETYPES.marketTown;
const strategy = new LandFirstDevelopment(map, { archetype });

// Run ticks
let tick = 0;
while (tick < maxTicks) {
  const t0 = performance.now();
  const more = strategy.tick();
  tick++;
  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(`  tick ${tick}: ${elapsed}ms${more ? '' : ' (done)'}`);
  if (!more) break;
}

console.log(`Completed ${tick} ticks`);

// Read reservation grid
const resGrid = map.getLayer('reservationGrid');
if (!resGrid) {
  console.error('No reservationGrid found');
  process.exit(1);
}

const w = map.width;
const h = map.height;

// Reservation type → RGB colour
const colors = {
  0: [26, 26, 46],          // none — dark background
  1: [255, 165, 0],         // commercial — orange
  2: [128, 128, 128],       // industrial — gray
  3: [0, 100, 255],         // civic — blue
  4: [0, 200, 0],           // open space — green
  5: [120, 90, 30],         // agriculture — dark brown
  6: [230, 200, 120],       // residential fine — warm yellow
  7: [200, 60, 60],         // residential estate — red
  8: [180, 120, 220],       // residential quality — light purple
  9: [0, 180, 180],         // port — teal
};

// Write PPM image
const header = `P6\n${w} ${h}\n255\n`;
const pixels = new Uint8Array(w * h * 3);

for (let gz = 0; gz < h; gz++) {
  for (let gx = 0; gx < w; gx++) {
    const v = resGrid.get(gx, gz);
    const [r, g, b] = colors[v] || colors[0];
    const idx = (gz * w + gx) * 3;
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
  }
}

const outPath = `output/reservations-seed${seed}-tick${tick}.ppm`;
await Bun.write(outPath, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
console.log(`Written to ${outPath} (${w}×${h})`);

// Also print stats
const counts = {};
for (let gz = 0; gz < h; gz++) {
  for (let gx = 0; gx < w; gx++) {
    const v = resGrid.get(gx, gz);
    counts[v] = (counts[v] || 0) + 1;
  }
}
const names = ['none', 'commercial', 'industrial', 'civic', 'openSpace', 'agriculture', 'resFine', 'resEstate', 'resQuality'];
console.log('\nReservation counts:');
for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  const pct = (count / (w * h) * 100).toFixed(1);
  console.log(`  ${names[type] || type}: ${count} (${pct}%)`);
}
