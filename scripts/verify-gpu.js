/**
 * Verify GPU output matches CPU for composeAllValueLayers.
 * Uses a small synthetic grid to avoid memory pressure.
 */
import { composeAllValueLayers } from '../src/city/pipeline/valueLayers.js';
import { composeAllValueLayersGPU, destroyGPU } from '../src/city/pipeline/valueLayersGPU.js';

const W = 300, H = 300;  // 90K cells — same as 50m test city
const N = W * H;

// Synthetic layers — some Float32Array, some Grid2D-like
function makeF32(fillFn) {
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) a[i] = fillFn(i);
  return a;
}
function makeGrid(fillFn) {
  // Grid2D-like with .get(gx, gz)
  return { get: (gx, gz) => fillFn(gz * W + gx) };
}

const layers = {
  centrality:       makeF32(i => (i % 100) / 100),
  roadFrontage:     makeF32(i => Math.sin(i * 0.001) * 0.5 + 0.5),
  waterfrontness:   makeGrid(i => (i % 50) / 50),
  edgeness:         makeF32(i => 1 - (i % 100) / 100),
  developmentProx:  makeF32(i => Math.cos(i * 0.002) * 0.5 + 0.5),
  industrialProx:   makeF32(i => (i % 200) / 200),
  civicProx:        makeF32(i => ((i * 7) % 100) / 100),
  parkProx:         makeGrid(i => ((i * 13) % 100) / 100),
};

const composition = {
  commercial:        { centrality: 0.6, roadFrontage: 2.0, developmentProx: 0.5, civicProx: 0.3, industrialProx: -0.5 },
  industrial:        { edgeness: 0.5, developmentProx: 0.3 },
  civic:             { centrality: 0.7, roadFrontage: 0.3, developmentProx: 0.5 },
  openSpace:         { waterfrontness: 0.3, edgeness: 0.4, developmentProx: 0.3 },
  residentialFine:   { centrality: 0.5, roadFrontage: 0.3, developmentProx: 0.8, industrialProx: -0.8, parkProx: 0.4 },
  residentialEstate: { edgeness: 0.5, developmentProx: 0.3, industrialProx: -0.3 },
  residentialQuality:{ waterfrontness: 0.4, industrialProx: -1.0, parkProx: 0.6, developmentProx: 0.5 },
  agriculture:       { edgeness: 1.0 },
};

console.log(`Grid: ${W}×${H} = ${(N/1000).toFixed(0)}K cells`);
console.log(`Zones: ${Object.keys(composition).length}, Layers: ${Object.keys(layers).length}\n`);

const cpu = composeAllValueLayers(composition, layers, W, H);
const gpu = await composeAllValueLayersGPU(composition, layers, W, H);

let maxDiff = 0, totalDiff = 0, count = 0, mismatches = 0;
for (const zone of Object.keys(cpu)) {
  const c = cpu[zone], g = gpu[zone];
  if (!g) { console.log(`✗ MISSING zone: ${zone}`); continue; }
  if (g.length !== c.length) { console.log(`✗ Length mismatch ${zone}: cpu=${c.length} gpu=${g.length}`); continue; }
  for (let i = 0; i < c.length; i++) {
    const d = Math.abs(c[i] - g[i]);
    if (d > maxDiff) maxDiff = d;
    totalDiff += d;
    count++;
    if (d > 1e-4) mismatches++;
  }
  console.log(`  ${zone.padEnd(20)} max_diff=${Math.max(...Array.from({length: c.length}, (_,i)=>Math.abs(c[i]-g[i]))).toExponential(2)}`);
}

console.log(`\nTotal cells checked: ${count}`);
console.log(`Max diff:            ${maxDiff.toExponential(3)}`);
console.log(`Mean diff:           ${(totalDiff/count).toExponential(3)}`);
console.log(`Cells > 1e-4 diff:   ${mismatches}`);
console.log(maxDiff < 1e-4 ? '\n✓ GPU matches CPU (within floating-point tolerance)' : '\n✗ MISMATCH');

destroyGPU();
