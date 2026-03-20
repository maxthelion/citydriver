# Stage 4: GPU Bitmap Operations — Implementation Plan

## Status: Next up (March 2026)

## Context

The macro plan has four stages. Stages 1–3 are complete:

1. Road network refactor ✅
2. Pipeline refactor ✅ (PipelineRunner, named steps, hooks)
3. Benchmarking + invariant checking ✅ (`benchmark-pipeline.js`, bitmap/polyline/block invariants as hooks)

Stage 4 is GPU bitmap operations. The benchmark identified the targets. The invariant checks
provide the CPU reference for correctness verification.

### What the benchmark says

From `output/pipeline-perf.json` (43 cities, 5 seeds, marketTown archetype):

| Target | Current CPU | % of total | GPU fit |
|--------|-------------|------------|---------|
| `growth:value` — `composeAllValueLayers` | 258ms total (26ms/tick) | 22% | Excellent — pure per-cell multiply-add |
| `growth:influence` — `computeInfluenceLayers` | 77ms total | 6% | Good — separable BFS/blur |
| Bitmap invariant checks | ~15ms/check × 100 checkpoints | overhead | Excellent — atomic reduction |

The invariant checks have two roles:
1. **Correctness harness** during GPU development — diff CPU vs GPU output per-cell
2. **Fast runtime checks** — GPU makes them cheap enough to leave permanently wired at every pipeline sub-step

### Existing GPU work to recover

Two shaders were developed and validated during the autoresearch session (March 2026) but
are not in the current codebase (they predate the pipeline refactor):

- `composeAllValueLayers` — GPU shader at commit `86ffc62` (11.7× speedup, 48ms GPU vs 571ms CPU)
  Later improved to 13ms with persistent buffers at commit `ec17b3c`.
- `computeInfluenceLayers` — GPU shader at commit `c24147c` (2.5× speedup: 40ms vs 100ms)

Both were written against the old `growthTick.js` monolith. They need porting to the new
extracted phase functions (`runValuePhase`, `runInfluencePhase` in `growthTick.js`) and the
new `Grid2D`-based layer bag.

The key lesson from the autoresearch session: **static layers uploaded once per session, only
dynamic layers re-uploaded per tick**. The value shader needs spatial layers (centrality,
waterfrontness, etc.) uploaded at session start; only the influence layers change each tick.

---

## Three Steps

### Step 1: GPU infrastructure + bitmap invariant checker

**Why first:** The invariant checker is the simplest possible shader (one atomic add per cell pair),
which makes it the right place to validate the GPU plumbing before writing the more complex
value/influence shaders. It also makes the invariant hooks free enough to permanently attach
to every pipeline sub-step.

**What to build:**

```
src/core/gpu/
  GPUDevice.js        — singleton adapter+device, lazy init, CPU fallback flag
  GPUBuffer.js        — typed array ↔ GPUBuffer, upload/download, pooling

src/city/invariants/
  bitmapInvariantsGPU.js   — GPU implementation of checkAllBitmapInvariants
```

**`GPUDevice.js`** — initialised once on first use:
```js
export class GPUDevice {
  static _instance = null;
  static async get() {
    if (!this._instance) this._instance = await this._init();
    return this._instance;
  }
  static async _init() {
    if (!navigator?.gpu && !globalThis?.gpu) return { available: false };
    const adapter = await (navigator.gpu ?? globalThis.gpu).requestAdapter();
    if (!adapter) return { available: false };
    const device = await adapter.requestDevice();
    return { available: true, device };
  }
}
```

**`bitmapInvariantsGPU.js`** — one dispatch per invariant pair, atomic counter output:
```wgsl
@group(0) @binding(0) var<storage, read> layerA: array<u32>;
@group(0) @binding(1) var<storage, read> layerB: array<u32>;
@group(0) @binding(2) var<storage, read_write> violations: atomic<u32>;

@compute @workgroup_size(256)
fn checkOverlap(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&layerA)) { return; }
  if (layerA[i] > 0u && layerB[i] > 0u) {
    atomicAdd(&violations, 1u);
  }
}
```

