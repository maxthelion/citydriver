# WebGPU Compute Shader Acceleration

## Current Architecture

The city generation pipeline operates on `Grid2D` instances backed by typed arrays (`Float32Array`, `Uint8Array`). Grid sizes are ~500x500 (250K cells) at regional scale (50m cells) and ~1000x1000 (1M+ cells) at city scale (5-10m cells). All computation is single-threaded JS.

There are three categories of grid operation, each with different GPU suitability.

---

## Category A: Embarrassingly Parallel Per-Cell Operations (Best Candidates)

These iterate every cell independently with no read-write dependencies between cells. They map directly to one GPU thread per cell.

| Function | File | Grid Size | Operation |
|----------|------|-----------|-----------|
| `_computeInitialBuildability()` | FeatureMap.js:140 | city (1M+) | slope score + edge taper + waterfront bonus |
| `computeTerrainSuitability()` | terrainSuitability.js:117 | city (1M+) | same formula, standalone |
| `computeFloodZone()` | terrainSuitability.js:91 | city (1M+) | threshold check on elevation + water distance |
| `applyTerrainFields()` | carveValleys.js:177 | regional (250K) | subtract valley depth, lerp floodplain |
| `applySeaFloorPlunge()` | seaFloorPlunge.js:78 | regional (250K) | per-cell depth from land distance + resistance |
| Slope recompute | FeatureMap.js:728-745 | city (1M+) | central-difference gradient |
| `flowDirections()` | flowAccumulation.js:114 | regional (250K) | D8 steepest-descent per cell |
| `computeLandValue()` (main loop) | FeatureMap.js:806-849 | city (1M+) | flatness + proximity + water bonus |

**Expected speedup:** 10-50x for city-scale grids. These are textbook GPU workloads — each thread reads a small neighborhood, computes a scalar, writes one output cell.

**WGSL sketch** (buildability as example):

```wgsl
@group(0) @binding(0) var<storage, read> slope: array<f32>;
@group(0) @binding(1) var<storage, read> waterMask: array<u32>;
@group(0) @binding(2) var<storage, read> waterDist: array<f32>;
@group(0) @binding(3) var<storage, read_write> buildability: array<f32>;

struct Params {
  width: u32, height: u32,
  edgeMargin: u32, edgeTaper: u32,
  waterfrontRange: u32, waterfrontBonus: f32,
};
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let gx = id.x; let gz = id.y;
  if (gx >= params.width || gz >= params.height) { return; }
  let idx = gz * params.width + gx;

  let edgeDist = min(min(gx, gz), min(params.width - 1 - gx, params.height - 1 - gz));
  if (edgeDist < params.edgeMargin) { buildability[idx] = 0.0; return; }
  if (waterMask[idx] > 0u) { buildability[idx] = 0.0; return; }

  var score = slopeScore(slope[idx]);
  if (edgeDist < params.edgeTaper) { score *= f32(edgeDist) / f32(params.edgeTaper); }

  let wd = waterDist[idx];
  if (wd > 0.0 && wd < f32(params.waterfrontRange)) {
    score = min(1.0, score + params.waterfrontBonus * (1.0 - wd / f32(params.waterfrontRange)));
  }
  buildability[idx] = score;
}
```

---

## Category B: BFS Distance Fields → Jump Flooding Algorithm (High-Value Conversion)

There are **6 separate BFS distance computations** that all follow the same pattern: seed cells, propagate distance in 4-connected BFS. These are the most impactful targets because:

1. BFS is inherently sequential (wavefront expansion) and cannot run on the GPU as-is
2. The **Jump Flooding Algorithm (JFA)** computes the same discrete distance field in O(log N) parallel passes, making it ideal for compute shaders
3. These run on city-scale grids (1M+ cells) and are called repeatedly

| BFS Function | File | Seed Condition |
|-------------|------|----------------|
| `_computeWaterDistance()` | FeatureMap.js:186 | waterMask > 0 |
| `computeWaterDepth()` | FeatureMap.js:231 | waterMask == 0 (inverse) |
| `computeWaterDistance()` | terrainSuitability.js:26 | waterMask > 0 |
| `computeCoastDistance()` | carveValleys.js:258 | water cells with land neighbor |
| `computeLandDistance()` | seaFloorPlunge.js:23 | land cells with water neighbor |
| `classifyWater()` BFS | FeatureMap.js:523-552 | boundary water cells |

