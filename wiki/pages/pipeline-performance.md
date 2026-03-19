---
title: "Pipeline Performance"
category: "observability"
tags: [performance, profiling, benchmarking, pipeline, timing]
summary: "How to instrument and measure per-step timing across the city generation pipeline, run across multiple seeds and settlements, and interpret the results."
last-modified-by: user
---

## Overview

City generation runs through a fixed sequence of ticks driven by `LandFirstDevelopment`. Some steps (skeleton roads, zone extraction, growth ticks) do much heavier work than others. Without measurement we can't know which steps dominate, whether performance varies significantly between seeds or city archetypes, or whether a code change has made something meaningfully slower.

This page describes:
- What the natural instrumentation points are
- The `PipelineProfiler` design for collecting per-step timings
- The `benchmark-pipeline.js` script for running across many seeds and settlements
- What the output looks like and how to read it
- How performance instrumentation relates to the existing [[pipeline-observability|bitmap trace]] system

---

## What We Want to Measure

### Unit of work

The natural unit is a single **pipeline step** — one call to `LandFirstDevelopment.tick()`. Each tick maps to a named function. The full step sequence for one city is:

| Step label | Function | Notes |
|---|---|---|
| `setup` | `setupCity()` | Tick 0: region inheritance, terrain refinement, nucleus placement |
| `skeleton` | `buildSkeletonRoads()` | A\*, snap, merge, compact, bridges |
| `land-value` | `computeLandValue()` | Flatness + proximity + water bonus |
| `zones` | `extractZones()` | Voronoi + threshold + morphological close + flood-fill |
| `spatial` | `computeSpatialLayers()` | 5 layers: centrality, waterfrontness, edgeness, frontage, downwindness |
| `growth-N` | `runGrowthTick()` | One tick per call; N = 1, 2, … up to `maxGrowthTicks` |
| `ribbons` | `layoutRibbons()` | Only when archetype has no growth config |
| `connect` | `connectToNetwork()` | A\* from zone spines to skeleton |

We want timings **per step, per city** so we can compute:
- Mean and 99th-percentile duration per step across seeds
- Total pipeline time per city
- Which step is the bottleneck
- Whether performance differs by archetype or settlement tier

### What varies between runs

Two sources of variance matter:

1. **Seed** — different terrain, river placement, and settlement positions produce structurally different cities (river crossings affect bridge cost, nucleus count affects skeleton complexity).
2. **Settlement index within a region** — a region typically has several settlements at different tiers. Tier 1 cities (larger, more nuclei, more growth ticks) will be slower than tier 4 villages. Running all settlements from a region in one pass captures this spread naturally.

---

## Instrumentation Design

### `PipelineProfiler`

A thin wrapper around `LandFirstDevelopment` that records `performance.now()` before and after each `tick()` call. It does not touch the strategy internals.

```js
// src/core/PipelineProfiler.js

export class PipelineProfiler {
  /**
   * @param {LandFirstDevelopment} strategy
   * @param {string} label - human-readable city label (e.g. "seed-42 s[0] tier-2")
   */
  constructor(strategy, label = '') {
    this._strategy = strategy;
    this.label = label;
    this.records = [];   // [{step, durationMs, tick}]
    this._tickCount = 0;
  }

  /**
   * Record a named step that runs outside the strategy's tick() loop.
   * Used for setup (tick 0) which is called before the strategy is constructed.
   */
  recordStep(stepLabel, fn) {
    const t0 = performance.now();
    const result = fn();
    const durationMs = performance.now() - t0;
    this.records.push({ step: stepLabel, durationMs, tick: 0 });
    return result;
  }

  /**
   * Advance the strategy by one tick, recording timing and step label.
   * Returns false when the strategy is complete.
   */
  tick() {
    this._tickCount++;
    const stepLabel = this._resolveStepLabel();
    const t0 = performance.now();
    const running = this._strategy.tick();
    const durationMs = performance.now() - t0;
    this.records.push({ step: stepLabel, durationMs, tick: this._tickCount });
    return running;
  }

  /** Run the strategy to completion, recording every tick. */
  runToCompletion() {
    let running = true;
    while (running) {
      running = this.tick();
    }
  }

  /** Run the strategy up to and including a named step, then stop. */
  runToStep(targetStep) {
    let running = true;
    while (running) {
      running = this.tick();
      const last = this.records[this.records.length - 1];
      if (last && last.step === targetStep) break;
    }
  }

  /** Total pipeline time in ms. */
  get totalMs() {
    return this.records.reduce((sum, r) => sum + r.durationMs, 0);
  }

  /** Summary object for JSON output. */
  toSummary() {
    return {
      label: this.label,
      totalMs: Math.round(this.totalMs),
      steps: this.records.map(r => ({
        step: r.step,
        durationMs: Math.round(r.durationMs * 100) / 100,
        pct: Math.round((r.durationMs / this.totalMs) * 1000) / 10,
      })),
    };
  }

  _resolveStepLabel() {
    const s = this._strategy;
    if (s._phase === 'pipeline') {
      const labels = { 1: 'skeleton', 2: 'land-value', 3: 'zones', 4: 'spatial', 5: 'growth-1' };
      return labels[s._tick + 1] || `pipeline-${s._tick + 1}`;
    }
    if (s._phase === 'growth') {
      const n = (s._growthState?.tick ?? 0) + 1;
      return `growth-${n}`;
    }
    if (s._phase === 'finish') {
      const ft = (s._finishTick ?? 0) + 1;
      const hasGrowth = s.archetype && s.archetype.growth;
      if (ft === 1) return hasGrowth ? 'connect' : 'ribbons';
      return 'connect';
    }
    return `tick-${this._tickCount}`;
  }
}
```