Run all five bitmap invariant checks in one combined shader (one pass, multiple atomic
counters):
```wgsl
@group(0) @binding(0) var<storage, read> waterMask:  array<u32>;
@group(0) @binding(1) var<storage, read> roadGrid:   array<u32>;
@group(0) @binding(2) var<storage, read> railGrid:   array<u32>;
@group(0) @binding(3) var<storage, read> bridgeGrid: array<u32>;
@group(0) @binding(4) var<storage, read> zoneGrid:   array<u32>;
@group(0) @binding(5) var<storage, read> resGrid:    array<u32>;

struct Counts { noRoadOnWater: atomic<u32>, noRailOnWater: atomic<u32>,
                noZoneOnWater: atomic<u32>, noResOutsideZone: atomic<u32>,
                bridgesOnlyOnWater: atomic<u32> }
@group(0) @binding(6) var<storage, read_write> counts: Counts;

@compute @workgroup_size(256)
fn checkAll(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&waterMask)) { return; }
  let isWater  = waterMask[i] > 0u;
  let isRoad   = roadGrid[i]  > 0u;
  let isRail   = railGrid[i]  > 0u;
  let isBridge = bridgeGrid[i] > 0u;
  let inZone   = zoneGrid[i]  > 0u;
  let isRes    = resGrid[i]   > 0u;

  if (isWater && isRoad   && !isBridge) { atomicAdd(&counts.noRoadOnWater,     1u); }
  if (isWater && isRail)                { atomicAdd(&counts.noRailOnWater,     1u); }
  if (isWater && inZone)                { atomicAdd(&counts.noZoneOnWater,     1u); }
  if (isRes   && !inZone)              { atomicAdd(&counts.noResOutsideZone,   1u); }
  if (isBridge && !isWater)            { atomicAdd(&counts.bridgesOnlyOnWater, 1u); }
}
```

**Interface:** `bitmapInvariants.js` dispatches to GPU or CPU transparently:
```js
export async function checkAllBitmapInvariants(map) {
  const gpu = await GPUDevice.get();
  if (gpu.available) return checkAllBitmapInvariantsGPU(map, gpu.device);
  return checkAllBitmapInvariantsCPU(map);  // existing implementation
}
```

The hook in the integration test and the pipeline runner don't change — they call
`checkAllBitmapInvariants(map)` and get the same result regardless of path.

**Correctness test:** For each of the 3 seeds in the integration test, run both CPU and GPU
implementations and assert counts match exactly.

**Files:**
- New: `src/core/gpu/GPUDevice.js`
- New: `src/core/gpu/GPUBuffer.js`
- New: `src/city/invariants/bitmapInvariantsGPU.js`
- Modify: `src/city/invariants/bitmapInvariants.js` (dispatch + export CPU impl separately)

---

### Step 2: GPU value layer composition

**Target:** `runValuePhase` in `growthTick.js`. Currently calls `composeAllValueLayers`
which iterates all 1.44M cells per agent type per tick.

**Existing work:** Shader at commit `86ffc62`, improved session at `ec17b3c`.
Port to new architecture; key changes from old version:
- Layer bag is now `map.getLayer(name)` not `map[name]`
- Phase function signature: `runValuePhase(map, archetype, influenceLayers)` returns `{ valueLayers }`
- Spatial layers (centrality, waterfrontness, etc.) don't change between growth ticks — upload once

**Session design:**
```
src/city/pipeline/
  valueLayersGPU.js   — GPUValueSession class
```

```js
export class GPUValueSession {
  constructor(device) { this._device = device; this._pipeline = null; }

  // Call once after spatial layers are computed (before first growth tick)
  uploadStaticLayers(map) { /* upload centrality, waterfrontness, edgeness, roadFrontage, downwindness, landValue */ }

  // Call each tick with current influence layers
  async compose(influenceLayers, valueComposition, w, h) {
    // Upload influence layers (change each tick)
    // Dispatch compute shader
    // Read back per-agent value bitmaps
    // Return { commercial, residential, ... } Float32Array per agent
  }

  destroy() { /* release GPU buffers */ }
}
```

**Shader:** One dispatch per agent type, or one dispatch for all agents with agent index as a uniform. The latter is better (fewer dispatches):

```wgsl
struct Weights {
  centrality: f32, waterfrontness: f32, edgeness: f32, roadFrontage: f32,
  downwindness: f32, developmentProximity: f32, industrialProximity: f32,
  civicProximity: f32, parkProximity: f32, residentialProximity: f32,
}

@group(0) @binding(0) var<uniform> weights: Weights;
@group(0) @binding(1) var<storage, read>  centrality:   array<f32>;
@group(0) @binding(2) var<storage, read>  waterfrontness: array<f32>;
// ... other static layers ...
@group(0) @binding(7) var<storage, read>  devProximity: array<f32>;
// ... other influence layers ...
@group(0) @binding(12) var<storage, read_write> valueOut: array<f32>;

@compute @workgroup_size(256)
fn composeValue(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&valueOut)) { return; }
  var v = 0.0;
  v += weights.centrality          * centrality[i];
  v += weights.waterfrontness      * waterfrontness[i];
  v += weights.edgeness            * edgeness[i];
  v += weights.roadFrontage        * roadFrontage[i];
  v += weights.downwindness        * downwindness[i];
  v += weights.developmentProximity * devProximity[i];
  // etc. — negative weights for repulsion (industrialProximity can be negative)
  valueOut[i] = max(0.0, v);
}
```

