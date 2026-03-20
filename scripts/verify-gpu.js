/**
 * Verify GPU output matches CPU for value layer composition.
 *
 * Builds a real city map (small grid), runs up to spatial layers, then
 * compares composeAllValueLayers (CPU) against GPUValueSession.compose (GPU)
 * cell-by-cell.  Any cell differing by > 1e-4 is a failure.
 *
 * Usage:  node scripts/verify-gpu.js
 */

// Set up WebGPU globals for Node.js (Dawn bindings via 'webgpu' package).
// globals installs type constructors; create([]) provides the gpu entry point.
import { create, globals } from 'webgpu';
Object.assign(globalThis, globals);
globalThis.gpu = create([]);

import { generateRegion } from '../src/regional/pipeline.js';
import { setupCity } from '../src/city/setup.js';
import { buildSkeletonRoads } from '../src/city/pipeline/buildSkeletonRoads.js';
import { computeLandValue } from '../src/city/pipeline/computeLandValue.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { computeSpatialLayers } from '../src/city/pipeline/computeSpatialLayers.js';
import { computeInfluenceLayers } from '../src/city/pipeline/influenceLayers.js';
import { composeAllValueLayers } from '../src/city/pipeline/valueLayers.js';
import { GPUValueSession } from '../src/city/pipeline/valueLayersGPU.js';
import { GPUDevice } from '../src/core/gpu/GPUDevice.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { Grid2D } from '../src/core/Grid2D.js';

// Suppress pipeline noise
const log = console.log;
console.log = (...a) => { if (!String(a[0]).startsWith('[')) log(...a); };
console.warn = () => {};

// ── Set up a real city (small, 50m cells) ────────────────────────────────────

const SEED = 42;
const rng    = new SeededRandom(SEED);
// Use a 64×64 regional grid at 200m cellSize → city ~300×300 at 5m
const layers = generateRegion({ width: 64, height: 64, cellSize: 200, seaLevel: 0 }, rng);
const map    = setupCity(layers, layers.getData('settlements')[0], rng.fork('city'));

buildSkeletonRoads(map);
computeLandValue(map);
extractZones(map);
computeSpatialLayers(map);

const arch    = ARCHETYPES.marketTown;
const resGrid = map.hasLayer('reservationGrid')
  ? map.getLayer('reservationGrid')
  : new Grid2D(map.width, map.height, { type: 'uint8' });

const influenceLayers = computeInfluenceLayers(
  resGrid, map.width, map.height,
  arch.growth.influenceRadii,
  map.nuclei,
);

// CPU: compose using all layers merged
const staticLayers = {};
for (const name of ['centrality','waterfrontness','edgeness','roadFrontage','downwindness','roadGrid','landValue']) {
  if (map.hasLayer(name)) staticLayers[name] = map.getLayer(name);
}
const allLayers = { ...staticLayers, ...influenceLayers };

console.log = log;
log(`Grid: ${map.width}×${map.height} = ${(map.width * map.height / 1000).toFixed(0)}K cells`);
log(`Zones: ${Object.keys(arch.growth.valueComposition).length}`);
log(`Static layers: ${Object.keys(staticLayers).join(', ')}`);
log(`Influence layers: ${Object.keys(influenceLayers).join(', ')}\n`);

// ── CPU reference ─────────────────────────────────────────────────────────────

const cpu = composeAllValueLayers(arch.growth.valueComposition, allLayers, map.width, map.height);

// ── GPU ───────────────────────────────────────────────────────────────────────

const gpuInfo = await GPUDevice.get();
if (!gpuInfo.available) {
  log('WebGPU not available — cannot verify');
  process.exit(1);
}

const session = GPUValueSession.create(gpuInfo.device, map, arch);
if (!session) { log('GPUValueSession.create returned null'); process.exit(1); }

session.uploadStaticLayers(map);
const gpu = await session.compose(influenceLayers);
session.destroy();

// ── Compare ───────────────────────────────────────────────────────────────────

const EPSILON = 1e-4;
let totalCells = 0, totalMismatches = 0, overallMaxDiff = 0;
let allPass = true;

for (const zone of Object.keys(cpu)) {
  const c = cpu[zone];
  const g = gpu[zone];

  if (!g) {
    log(`  ✗ MISSING zone: ${zone}`);
    allPass = false;
    continue;
  }
  if (g.length !== c.length) {
    log(`  ✗ Length mismatch ${zone}: cpu=${c.length} gpu=${g.length}`);
    allPass = false;
    continue;
  }

  let maxDiff = 0, mismatches = 0;
  for (let i = 0; i < c.length; i++) {
    const d = Math.abs(c[i] - g[i]);
    if (d > maxDiff) maxDiff = d;
    if (d > EPSILON) mismatches++;
  }

  totalCells      += c.length;
  totalMismatches += mismatches;
  if (maxDiff > overallMaxDiff) overallMaxDiff = maxDiff;

  const pass = mismatches === 0;
  if (!pass) allPass = false;
  log(`  ${pass ? '✓' : '✗'} ${zone.padEnd(22)} max_diff=${maxDiff.toExponential(2)}  mismatches=${mismatches}`);
}

log('');
log(`Total cells checked : ${totalCells.toLocaleString()}`);
log(`Overall max diff    : ${overallMaxDiff.toExponential(3)}`);
log(`Cells > ${EPSILON}   : ${totalMismatches}`);
log('');
log(allPass
  ? '✓ GPU matches CPU (all zones within floating-point tolerance)'
  : '✗ MISMATCH — GPU and CPU results differ');

process.exit(allPass ? 0 : 1);
