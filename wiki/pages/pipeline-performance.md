---
title: "Pipeline Performance"
category: "observability"
tags: [performance, profiling, benchmarking, pipeline, timing, hooks]
summary: "How to measure per-step timing across the city pipeline using PipelineRunner hooks, run the benchmark script, and interpret results."
last-modified-by: user
---

## Overview

After the pipeline refactor, timing is a `PipelineRunner` hook — no bespoke wrapping. Every step has a stable string ID. Attach an `onAfter` hook and you get per-step durations for free, across every strategy and archetype.

`scripts/benchmark-pipeline.js` runs the full pipeline across many seeds and settlements, aggregates per-step statistics, and writes JSON + a console summary.

---

## How Timing Works

```js
strategy.runner.addHook({
  onAfter(stepId, result, ms) {
    timingLog.push({ stepId, ms });
  }
});
```

`ms` is the wall-clock time for that step's `fn()` call. The hook fires immediately after every step — `skeleton`, `land-value`, `zones`, `zone-boundary`, `zones-refine`, `spatial`, `growth-1:influence`, `growth-1:value`, ..., `connect`.

This is how `benchmark-pipeline.js` works: one hook attachment, no code changes to the pipeline.

---

## Step IDs

Full step sequence for a `marketTown` city (organic growth):

```
setup              ← recorded before the runner starts (setupCity call)
skeleton
land-value
zones
zone-boundary
zones-refine
spatial
growth-1:influence
growth-1:value
growth-1:ribbons
growth-1:allocate
growth-1:roads
growth-2:influence
...
growth-N:roads
connect
```

For archetypes without organic growth, the growth sub-steps are replaced by:
```
reserve
ribbons
connect
```

---

## Running the Benchmark

```bash
# Default: 5 seeds, all settlements, auto-select archetype
bun scripts/benchmark-pipeline.js

# Organic growth path (marketTown has the growth pipeline)
bun scripts/benchmark-pipeline.js --seeds 42,100,255,999 --archetype marketTown

# Only measure skeleton across 20 seeds
bun scripts/benchmark-pipeline.js --seeds $(seq -s, 1 20) --stop-after skeleton

# 3 settlements per region, write to custom path
bun scripts/benchmark-pipeline.js --seeds 42,100,255 --settlements 3 --out output/my-bench.json
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--seeds` | `42,100,255,999,12345` | Comma-separated seeds |
| `--settlements N` | all | First N settlements per region |
| `--archetype <name>` | auto | Force archetype (e.g. `marketTown`) |
| `--stop-after <id>` | none | Stop pipeline after this step ID |
| `--out <path>` | `output/pipeline-perf.json` | JSON output path |
| `--quiet` | false | Suppress per-city console lines |

---

## Output

### Console summary

```
Per-step aggregate (ms):
┌───┬───────────────┬────┬───────┬───────┬───────┬───────┬───────┐
│   │ step          │ n  │ mean  │ p50   │ p95   │ p99   │ max   │
├───┼───────────────┼────┼───────┼───────┼───────┼───────┼───────┤
│ 0 │ setup         │ 20 │ 171.3 │ 160.2 │ 210.1 │ 215.0 │ 221.0 │
│ 1 │ skeleton      │ 20 │ 138.5 │ 130.0 │ 205.4 │ 210.0 │ 214.0 │
│ 2 │ land-value    │ 20 │  58.1 │  60.0 │  72.0 │  73.0 │  74.0 │
│ 3 │ zones         │ 20 │ 143.2 │ 138.0 │ 200.0 │ 208.0 │ 210.0 │
...
└───┴───────────────┴────┴───────┴───────┴───────┴───────┴───────┘

Growth phase totals across all ticks (ms):
┌───┬──────────────────────────────┬────┬───────┬───────┬───────┬───────┐
│   │ phase                        │ n  │ mean  │ p50   │ p95   │ max   │
├───┼──────────────────────────────┼────┼───────┼───────┼───────┼───────┤
│ 0 │ growth:influence (all ticks) │ 20 │  85.0 │  82.0 │ 135.0 │ 140.0 │
│ 1 │ growth:value (all ticks)     │ 20 │ 280.0 │ 264.0 │ 450.0 │ 460.0 │
│ 2 │ growth:ribbons (all ticks)   │ 20 │   5.5 │   8.9 │   9.5 │  10.0 │
│ 3 │ growth:allocate (all ticks)  │ 20 │ 210.0 │ 175.0 │ 430.0 │ 445.0 │
│ 4 │ growth:roads (all ticks)     │ 20 │  60.0 │  55.0 │ 110.0 │ 115.0 │
└───┴──────────────────────────────┴────┴───────┴───────┴───────┴───────┘
```