**JFA approach:** For a 1024x1024 grid, JFA takes ~10 passes (log2(1024)), each dispatching 1M threads. Each pass reads from/writes to a grid of nearest-seed coordinates with jump distances halving each pass (512, 256, 128... 1).

```wgsl
// JFA pass: each cell checks 9 neighbors at distance `step`
@compute @workgroup_size(16, 16)
fn jfa_pass(@builtin(global_invocation_id) id: vec3<u32>) {
  let gx = i32(id.x); let gz = i32(id.y);
  if (gx >= i32(params.width) || gz >= i32(params.height)) { return; }

  var bestSeed = seedGrid[gz * i32(params.width) + gx]; // vec2<i32>, (-1,-1) = no seed
  var bestDist = distFor(bestSeed, gx, gz);

  for (var dz = -1; dz <= 1; dz++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = gx + dx * i32(params.step);
      let nz = gz + dz * i32(params.step);
      if (nx < 0 || nx >= i32(params.width) || nz < 0 || nz >= i32(params.height)) { continue; }
      let candidate = seedGrid[nz * i32(params.width) + nx];
      let d = distFor(candidate, gx, gz);
      if (d < bestDist) { bestDist = d; bestSeed = candidate; }
    }
  }
  outGrid[gz * i32(params.width) + gx] = bestSeed;
}
```

**Expected speedup:** 20-100x. BFS on a 1M-cell grid with cutoff 60 cells processes millions of queue entries sequentially. JFA does ~10 fully-parallel passes over the same grid.

**Note:** JFA produces Euclidean distance (not Manhattan/Chebyshev). The current BFS uses 4-connected cell distance. Either:
- Accept Euclidean distance (probably fine — the constants like `WATERFRONT_RANGE_M` are soft thresholds)
- Use a JFA variant with Manhattan metric (slightly more complex)

---

## Category C: Convolution / Local Averaging (Good Candidate)

**`computeLandValue()` flatness averaging** (FeatureMap.js:766-781) computes a box average of slope within a radius around each cell. This is an O(N * R^2) operation where R = `flatnessR` (~3 cells for 5m cells). For R=3, that's 49 reads per cell x 1M cells = 49M reads.

**GPU approach:** A separable box filter in two passes (horizontal then vertical), or a single compute pass with shared memory tiling:

```wgsl
// Workgroup loads a tile + halo into shared memory, each thread averages its window
var<workgroup> tile: array<f32, 24 * 24>; // 16x16 tile + 4-cell halo on each side

@compute @workgroup_size(16, 16)
fn flatness(@builtin(global_invocation_id) gid: vec3<u32>,
            @builtin(local_invocation_id) lid: vec3<u32>) {
  // Cooperative load of tile + halo into shared memory
  // Then each thread averages its R-radius window from shared memory
}
```

**Expected speedup:** 5-20x depending on radius.

---

## Category D: Stamp Operations (Moderate Candidate)

Road/river/channel stamping (`_stampRoad`, `_stampRiver`, `carveChannels`) walks polylines at sub-cell steps and writes to nearby cells. These are write-heavy with potential write conflicts where polyline segments overlap.

**GPU approach:** Invert the loop — instead of iterating polyline segments and writing to nearby cells, iterate all cells and check against all segments:

```
For each cell (parallel):
  For each polyline segment:
    Compute distance to segment
    If within radius, apply stamp value (atomicMin for elevation carving)
```

This is more work per cell but massively parallel. For sparse polylines on large grids, a **two-pass approach** works better:
1. Rasterize segment bounding boxes into a tile grid (CPU, cheap)
2. GPU kernel per cell: only check segments whose bbox overlaps this tile

**Expected speedup:** 3-10x. Stamp operations are already fairly fast since they only touch cells near polylines.

---

## Category E: Poor GPU Candidates (Keep on CPU)

| Operation | Why not GPU |
|-----------|------------|
| `fillSinks()` (priority flood) | Inherently sequential heap-based algorithm. GPU variants exist but are complex and only faster for very large grids (4K+) |
| `flowAccumulation()` | Requires topological ordering (high-to-low elevation sort + sequential propagation). GPU prefix-sum approaches exist but are complex |
| `extractFaces()` flood fill | Irregular connected-component labeling. GPU approaches exist but the output (polygon contours) is small |
| `_traceContour()` (Moore tracing) | Sequential boundary following |
| `smoothRiverPaths()` | Sequential per-segment with occupancy set |
| A* pathfinding (`createPathCost`) | Called per-step, inherently sequential |

