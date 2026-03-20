/**
 * Benchmark: GPU vs CPU value layer composition
 *
 * Sets up a production-scale city (cellSize=200 → 1200×1200 grid),
 * then times composeAllValueLayers (CPU) vs GPUValueSession.compose() (GPU)
 * over N_TICKS iterations — simulating a full archetype growth run.
 *
 * The GPU path uses the session model: static spatial layers uploaded once,
 * influence layers re-uploaded each tick (matches production usage in
 * organicGrowthPipeline).
 *
 * Usage:
 *   node scripts/bench-value-layers.js          # CPU only
 *   node scripts/bench-value-layers.js --gpu    # GPU session
 *
 * Outputs METRIC lines for the autoresearch framework.
 */

// Set up WebGPU globals for Node.js (Dawn bindings via 'webgpu' package).
// globals installs the GPU type constructors (GPUBuffer, GPUDevice, etc.).
// create([]) returns the gpu entry point that GPUDevice._init() looks for.
// Both must run before any GPUDevice.get() call.
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

const USE_GPU = process.argv.includes('--gpu');
const N_TICKS = 20;
const SEEDS   = [42, 100, 255];

// Suppress pipeline noise
const origLog  = console.log;
const origWarn = console.warn;
console.log  = (...a) => { if (!String(a[0]).startsWith('[')) origLog(...a); };
console.warn = () => {};

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setupInputs(seed) {
  const rng    = new SeededRandom(seed);
  const layers = generateRegion({ width: 128, height: 128, cellSize: 200, seaLevel: 0 }, rng);
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

  return { map, arch, influenceLayers };
}

// ── Benchmark helpers ─────────────────────────────────────────────────────────

function benchCPU(map, arch, influenceLayers, n) {
  const { width: w, height: h } = map;
  const growth    = arch.growth;
  const staticLayers = {};
  for (const name of ['centrality','waterfrontness','edgeness','roadFrontage','downwindness','roadGrid','landValue']) {
    if (map.hasLayer(name)) staticLayers[name] = map.getLayer(name);
  }
  const allLayers = { ...staticLayers, ...influenceLayers };

  // Warmup
  for (let i = 0; i < 3; i++) composeAllValueLayers(growth.valueComposition, allLayers, w, h);

  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    composeAllValueLayers(growth.valueComposition, allLayers, w, h);
    times.push(performance.now() - t0);
  }
  return times;
}

async function benchGPU(map, arch, influenceLayers, n, device) {
  const session = GPUValueSession.create(device, map, arch);
  if (!session) throw new Error('GPUValueSession.create returned null');

  session.uploadStaticLayers(map);

  // Warmup
  for (let i = 0; i < 3; i++) await session.compose(influenceLayers);

  const times = [];
  for (let i = 0; i < n; i++) {
    // Simulate each tick: influence layers are new arrays (recomputed from resGrid)
    const tickInfluence = {};
    for (const [name, arr] of Object.entries(influenceLayers)) {
      tickInfluence[name] = new Float32Array(arr); // new ref each tick = re-upload
    }
    const t0 = performance.now();
    await session.compose(tickInfluence);
    times.push(performance.now() - t0);
  }
  session.destroy();
  return times;
}

// ── Main ──────────────────────────────────────────────────────────────────────

origLog('Setting up benchmark inputs...');
const allInputs = [];
for (const seed of SEEDS) allInputs.push(await setupInputs(seed));
console.log = origLog;

const { map: sample } = allInputs[0];
origLog(`Grid: ${sample.width}×${sample.height} = ${(sample.width * sample.height / 1e6).toFixed(2)}M cells`);
origLog(`Mode: ${USE_GPU ? 'GPU (GPUValueSession)' : 'CPU'}`);
origLog(`Ticks: ${N_TICKS} × ${SEEDS.length} seeds\n`);

let device = null;
if (USE_GPU) {
  const gpu = await GPUDevice.get();
  if (!gpu.available) { origLog('WebGPU not available — aborting'); process.exit(1); }
  device = gpu.device;
  origLog(`WebGPU device acquired\n`);
}

const allTimes = [];
for (let i = 0; i < allInputs.length; i++) {
  const { map, arch, influenceLayers } = allInputs[i];
  const times = USE_GPU
    ? await benchGPU(map, arch, influenceLayers, N_TICKS, device)
    : benchCPU(map, arch, influenceLayers, N_TICKS);

  allTimes.push(...times);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  origLog(`  seed ${SEEDS[i]}: mean ${mean.toFixed(1)}ms/tick`);
}

allTimes.sort((a, b) => a - b);
const mean  = allTimes.reduce((a, b) => a + b, 0) / allTimes.length;
const p50   = allTimes[Math.floor(allTimes.length * 0.50)];
const p95   = allTimes[Math.floor(allTimes.length * 0.95)];
const total = allTimes.reduce((a, b) => a + b, 0);

origLog(`\nAggregate (${allTimes.length} calls):`);
origLog(`  mean  ${mean.toFixed(1)}ms`);
origLog(`  p50   ${p50.toFixed(1)}ms`);
origLog(`  p95   ${p95.toFixed(1)}ms`);
origLog(`  total ${total.toFixed(0)}ms  (${N_TICKS}-tick run × ${SEEDS.length} seeds)`);

console.log(`METRIC mean_ms=${mean.toFixed(2)}`);
console.log(`METRIC p50_ms=${p50.toFixed(2)}`);
console.log(`METRIC p95_ms=${p95.toFixed(2)}`);
console.log(`METRIC total_ms=${total.toFixed(0)}`);
