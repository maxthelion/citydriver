/**
 * Benchmark: composeAllValueLayers
 *
 * Sets up a production-scale city (cellSize=200 → 1200×1200 grid),
 * prepares the inputs that a real growth tick would supply, then times
 * composeAllValueLayers over N_TICKS calls (simulating a full archetype run).
 *
 * Outputs METRIC lines for the autoresearch framework.
 *
 * Usage:  node scripts/bench-value-layers.js
 */

import { generateRegion } from '../src/regional/pipeline.js';
import { setupCity } from '../src/city/setup.js';
import { buildSkeletonRoads } from '../src/city/skeleton.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { computeSpatialLayers } from '../src/city/pipeline/computeSpatialLayers.js';
import { computeInfluenceLayers } from '../src/city/pipeline/influenceLayers.js';
import { composeAllValueLayers } from '../src/city/pipeline/valueLayers.js';
import { composeAllValueLayersGPU, warmupGPU, destroyGPU, GPUValueLayersSession } from '../src/city/pipeline/valueLayersGPU.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { Grid2D } from '../src/core/Grid2D.js';

const USE_GPU     = process.argv.includes('--gpu');
const USE_SESSION = process.argv.includes('--gpu-session');

const N_TICKS = 20;
const SEEDS = [42, 100, 255];

// Suppress noisy console output from pipeline
const origLog = console.log;
const origWarn = console.warn;
console.log = (...a) => { if (!String(a[0]).startsWith('[')) origLog(...a); };
console.warn = () => {};

async function setupBenchInputs(seed) {
  const rng = new SeededRandom(seed);
  const layers = generateRegion({ width: 128, height: 128, cellSize: 200, seaLevel: 0 }, rng);
  const map = setupCity(layers, layers.getData('settlements')[0], rng.fork('city'));
  buildSkeletonRoads(map);
  extractZones(map);
  computeSpatialLayers(map);

  const arch = ARCHETYPES.marketTown;
  const resGrid = map.getLayer('reservationGrid') ??
    new Grid2D(map.width, map.height, { type: 'uint8' });

  const influenceLayers = computeInfluenceLayers(
    resGrid, map.width, map.height, arch.growth.influenceRadii, map.nuclei
  );

  const baseLayers = {};
  for (const name of ['centrality','waterfrontness','edgeness','roadFrontage','downwindness','roadGrid','landValue']) {
    if (map.hasLayer(name)) baseLayers[name] = map.getLayer(name);
  }

  return {
    composition: arch.growth.valueComposition,
    layers: { ...baseLayers, ...influenceLayers },
    w: map.width,
    h: map.height,
    cells: map.width * map.height,
  };
}

// Warm up JS engine
async function warmup(inputs) {
  if (USE_GPU) {
    await warmupGPU(inputs.composition, inputs.layers, inputs.w, inputs.h);
  } else {
    for (let i = 0; i < 3; i++) {
      composeAllValueLayers(inputs.composition, inputs.layers, inputs.w, inputs.h);
    }
  }
}

async function bench(inputs, n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    if (USE_GPU) {
      await composeAllValueLayersGPU(inputs.composition, inputs.layers, inputs.w, inputs.h);
    } else {
      composeAllValueLayers(inputs.composition, inputs.layers, inputs.w, inputs.h);
    }
    times.push(performance.now() - t0);
  }
  return times;
}

// Suppress pipeline noise while setting up
origLog('Setting up benchmark inputs...');
const allInputs = [];
for (const seed of SEEDS) {
  allInputs.push(await setupBenchInputs(seed));
}

origLog(`Grid size: ${allInputs[0].w}×${allInputs[0].h} = ${(allInputs[0].cells/1e6).toFixed(2)}M cells`);
origLog(`Zones: ${Object.keys(allInputs[0].composition).length}, Layers: ${Object.keys(allInputs[0].layers).length}`);
const modeLabel = USE_SESSION ? 'GPU session (persistent buffers + partial uploads)'
                : USE_GPU     ? 'GPU (per-call buffers)'
                              : 'CPU';
origLog(`Mode: ${modeLabel}`);
origLog(`Running ${N_TICKS} ticks × ${SEEDS.length} seeds...\n`);

// Restore console
console.log = origLog;

// Warm up on first input
await warmup(allInputs[0]);

// Benchmark each seed
const allTimes = [];
for (const inputs of allInputs) {
  let times;
  if (USE_SESSION) {
    // Create session once per seed (mirrors real usage: one session per city run)
    const session = await GPUValueLayersSession.create(
      inputs.composition, inputs.w, inputs.h
    );
    times = [];
    // First call uploads all layers; subsequent calls only upload changed ones.
    // Simulate realistic tick data: rotate influence layers to force partial re-upload
    for (let i = 0; i < N_TICKS; i++) {
      // Influence layers are new Float32Array objects each tick (they're recomputed)
      // Spatial layers keep the same reference (same objects throughout)
      const tickLayers = { ...inputs.layers };
      const influenceNames = ['developmentProximity','industrialProximity',
                              'civicProximity','parkProximity','residentialProximity'];
      for (const name of influenceNames) {
        if (tickLayers[name]) {
          // New array with slightly different values = simulates influence recompute
          tickLayers[name] = new Float32Array(tickLayers[name]);
        }
      }
      const t0 = performance.now();
      await session.compose(tickLayers, inputs.w, inputs.h);
      times.push(performance.now() - t0);
    }
    session.destroy();
  } else {
    times = await bench(inputs, N_TICKS);
  }
  allTimes.push(...times);
  const mean = times.reduce((a,b)=>a+b,0)/times.length;
  origLog(`  seed ${SEEDS[allInputs.indexOf(inputs)]}: mean ${mean.toFixed(1)}ms/tick  (${N_TICKS} ticks)`);
}

if (USE_GPU || USE_SESSION) destroyGPU();

allTimes.sort((a,b) => a-b);
const mean  = allTimes.reduce((a,b)=>a+b,0) / allTimes.length;
const p50   = allTimes[Math.floor(allTimes.length * 0.50)];
const p95   = allTimes[Math.floor(allTimes.length * 0.95)];
const total = allTimes.reduce((a,b)=>a+b,0);

origLog(`\nAggregate (${allTimes.length} calls):`);
origLog(`  mean  ${mean.toFixed(1)}ms`);
origLog(`  p50   ${p50.toFixed(1)}ms`);
origLog(`  p95   ${p95.toFixed(1)}ms`);
origLog(`  total ${total.toFixed(0)}ms  (simulated 20-tick run × ${SEEDS.length} seeds)`);

// METRIC lines for autoresearch
console.log(`METRIC mean_ms=${mean.toFixed(2)}`);
console.log(`METRIC p50_ms=${p50.toFixed(2)}`);
console.log(`METRIC p95_ms=${p95.toFixed(2)}`);
console.log(`METRIC total_ms=${total.toFixed(0)}`);