---

## Implementation Strategy

### Phase 1 — Highest impact, lowest complexity

1. **Unify all BFS distance functions into a single GPU JFA kernel.** The 6 BFS functions differ only in their seed condition. Build one `computeDistanceField(seedMask, params) -> Float32Array` function that:
   - Uploads the seed mask as a storage buffer
   - Runs 10-12 JFA passes
   - Reads back the distance grid

   This replaces 6 functions with one GPU implementation.

2. **Port per-cell buildability/suitability to GPU.** These depend on distance fields (from step 1), slope, waterMask — all already on GPU. Chain them: JFA -> buildability without reading back to CPU between steps.

### Phase 2 — Chain operations, minimize transfers

3. **Keep grids on the GPU across pipeline steps.** The critical path is:
   ```
   waterMask -> waterDistance (JFA) -> buildability -> landValue
   ```
   If grids stay as GPU buffers, the only transfer is the final readback. This eliminates the main overhead of GPU compute (CPU<->GPU data transfer).

4. **Port slope computation and flatness averaging to GPU.** These are needed by buildability and land value, so keeping them on-GPU avoids round-trips.

### Phase 3 — Stamp operations

5. **Port `carveChannels()` and stamp functions.** These benefit less from GPU but avoid costly readback->modify->upload cycles if the rest of the pipeline is already on-GPU.

---

## WebGPU Integration Architecture

```
┌─────────────┐
│  Grid2D.js  │  <- Add optional GPUBuffer backing
└──────┬──────┘
       │
┌──────▼──────────────┐
│  GPUGridCompute.js  │  <- New module
│                     │
│  - device/adapter   │
│  - pipeline cache   │
│  - JFA kernel       │
│  - buildability     │
│  - slopeCompute     │
│  - flatnessBlur     │
│  - stampKernel      │
└─────────────────────┘
```

**Grid2D changes:** Add a `gpuBuffer` property and lazy upload/download:
```js
class Grid2D {
  _gpuBuffer = null;
  _gpuDirty = false;  // CPU data newer than GPU
  _cpuDirty = false;  // GPU data newer than CPU

  async toGPU(device) { /* upload this.data -> GPUBuffer */ }
  async fromGPU() { /* download GPUBuffer -> this.data */ }
  getGPUBuffer(device) { /* lazy upload, return buffer */ }
}
```

**Fallback:** Feature-detect `navigator.gpu`, fall back to current CPU code when unavailable (Node.js without Dawn, older browsers). The `GPUGridCompute` functions should have the same signatures as their CPU counterparts.

---

## Estimated Impact

For a city-scale grid (1000x1000 = 1M cells):

| Operation | Current CPU (est.) | GPU (est.) | Speedup |
|-----------|-------------------|------------|---------|
| 6x BFS distance fields | ~120ms total | ~5ms total (JFA) | **24x** |
| Buildability | ~15ms | ~0.5ms | **30x** |
| Land value (with flatness) | ~80ms | ~3ms | **27x** |
| Slope recompute | ~10ms | ~0.3ms | **33x** |
| Terrain field application | ~8ms | ~0.3ms | **27x** |
| **Pipeline total** | **~230ms** | **~10ms** | **~23x** |

Transfer overhead (~2ms per 4MB grid readback at PCIe speeds) is amortized by chaining operations on-GPU.

---

## Risks and Considerations

1. **Browser support:** WebGPU is available in Chrome 113+, Edge, and behind flags in Firefox/Safari. For Node.js you'd need `@webgpu/dawn` or similar.

2. **Precision:** `f32` in WGSL matches `Float32Array`. `u8` for masks needs packing into `u32` storage buffers (WGSL doesn't support 8-bit storage directly).

3. **JFA vs BFS accuracy:** JFA can produce errors at Voronoi cell boundaries (off by ~1 cell). For distance thresholds used as soft gradients this is acceptable. For exact flood-fill classification (e.g., `classifyWater`), you may still need CPU BFS or a post-correction pass.

4. **Async pipeline:** GPU readback is async (`mapAsync`). The generation pipeline would need to become async (or use `postMessage` with transferable buffers in a worker). If the pipeline is already async or run in a worker, this is straightforward.

5. **Debugging:** GPU compute is harder to debug than JS. Keeping CPU fallbacks and adding `Grid2D.compare(cpuResult, gpuResult)` validation during development is recommended.