**Wiring into pipeline:**
```js
// In cityPipeline.js organicGrowthPipeline — create session once before growth loop
const gpuValue = await GPUValueSession.create(map);  // null if GPU unavailable

yield step('spatial', () => computeSpatialLayers(map));

if (gpuValue) gpuValue.uploadStaticLayers(map);

while (state.tick < maxTicks) {
  state.tick++;
  const t = state.tick;

  let influenceResult, valueResult, allocResult;

  yield step(`growth-${t}:influence`, () => {
    influenceResult = runInfluencePhase(map, archetype);
  });

  yield step(`growth-${t}:value`, async () => {
    valueResult = gpuValue
      ? await runValuePhaseGPU(gpuValue, map, archetype, influenceResult.influenceLayers)
      : runValuePhase(map, archetype, influenceResult.influenceLayers);
  });
  // ... rest of tick
}
if (gpuValue) gpuValue.destroy();
```

**Note on async:** `PipelineRunner.advance()` is currently synchronous. The GPU path needs
`await`. Options:
- Make `advance()` return a Promise when the step fn is async (check `result instanceof Promise`)
- Or: make the GPU upload/download synchronous using `device.queue.onSubmittedWorkDone()` +
  a polling approach (complex)
- **Recommended:** make `advance()` async-aware — return a Promise that resolves after the
  step. `LandFirstDevelopment.tick()` becomes `async tick()`. This is a small change but
  propagates to callers.

**Correctness test:** For each seed, run one full growth tick CPU and GPU side by side.
Assert all per-agent value bitmaps match within float tolerance (epsilon 1e-5).

**Files:**
- New: `src/city/pipeline/valueLayersGPU.js`
- Modify: `src/city/pipeline/valueLayers.js` (export `composeAllValueLayersCPU`)
- Modify: `src/city/pipeline/growthTick.js` (use GPU session in `runValuePhase`)
- Modify: `src/city/pipeline/cityPipeline.js` (create/destroy GPU session around growth loop)
- Modify: `src/city/pipeline/PipelineRunner.js` (make `advance()` async-aware)
- Modify: `src/city/strategies/landFirstDevelopment.js` (`tick()` → `async tick()`)

---

### Step 3: GPU influence layer computation

**Target:** `runInfluencePhase` in `growthTick.js`. Calls `computeInfluenceLayers` — a
BFS-based blur of the reservation grid into proximity fields (one per influence type).

**Existing work:** Shader at commit `c24147c` (40ms GPU vs 100ms CPU). The autoresearch
session found that re-uploading the reservation grid each tick dominated cost; with
persistent buffers and partial uploads (only changed cells) it reached 13ms.

**Session design:**
```
src/city/pipeline/
  influenceLayersGPU.js   — GPUInfluenceSession class
```

The influence computation is more complex than value — it's a convolution/blur with radius
that varies per influence type. The existing CPU implementation uses a BFS wavefront. The GPU
version uses a separable box blur approximation (multiple passes of a narrow 1D kernel to
approximate Gaussian falloff).

**Key pattern from autoresearch:** Upload the reservation grid as a diff each tick (only
cells that changed since last tick), not the whole grid. The reservation grid changes slowly
in later ticks.

**Wiring:** Same pattern as value — session created once, used each tick in `runInfluencePhase`.

**Correctness test:** For each seed, run 3 growth ticks, assert influence layer Float32Array
values match CPU within epsilon 1e-4 (the blur approximation is slightly different from BFS
so tolerance needs to be looser than value).

**Files:**
- New: `src/city/pipeline/influenceLayersGPU.js`
- Modify: `src/city/pipeline/influenceLayers.js` (export CPU impl separately)
- Modify: `src/city/pipeline/growthTick.js` (use GPU session in `runInfluencePhase`)

---

## Testing approach

### During development: CPU/GPU diff

For each shader, before wiring into the pipeline, run a standalone comparison:

