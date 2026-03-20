---
title: "Pipeline Benchmarking and Performance"
category: "observability"
tags: [performance, benchmarking, optimisation, pipeline, timing]
summary: "Measured per-step timing for the city pipeline, what the bottlenecks are, and a prioritised list of improvements."
last-modified-by: user
---

## Goal

City loading should feel fast. It doesn't run in a hot loop, but waiting 2–3 seconds for the map to appear is noticeable enough to be annoying. Target: **< 1 second** cold-start for a typical city.

The benchmark numbers below are JIT-warmed (V8 has compiled the hot paths). First load in the browser is roughly **2–3× slower** for the first city, stabilising after 1–2 cities.

---

## Current Numbers

Benchmark: 5 seeds × all settlements × `marketTown` archetype (organic growth path).  
43 cities, run with `bun scripts/benchmark-pipeline.js --seeds 42,100,255,999,12345 --archetype marketTown`.

### Total city time

| | mean | p50 | p95 | max |
|---|---|---|---|---|
| Total pipeline | 1191ms | 1184ms | 1906ms | 2843ms |

### Per-step aggregate

| Step | mean | p50 | p95 | max | notes |
|------|------|-----|-----|-----|-------|
| setup | 148ms | 145ms | 213ms | 240ms | bilinear interp + BFS water distance |
| skeleton | 131ms | 132ms | 226ms | 272ms | variance from river crossings |
| land-value | 48ms | 46ms | 72ms | 114ms | |
| zones | 111ms | 120ms | 166ms | 195ms | `facesWithEdges()` graph walk |
| zone-boundary | 1ms | 1ms | 2ms | 8ms | negligible |
| zones-refine | 84ms | 106ms | 163ms | 196ms | second `facesWithEdges()` call |
| spatial | 61ms | 44ms | 147ms | 198ms | **3.3× variance** — see below |
| connect | 9ms | 3ms | 36ms | 65ms | spikes when many disconnected components |

### Growth phase totals (summed across all ticks)

| Phase | mean | p50 | p95 | max | per-tick mean |
|-------|------|-----|-----|-----|---------------|
| influence | 77ms | 75ms | 125ms | 168ms | ~6ms/tick |
| **value** | **258ms** | **251ms** | **420ms** | **557ms** | **26ms/tick** |
| ribbons | 12ms | 8ms | 28ms | 95ms | variable |
| **allocate** | **213ms** | **181ms** | **514ms** | **1238ms** | **20ms/tick** |
| roads | 58ms | 54ms | 123ms | 239ms | ~5ms/tick |

### Where the time goes

```
Pre-growth (setup→spatial):   49%   583ms
Growth ticks:                  50%   598ms
  └── value composition:       22%   258ms  ← primary GPU target
  └── allocation BFS:          18%   213ms
  └── influence blur:           6%    77ms
  └── roads:                    5%    58ms
Connect:                        1%     9ms
```

---

## Bottlenecks and Improvements

### 1. `growth:value` — value layer composition (26ms/tick, 258ms total)

**What:** `composeAllValueLayers` in `valueLayers.js`. For each of ~8 agent types, iterates all 1,440,000 cells computing a weighted sum of spatial and influence layers. Runs every growth tick.

**Why it's slow:** O(cells × agents × layers) with no parallelism. With 20 ticks × 26ms = 520ms in the worst case.

**Improvement:** GPU compute shader. This is embarrassingly parallel — pure per-cell multiply-add. A WebGPU kernel dispatch eliminates this step entirely (< 1ms dispatch cost). Already prototyped as part of the GPU research branch.

**Expected gain:** ~22% of total time → near zero. Biggest single win.

---

### 2. `growth:allocate` — BFS agent allocation (20ms/tick, 213ms total, spikes to 1238ms)

**What:** `allocate.js`, `allocateFrontage.js`, `allocateRibbon.js`. For each agent, BFS-expands from seed cells through the zone grid claiming cells until the budget is exhausted.

**Why it varies:** The ribbon allocator (`allocateRibbon`) does much more work than the blob allocator — it samples road cells, builds ribbon corridors, and tracks gaps. Cities with many ribbon-allocated agents (residentialFine, residentialEstate, residentialQuality all use ribbon) and large zones hit the worst case.

**Improvement options:**
- Profile which allocator type dominates the slow cities. If ribbon allocator is the culprit, add a cell-count cap per zone per tick rather than budget-based termination.
- Limit seed point sampling in `allocateRibbon` — it currently scans all road cells in the zone; a random sample of N seeds is sufficient.
- The blob allocator could use a priority queue (min-heap by value score) instead of a sorted scan, reducing per-tick cost from O(n log n) to O(k log n).

**Expected gain:** Hard to estimate without deeper profiling. Tail reduction from 1238ms max is the main target — the median (20ms/tick) is acceptable.