**Key design choices:**

- `recordStep(label, fn)` handles `setupCity()` which runs before the strategy exists. The profiler records it with tick 0.
- `_resolveStepLabel()` inspects the strategy's `_phase` and `_growthState` to name each tick correctly **before** calling `tick()`. This means the label reflects what the tick is about to do, which is correct because `tick()` increments the internal counter as its first act.
- `runToStep(targetStep)` allows partial pipeline runs — useful for testing a change to skeleton roads without waiting for the full growth phase.
- The profiler has no knowledge of grids or maps. It adds no latency that would affect timing.

---

## Benchmark Script

`scripts/benchmark-pipeline.js` runs the full pipeline for every settlement in a set of regions, collecting per-step timings and writing a JSON summary.

```js
// scripts/benchmark-pipeline.js
//
// Usage:
//   bun scripts/benchmark-pipeline.js [options]
//
// Options:
//   --seeds 42,100,999        comma-separated seeds (default: 42,100,255,999,12345)
//   --settlements all|N       'all' = every settlement in each region (default),
//                             N = first N per region
//   --stop-at <step>          run each city only up to this step label
//   --out output/perf.json    output path (default: output/pipeline-perf.json)
//   --quiet                   suppress per-city console output
//
// Example — measure only skeleton roads across 5 seeds:
//   bun scripts/benchmark-pipeline.js --seeds 1,2,3,4,5 --stop-at skeleton
//
// Example — full pipeline, first 3 settlements per region, 10 seeds:
//   bun scripts/benchmark-pipeline.js \
//     --seeds 1,2,3,4,5,6,7,8,9,10 \
//     --settlements 3

import { generateRegion } from '../src/regional/pipeline.js';
import { setupCity } from '../src/city/setup.js';
import { selectArchetype } from '../src/city/archetypeScoring.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { PipelineProfiler } from '../src/core/PipelineProfiler.js';
import { SeededRandom } from '../src/core/rng.js';
import { writeFileSync } from 'fs';

// --- Parse args ---
const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.split('=')).map(([k, v]) => [k.replace(/^--/, ''), v])
);
const seeds    = (args.seeds ?? '42,100,255,999,12345').split(',').map(Number);
const maxSettl = args.settlements === 'all' || !args.settlements ? Infinity : Number(args.settlements);
const stopAt   = args['stop-at'] ?? null;
const outPath  = args.out ?? 'output/pipeline-perf.json';
const quiet    = 'quiet' in args;

const results = [];

for (const seed of seeds) {
  const rng = new SeededRandom(seed);
  const coastEdge = ['north', 'south', 'east', 'west', null][rng.int(0, 4)];

  // Generate region (not timed — this is regional, not city pipeline)
  const layers = generateRegion(
    { width: 128, height: 128, cellSize: 50, seaLevel: 0, coastEdge },
    rng
  );

  const settlements = layers.getData('settlements') ?? [];
  const citySeeds = settlements.slice(0, maxSettl === Infinity ? settlements.length : maxSettl);

  for (let si = 0; si < citySeeds.length; si++) {
    const settlement = citySeeds[si];
    const cityRng = rng.fork(`city-${si}`);
    const label = `seed-${seed} s[${si}] tier-${settlement.tier ?? '?'}`;

    const profiler = new PipelineProfiler(null, label);

    // Tick 0: setup (outside the strategy)
    const map = profiler.recordStep('setup', () => setupCity(layers, settlement, cityRng));

    const archetype = selectArchetype(map);
    const strategy = new LandFirstDevelopment(map, { archetype });
    profiler._strategy = strategy;

    if (stopAt) {
      profiler.runToStep(stopAt);
    } else {
      profiler.runToCompletion();
    }

    const summary = profiler.toSummary();
    results.push(summary);

    if (!quiet) {
      const stepLine = summary.steps
        .map(s => `${s.step}:${s.durationMs}ms(${s.pct}%)`)
        .join('  ');
      console.log(`${label.padEnd(28)} total=${summary.totalMs}ms  ${stepLine}`);
    }
  }
}

// --- Aggregate ---
const stepNames = [...new Set(results.flatMap(r => r.steps.map(s => s.step)))];
const aggregate = stepNames.map(step => {
  const times = results
    .flatMap(r => r.steps.filter(s => s.step === step).map(s => s.durationMs))
    .sort((a, b) => a - b);
  if (times.length === 0) return null;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const p50  = times[Math.floor(times.length * 0.50)];
  const p95  = times[Math.floor(times.length * 0.95)];
  const p99  = times[Math.floor(times.length * 0.99)] ?? times[times.length - 1];
  return { step, n: times.length, meanMs: Math.round(mean * 10) / 10,
           p50Ms: Math.round(p50 * 10) / 10, p95Ms: Math.round(p95 * 10) / 10,
           p99Ms: Math.round(p99 * 10) / 10, maxMs: Math.round(times[times.length - 1] * 10) / 10 };
}).filter(Boolean);

const output = { seeds, maxSettl, stopAt, generatedAt: new Date().toISOString(),
                 cities: results, aggregate };
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWrote ${results.length} cities → ${outPath}`);
console.log('\nAggregate (ms):');
console.table(aggregate.map(a => ({
  step: a.step, n: a.n, mean: a.meanMs, p50: a.p50Ms, p95: a.p95Ms, p99: a.p99Ms, max: a.maxMs,
})));
```

---

## Output Format

The script writes a JSON file with two top-level keys:

### `cities` — per-city records

```json
{
  "label": "seed-42 s[0] tier-2",
  "totalMs": 843,
  "steps": [
    { "step": "setup",      "durationMs": 112.4, "pct": 13.3 },
    { "step": "skeleton",   "durationMs": 380.1, "pct": 45.1 },
    { "step": "land-value", "durationMs":  18.2, "pct":  2.2 },
    { "step": "zones",      "durationMs":  54.7, "pct":  6.5 },
    { "step": "spatial",    "durationMs":  22.3, "pct":  2.6 },
    { "step": "growth-1",   "durationMs":  31.0, "pct":  3.7 },
    { "step": "growth-2",   "durationMs":  28.5, "pct":  3.4 },
    { "step": "growth-3",   "durationMs":  27.8, "pct":  3.3 },
    { "step": "connect",    "durationMs": 168.0, "pct": 19.9 }
  ]
}
```

### `aggregate` — statistics across all cities

```json
[
  { "step": "skeleton", "n": 47, "meanMs": 290, "p50Ms": 260, "p95Ms": 580, "p99Ms": 720, "maxMs": 890 },
  { "step": "connect",  "n": 47, "meanMs": 140, "p50Ms": 120, "p95Ms": 310, "p99Ms": 420, "maxMs": 560 },
  ...
]
```

The p95 and p99 values matter more than mean — a step that's fast on average but occasionally spikes (e.g. skeleton roads with many river crossings) shows up in the tail.

---

## Partial Runs — Stopping at a Step

`--stop-at <step>` lets you benchmark a specific step in isolation without paying for the rest of the pipeline. This is useful when iterating on a single function.

```bash
# Measure only skeleton roads across 20 seeds
bun scripts/benchmark-pipeline.js --seeds $(seq -s, 1 20) --stop-at skeleton