```js
// scripts/verify-gpu-value.js
const cpuResult = composeAllValueLayersCPU(composition, layers, w, h);
const gpuResult = await composeAllValueLayersGPU(session, composition, layers, w, h);

let maxDiff = 0, diffCells = 0;
for (let i = 0; i < w * h; i++) {
  const d = Math.abs(cpuResult[i] - gpuResult[i]);
  if (d > 1e-5) { diffCells++; maxDiff = Math.max(maxDiff, d); }
}
console.log(`Max diff: ${maxDiff}, differing cells: ${diffCells}/${w*h}`);
```

### After wiring: invariant tests catch regressions

The integration test (`test/integration/pipelineInvariants.test.js`) runs the full pipeline
with bitmap/polyline/block invariant hooks after every step. If the GPU value shader
produces incorrect allocations, the downstream invariants catch it (`noResOutsideZone`,
`noZoneOnWater`, etc.).

### CPU fallback always passing

The test suite uses `bun run test` which runs in Node.js. Node.js has no WebGPU by default.
The `GPUDevice.get()` call returns `{ available: false }` → CPU path. All tests pass
unchanged. The GPU path is only exercised in the browser or with `@webgpu/dawn`.

---

## Dependency order

```
Step 1: GPU infrastructure + invariant shader
  └── Validates: device init, buffer upload/download, dispatch
  └── Enables: GPU correctness harness for steps 2 and 3
  └── Win: invariant checks near-free at every sub-step

Step 2: GPU value composition
  └── Requires: Step 1 GPU infrastructure
  └── Requires: async PipelineRunner
  └── Win: ~22% of total city time → near zero

Step 3: GPU influence computation
  └── Requires: Step 1 GPU infrastructure
  └── Win: ~6% of total city time → near zero
  └── Can run in parallel with Step 2 development
```

---

## Expected outcome

After all three steps, a typical city (marketTown, 8 growth ticks):

| Phase | Before | After |
|-------|--------|-------|
| growth:value (8 ticks) | 208ms | ~2ms |
| growth:influence (8 ticks) | 48ms | ~8ms |
| Invariant checks (per step) | ~15ms | ~0.5ms |
| **Total pipeline** | **~1200ms** | **~950ms** |

The `growth:allocate` BFS (213ms, 35% of growth) is not GPU-accelerated in this plan —
it has data-dependent branching that makes it a poor GPU fit. That becomes the new dominant
cost and the target for the next round of optimisation (likely: spatial indexing, or
switching to a grid-sweep approach instead of BFS).

---

## Files created/modified summary

| File | Change |
|------|--------|
| `src/core/gpu/GPUDevice.js` | New — singleton adapter+device, CPU fallback |
| `src/core/gpu/GPUBuffer.js` | New — typed array ↔ GPUBuffer, pool |
| `src/city/invariants/bitmapInvariantsGPU.js` | New — atomic reduction shader |
| `src/city/invariants/bitmapInvariants.js` | Modify — dispatch to GPU or CPU |
| `src/city/pipeline/valueLayersGPU.js` | New — GPUValueSession, compose shader |
| `src/city/pipeline/valueLayers.js` | Modify — export CPU impl |
| `src/city/pipeline/influenceLayersGPU.js` | New — GPUInfluenceSession, blur shader |
| `src/city/pipeline/influenceLayers.js` | Modify — export CPU impl |
| `src/city/pipeline/growthTick.js` | Modify — GPU sessions in runValuePhase, runInfluencePhase |
| `src/city/pipeline/cityPipeline.js` | Modify — create/destroy sessions around growth loop |
| `src/city/pipeline/PipelineRunner.js` | Modify — async-aware advance() |
| `src/city/strategies/landFirstDevelopment.js` | Modify — async tick() |
| `scripts/verify-gpu-value.js` | New — CPU/GPU diff script |
| `scripts/verify-gpu-influence.js` | New — CPU/GPU diff script |

---

## Notes for next session

- Recover the autoresearch shader code from git: `git show 86ffc62 -- src/` and
  `git show ec17b3c -- src/` for the value and influence GPU implementations
- The autoresearch work used `@webgpu/dawn` bindings for Node.js. The browser uses
  `navigator.gpu`. Both expose the same WebGPU API — `GPUDevice.js` should detect which.
- The autoresearch session ran benchmarks on a 1200×1200 grid with 8 zones. The current
  benchmark uses 128×128 regional → 1200×1200 city. Same size, same target.
- The `growth:allocate` spike (max 1238ms) is NOT addressed here. Profile that separately
  after the GPU work lands — it may be the ribbon allocator's seed-scanning that dominates.