---

### 3. `zones` + `zones-refine` — double graph face extraction (195ms mean, 391ms max)

**What:** Both steps call `PlanarGraph.facesWithEdges()`, which walks the entire half-edge structure to enumerate faces. Called twice: once before zone boundary roads (`zones`), once after (`zones-refine`).

**Why it's slow:** The half-edge walk is O(edges). Complex skeletons with many junction nodes produce many edges. For seed-12345 s[0] (391ms), the graph is large enough that both walks are expensive.

**Improvement:** Check whether `zone-boundary` actually added any roads before running `zones-refine`. If `createZoneBoundaryRoads` returned `segmentsAdded: 0`, skip the second extraction and reuse the first result.

Additionally, `rasterizePolygon` in `extractZones.js` runs for every face. For faces with large bounding boxes, this iterates many cells. A spatial index (or at minimum, skip faces whose bounding box falls entirely in water) could cut this significantly.

**Expected gain:** ~50% of zones cost when no boundary roads were added; meaningful reduction in the common case.

---

### 4. `spatial` variance — 3.3× spread (44ms p50, 147ms p95)

**What:** `computeSpatialLayers.js`. Computes centrality (BFS from nuclei), waterfrontness (BFS from water), edgeness (inverse centrality), road frontage (blur of roadGrid), downwindness.

**Why it varies:** The variance correlates with settlements where `skeleton` is fast but `spatial` is slow, suggesting it's the **road frontage blur** (blur of `roadGrid`) that scales with road density, not nucleus count. A city with a dense skeleton (many arterials from zone-boundary roads) does more blur work.

**Improvement:** The road frontage computation currently uses a box blur of radius 4. Use a separated two-pass 1D blur instead (write a horizontal pass, then a vertical pass). For an n-cell grid with radius r, this reduces from O(n × r²) to O(n × 2r).

**Expected gain:** Could halve `spatial` cost in the slow cases, bringing 147ms p95 to ~75ms.

---

### 5. `computeLandValue` flatness kernel (48ms mean — not a bottleneck, but easy win)

**What:** A 7×7 kernel blur over 1.44M cells (70M multiplications). Already logs timing internally.

**Improvement:** Separate the 2D 7×7 kernel into two 1D passes (horizontal 7-wide → vertical 7-wide). Reduces from O(n × 49) to O(n × 14). ~3.5× speedup on this step.

**Expected gain:** ~35ms saved (48ms → ~13ms). Minor but free.

---

### 6. Cold-start JIT warmup

The numbers above are JIT-warmed. First city load in the browser is 2–3× slower for the heavy steps (`composeAllValueLayers`, `computeInfluenceLayers`). The value computation goes from 26ms/tick to ~60–70ms/tick on first load.

**Improvement:** Import `cityPipeline` and run a tiny no-op pipeline on app startup to warm the JIT before the user requests their first city. A 10×10 stub city through the first two steps costs ~5ms and compiles the hot paths.

---

## Priority Order

| # | What | Expected gain | Effort |
|---|------|--------------|--------|
| 1 | `growth:value` → GPU compute shader | 22% of total, all cities | Medium (GPU code exists from research) |
| 2 | `growth:influence` → GPU | 6% of total | Low (already prototyped) |
| 3 | Skip `zones-refine` when no boundary roads added | Up to 50% of zones cost | Low |
| 4 | `spatial` road-frontage separated blur | Halve p95 spatial | Low |
| 5 | `computeLandValue` separated kernel | ~35ms | Low |
| 6 | JIT warmup on startup | 2–3× first-city improvement | Low |
| 7 | `growth:allocate` ribbon allocator sampling | Reduce max spike | Medium |

Items 3–6 are low-hanging fruit — each is a few lines of code and doesn't require GPU infrastructure.

---

## Running the Benchmark

```bash
# Quick check — 2 seeds, 3 settlements each
bun scripts/benchmark-pipeline.js --seeds 42,100 --settlements 3 --archetype marketTown

# Full benchmark — all settlements, 5 seeds
bun scripts/benchmark-pipeline.js --seeds 42,100,255,999,12345 --archetype marketTown

# Measure only up to zones (useful when iterating on extraction)
bun scripts/benchmark-pipeline.js --seeds 42,100,255 --stop-after zones-refine
```

Output goes to `output/pipeline-perf.json`. The script prints a summary table to the console. See [[pipeline-performance]] for a full description of the output format and what to look for.

---

## Tracking Progress

Update the "Current Numbers" table whenever a meaningful change lands. To regenerate:

```bash
bun scripts/benchmark-pipeline.js --seeds 42,100,255,999,12345 --archetype marketTown --quiet
```

Compare new p50/p95 against the table above. A change is meaningful if it moves p50 by > 5ms or p95 by > 15ms on any step.
