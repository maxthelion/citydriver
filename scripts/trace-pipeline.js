#!/usr/bin/env bun
/**
 * Run a city pipeline and capture bitmap snapshots at each step.
 *
 * Usage:
 *   bun scripts/trace-pipeline.js [seed] [gx] [gz] [archetype]
 *
 * Output goes to output/traces/seed-{seed}-{archetype}/
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { BitmapLogger } from '../src/core/bitmapLogger.js';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const archetypeName = process.argv[5] || 'marketTown';

const archetype = ARCHETYPES[archetypeName];
if (!archetype) {
  console.error(`Unknown archetype: ${archetypeName}. Available: ${Object.keys(ARCHETYPES).join(', ')}`);
  process.exit(1);
}

console.log(`Tracing: seed=${seed} gx=${gx} gz=${gz} archetype=${archetypeName}`);

const traceDir = `output/traces/seed-${seed}-${archetypeName}`;
const logger = new BitmapLogger(traceDir);

// Generate region
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) {
  console.error('No settlement found');
  process.exit(1);
}

// Setup city
const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));

// Log initial state
// Helper: get a layer from either the layers Map or direct property
function getGrid(map, name) {
  if (map.hasLayer(name)) return map.getLayer(name);
  if (map[name] && map[name].get) return map[name];
  return null;
}

const logGrid = (step, name, palette, desc) => {
  const grid = getGrid(map, name);
  if (grid) logger.log(step, name, grid, palette, desc);
};

logGrid('000-setup', 'elevation', 'terrain', 'Terrain after setup');
logGrid('000-setup', 'slope', 'heat', 'Slope gradient');
logGrid('000-setup', 'waterMask', 'mask', 'Water mask');
logGrid('000-setup', 'buildability', 'heat', 'Initial buildability');

// Run pipeline with logging at each tick
const strategy = new LandFirstDevelopment(map, { archetype });

const TICK_NAMES = [
  '', 'skeleton', 'land-value', 'zones', 'spatial-layers',
];

// Layers to capture at each tick
const STANDARD_LAYERS = [
  ['roadGrid', 'mask'],
  ['landValue', 'heat'],
  ['buildability', 'heat'],
];

const SPATIAL_LAYERS = [
  ['centrality', 'heat'],
  ['waterfrontness', 'heat'],
  ['edgeness', 'heat'],
  ['roadFrontage', 'heat'],
  ['downwindness', 'heat'],
];

const ZONE_LAYERS = [
  ['zoneGrid', 'zone'],
];

const RESERVATION_LAYERS = [
  ['reservationGrid', 'reservation'],
];

let tick = 0;
while (tick < 50) {
  const t0 = performance.now();
  const more = strategy.tick();
  tick++;
  const elapsed = (performance.now() - t0).toFixed(0);

  const tickName = TICK_NAMES[tick] || `tick-${tick}`;
  const step = `${String(tick).padStart(3, '0')}-${tickName}`;

  console.log(`  ${step}: ${elapsed}ms${more ? '' : ' (done)'}`);

  // Log relevant layers based on which tick just ran
  if (tick === 1) {
    logGrid(step, 'roadGrid', 'mask', 'Skeleton roads');
  } else if (tick === 2) {
    logGrid(step, 'landValue', 'heat', 'Land value (nucleus-aware)');
  } else if (tick === 3) {
    logGrid(step, 'zoneGrid', 'zone', 'Development zones');
  } else if (tick === 4) {
    for (const [name, palette] of SPATIAL_LAYERS) {
      logGrid(step, name, palette, `Spatial: ${name}`);
    }
  } else if (tick >= 5) {
    logGrid(step, 'reservationGrid', 'reservation', `Reservations after ${tickName}`);
  }

  if (!more) break;
}

// Final summary layers
logGrid('final', 'roadGrid', 'mask', 'Final road grid');
logGrid('final', 'reservationGrid', 'reservation', 'Final reservations');

logger.writeIndex();
console.log(`\nTrace complete: ${traceDir}/`);
