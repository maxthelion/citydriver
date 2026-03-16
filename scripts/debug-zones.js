#!/usr/bin/env bun
import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';

const seed = 884469, gx = 27, gz = 95;
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });

// Run through tick 4 (spatial layers)
for (let i = 0; i < 4; i++) strategy.tick();

const zoneGrid = map.getLayer('zoneGrid');
const w = map.width, h = map.height;

let zoneCells = 0;
for (let z = 0; z < h; z++)
  for (let x = 0; x < w; x++)
    if (zoneGrid && zoneGrid.get(x, z) > 0) zoneCells++;

console.log(`Grid: ${w}×${h} = ${w*h} cells`);
console.log(`Zone cells: ${zoneCells} (${(zoneCells / (w*h) * 100).toFixed(1)}%)`);
console.log(`Nuclei: ${map.nuclei.length}`);
for (const n of map.nuclei) {
  console.log(`  nucleus ${n.type} at (${n.gx}, ${n.gz})`);
}
console.log(`Development zones: ${map.developmentZones?.length || 0}`);
if (map.developmentZones) {
  for (const z of map.developmentZones) {
    console.log(`  zone ${z.nucleusIdx}: ${z.cells.length} cells`);
  }
}