# Measure up to zones (setup + skeleton + land-value + zones)
bun scripts/benchmark-pipeline.js --seeds 42,100,255 --stop-at zones
```

When the profiler is used this way, only steps up to and including the target appear in the output. Aggregate statistics are computed over those steps only.

---

## Console Output

```
seed-42 s[0] tier-2         total=843ms   setup:112ms(13%)  skeleton:380ms(45%)  land-value:18ms(2%)  zones:55ms(7%)  spatial:22ms(3%)  growth-1:31ms(4%)  connect:168ms(20%)
seed-42 s[1] tier-3         total=412ms   setup:88ms(21%)   skeleton:195ms(47%)  land-value:12ms(3%)  zones:31ms(8%)  spatial:14ms(3%)  connect:72ms(17%)
seed-42 s[2] tier-4         total=180ms   setup:44ms(24%)   skeleton:82ms(46%)   land-value:7ms(4%)   zones:14ms(8%)  spatial:8ms(4%)   connect:25ms(14%)
...
seed-100 s[0] tier-1        total=1840ms  setup:210ms(11%)  skeleton:730ms(40%)  ...
```

Growth ticks only appear for settlements whose archetype has `growth` config. Tier 4 villages (few nuclei, no growth) finish much faster than tier 1 cities.

---

## Relationship to Existing Observability Tools

| Tool | Purpose | Output |
|---|---|---|
| `trace-pipeline.js` | Capture bitmap state at every step | PPM images per step |
| `render-reservations.js` | Final reservation grid only | Single PPM |
| **`benchmark-pipeline.js`** | Per-step timing across many cities | JSON + console table |

They are complementary. A typical workflow when investigating a slow step:

1. Run `benchmark-pipeline.js` to confirm which step dominates and identify which seeds show the worst tail latency.
2. Run `trace-pipeline.js` with one of those seeds to see the bitmap state — is skeleton slow because of many river crossings? Are zones slow because they produce hundreds of tiny fragments?
3. Fix the issue, re-run `benchmark-pipeline.js` to confirm improvement.

The `PipelineProfiler` can also be passed into `trace-pipeline.js` directly — both can run together so a single script produces timing data and bitmap snapshots.

---

## What to Look for in Results

### Skeleton roads (`skeleton`)

The dominant step for most cities. High variance is expected: cities with rivers require bridge placement, which adds an extra polyline walk over all skeleton roads. If p99 is more than 3× p50, river crossings are likely the cause — look at seeds where the skeleton step is slow and check whether there are rivers.

The `PlanarGraph.compact()` call inside skeleton is O(n²) in node count. Cities with many nuclei (tier 1, complex terrain) will show this in the tail.

### Growth ticks (`growth-N`)

Each tick should be roughly constant or slightly decreasing (fewer unclaimed cells left to allocate). If a late tick (growth-5, growth-6) is significantly slower than early ones, the influence layer BFS or value layer composition is scaling poorly with the number of already-reserved cells.

### Connect to network (`connect`)

A\* from zone spines to the skeleton. Slow when zones are far from the skeleton (island zones, disconnected terrain). The `connectIslandZones` fallback also runs here. If this step has high p99, look at seeds where the skeleton is sparse.

### Setup (`setup`)

Should be fast and roughly constant. High variance here indicates the regional inheritance (bilinear interpolation, Perlin detail, BFS water distance) is scaling with grid size unexpectedly.

---

## Adding Timing to Individual Functions

The profiler records wall-clock time per tick. For more granular data inside a single tick, `console.time` / `console.timeEnd` pairs can be added temporarily without touching the profiler:

```js
// Inside buildSkeletonRoads.js, during investigation
console.time('skeleton:pathfind');
const networkResult = buildRoadNetwork({ ... });
console.timeEnd('skeleton:pathfind');

