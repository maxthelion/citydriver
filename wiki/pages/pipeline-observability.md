---
title: "Pipeline Observability"
category: "observability"
tags: [debugging, bitmaps, pipeline, tracing, hooks]
summary: "How to observe the city pipeline using PipelineRunner hooks: timing, bitmap snapshots at every step, and invariant checking."
last-modified-by: user
---

## Overview

All observability is delivered via `PipelineRunner` hooks. Every named step (`skeleton`, `growth-3:value`, `connect`, etc.) fires `onBefore` and `onAfter` on every attached hook. This means timing, bitmap snapshots, and invariant checks all attach the same way — no changes to pipeline code.

```js
strategy.runner
  .addHook(timingHook)
  .addHook(bitmapSnapshotHook)
  .addHook(invariantHook);
```

---

## Hook Interface

```js
strategy.runner.addHook({
  onBefore(stepId) { /* fires before fn() */ },
  onAfter(stepId, result, ms) { /* fires after fn(); ms = wall-clock time */ },
});
```

Both methods are optional. Multiple hooks can be attached; they fire in attachment order.

---

## 1. Timing

See [[pipeline-performance]] for the full benchmark approach. The short version:

```js
const timings = [];
strategy.runner.addHook({
  onAfter(id, _, ms) { timings.push({ id, ms }); }
});
while (strategy.tick()) {}

// timings: [{ id: 'skeleton', ms: 380 }, { id: 'land-value', ms: 58 }, ...]
```

`scripts/benchmark-pipeline.js` runs this across many seeds and settlements and aggregates per-step statistics.

---

## 2. Bitmap Snapshots

`BitmapLogger` (`src/core/bitmapLogger.js`) writes PPM images to a trace directory. Use it in a hook to capture any layer at any step:

```js
import { BitmapLogger } from '../src/core/bitmapLogger.js';

const logger = new BitmapLogger('output/traces/seed-42');

strategy.runner.addHook({
  onAfter(stepId) {
    if (stepId === 'zones') {
      logger.log(stepId, 'zoneGrid',        map.getLayer('zoneGrid'),        'zone');
    }
    if (stepId === 'growth-3:allocate') {
      logger.log(stepId, 'reservationGrid', map.getLayer('reservationGrid'), 'reservation');
      logger.log(stepId, 'roadGrid',        map.getLayer('roadGrid'),        'mask');
    }
  }
});

while (strategy.tick()) {}
logger.writeIndex();
```

**Palettes:** `heat` (blue→red), `gray`, `terrain`, `mask` (binary), `reservation` (zone colours), `zone` (per-zone ID).

`scripts/trace-pipeline.js` runs a complete trace for a given seed/settlement and captures key layers at every step.

---

## 3. Invariant Checking

The three invariant modules (`bitmapInvariants`, `polylineInvariants`, `blockInvariants`) attach as hooks and fire after every step. See [[pipeline-invariant-tests]] for the integration test that uses them.

Quick example for ad-hoc invariant checking during development:

```js
import { makeBitmapInvariantHook } from '../src/city/invariants/bitmapInvariants.js';

strategy.runner.addHook(
  makeBitmapInvariantHook(map, (stepId, name, count) => {
    console.warn(`INVARIANT FAIL at ${stepId}: ${name} = ${count} violations`);
  })
);
```

---

## Stopping at a Step

`PipelineRunner` advances one step at a time. To stop after a specific step:

```js
strategy.runner.addHook({
  onAfter(id) {
    if (id === 'growth-3:influence') {
      // Inspect map.getLayer('reservationGrid'), map._influenceLayers, etc.
      // Just don't call strategy.tick() again.
    }
  }
});

// Run until stopped manually
let steps = 0;
while (strategy.tick() && steps++ < 20) {}
```

This is the primary debugging use case: stop at `growth-3:influence` and inspect value layers before allocation runs.

---

## Relationship to Debug Tools

| Tool | Mode | What you see |
|------|------|-------------|
| Debug screen (`/debug`) | Interactive | Step-by-step in the browser |
| Compare archetypes screen (`/compare`) | Interactive | Side-by-side archetype comparison |
| `trace-pipeline.js` | Offline batch | Bitmap snapshots at every step → PPM files |
| `benchmark-pipeline.js` | Offline batch | Per-step timings across many cities |
| Invariant hooks | CI / development | Constraint violations caught at introducing step |

The interactive tools are for exploration. The offline scripts are for analysis, regression detection, and understanding edge cases without needing the browser.