### JSON output

```json
{
  "aggregate": [
    { "id": "skeleton", "n": 20, "meanMs": 138.5, "p50Ms": 130.0, "p95Ms": 205.4, ... }
  ],
  "growthAggregate": [
    { "id": "growth:value (all ticks)", "n": 20, "meanMs": 280.0, ... }
  ],
  "cities": [
    {
      "label": "seed-42 s[0] tier-2",
      "archetype": "Market Town",
      "totalMs": 1840,
      "timings": [
        { "id": "setup",       "ms": 193.0 },
        { "id": "skeleton",    "ms": 380.0 },
        { "id": "growth-1:influence", "ms": 8.1 },
        { "id": "growth-1:value",     "ms": 29.4 },
        ...
      ]
    }
  ]
}
```

---

## What to Look For

### `zones` and `zones-refine` — graph face extraction

Both are O(n) in face count but trigger `PlanarGraph.facesWithEdges()` which walks the half-edge structure. High variance here means the planar graph has many degenerate edges or disconnected components — check for duplicate edge warnings in the run output.

### `skeleton` — arterial network

High variance expected. Cities with rivers require bridge placement (extra polyline walk over all skeleton roads). Cities with many nuclei hit `PlanarGraph.compact()`'s O(n²) path. Identify which seeds have slow skeleton by looking at per-city output; check if they have rivers or many nuclei.

### `growth:value` — per-tick value composition (dominant)

Runs once per growth tick. `composeAllValueLayers` iterates over all 1.44M cells per layer combination. This is the primary GPU acceleration target — it's embarrassingly parallel (per-cell multiply-add). p95 higher than 3× p50 indicates some seeds have unusual value layer configurations.

### `growth:allocate` — agent allocation

Second-largest growth cost. BFS over zone cells per agent. High tail latency comes from the ribbon allocator (`allocateRibbon`), which is O(zone_cells × seed_count). The blob allocator is usually faster.

### `growth:influence` — BFS proximity blur

Scales with the number of non-zero cells in `reservationGrid`. Early ticks are fast (few reservations); later ticks may be slower. If influence is slow late in the game, check the BFS radius parameters.

### `connect` — spine-to-skeleton pathfinding

A* from zone spines to the skeleton. The `_ensureFullConnectivity` check adds one component BFS per city. If this step has high p99, look for cities with many disconnected local-road components in the growth output.

---

## Adding Sub-step Timing

The hook sees every step ID. For granular analysis, filter by pattern:

```js
// Record only growth steps
strategy.runner.addHook({
  onAfter(id, _, ms) {
    if (id.startsWith('growth-')) timings.push({ id, ms });
  }
});

// Alert on any step > 500ms
strategy.runner.addHook({
  onAfter(id, _, ms) {
    if (ms > 500) console.warn(`SLOW: ${id} took ${ms.toFixed(0)}ms`);
  }
});
```

---

## Relationship to Other Observability Tools

| Tool | What it measures | Output |
|------|-----------------|--------|
| `benchmark-pipeline.js` | Per-step timing across many cities | JSON + console table |
| `trace-pipeline.js` | Bitmap state at every step for one city | PPM images |
| Invariant hooks | Constraint violations at every step | Test failures or logged violations |

Typical workflow:
1. `benchmark-pipeline.js` identifies which step dominates or has high p99.
2. `trace-pipeline.js` on a slow seed shows what the city looks like at that step.
3. Fix the issue. Re-run benchmark to confirm improvement.
4. Invariant hooks confirm the fix didn't break correctness.