console.time('skeleton:compact');
compactRoads(map, map.cellSize * 1.5);
console.timeEnd('skeleton:compact');
```

For a permanent structured alternative, the pipeline functions could accept an optional `timingBag` object:

```js
export function buildSkeletonRoads(map, timing = null) {
  const t = (label, fn) => {
    if (!timing) return fn();
    const t0 = performance.now();
    const r = fn();
    timing[label] = (timing[label] ?? 0) + (performance.now() - t0);
    return r;
  };

  t('pathfind', () => { ... });
  t('compact',  () => { ... });
  t('bridges',  () => { ... });
}
```

`PipelineProfiler` could then pass a `timingBag` to each step and include sub-step breakdowns in its output. This is optional — the per-tick granularity is usually sufficient to identify which step to investigate.

---

## Notes

- **`performance.now()`** is available in both Node and Bun without import. In test environments, `globalThis.performance` may need to be polyfilled — check before running in Jest/Vitest contexts.
- **Cold start**: the first city in a batch will be slower due to JIT warm-up. Discard the first result or run a warm-up city (any seed) before the timed batch.
- **GC noise**: large grids allocate a lot. If results are noisy, run with `--expose-gc` and call `gc()` before each city to normalise GC pressure between runs. In Bun: `Bun.gc(true)`.
- **Regional generation is not timed**: `generateRegion` runs once per seed before the city loop. It is not part of the city pipeline performance. If you also want regional timings, wrap the `generateRegion` call in its own `performance.now()` block separately.
