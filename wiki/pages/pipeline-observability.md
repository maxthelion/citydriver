---
title: "Pipeline Observability"
category: "observability"
tags: [debugging, bitmaps, pipeline, tracing, comparison]
summary: "Two modes for understanding what the bitmap pipeline is doing: historical tracing through a single run, and side-by-side comparison across alternative pipelines."
last-modified-by: user
---

## Overview

The city generation pipeline transforms spatial data through many steps, each reading and writing bitmap layers. When something goes wrong — or when we want to compare approaches — we need to see what happened at each step without relying on the interactive debug screen.

Two main scenarios:

## 1. Historical Trace

**Question:** "What changed at each step when I ran this pipeline with these inputs?"

Given a seed, city archetype, and pipeline configuration, capture every bitmap that changes at each pipeline step. The output is a sequential log of labelled bitmaps showing the evolution of the city from setup through to final reservations.

**Use cases:**
- Diagnosing why a specific city looks wrong ("when did the commercial zone lose its road connection?")
- Understanding which step introduced a problem
- Seeing the cumulative effect of growth ticks
- Verifying that a code change doesn't alter earlier pipeline steps

**What gets logged:**
- Step name and tick number
- Which layers were read and which were written
- The bitmap state of each written layer after the step completes
- Timing information

## 2. Comparative View

**Question:** "How do two alternative pipelines differ at the same stage for the same input?"

Run two (or more) pipeline variants on the same seed and settlement, and compare their outputs at equivalent stages. This is the offline equivalent of the [[debugging-cities|Compare Archetypes]] screen but more flexible — it can compare any pipeline variation, not just archetypes.

**Use cases:**
- Comparing how different [[city-archetypes|archetypes]] reserve land for the same geography
- Testing parameter changes (e.g. different affinity weights, radius steps, footprint sizes)
- A/B testing pipeline algorithm changes
- Evaluating whether a refactor produces equivalent output

**What gets logged:**
- The variant name/label for each run
- Matching step names so outputs can be aligned side by side
- Difference maps highlighting where two variants diverge

## Current Implementation

### BitmapLogger (`src/core/bitmapLogger.js`)

A utility class that pipeline steps call to append labelled bitmap snapshots. Writes PPM images to a trace directory.

```js
import { BitmapLogger } from '../core/bitmapLogger.js';

const logger = new BitmapLogger('output/traces/seed-42-marketTown');
logger.log('setup', 'elevation', elevationGrid, 'terrain', 'Terrain after setup');
logger.log('tick-5', 'reservationGrid', resGrid, 'reservation', 'Growth tick 5');
logger.writeIndex();  // writes index.md listing all snapshots
```

**Methods:**
- `log(step, layerName, grid, palette, description)` — snapshot a single layer
- `logLayers(step, map, layerSpecs)` — snapshot multiple named layers from a FeatureMap
- `writeIndex()` — write a markdown index of all captured snapshots

**Palettes:** `heat` (blue→red), `gray`, `terrain` (green-brown), `mask` (binary blue/tan), `reservation` (categorical zone colours), `zone` (golden hue per zone ID). Continuous palettes auto-normalise to 0-1.

A `NullLogger` is also exported for when tracing is disabled — same interface, does nothing.

### Trace script (`scripts/trace-pipeline.js`)

Runs a full pipeline for a given seed/settlement/archetype and captures snapshots at every step.

```bash
bun scripts/trace-pipeline.js [seed] [gx] [gz] [archetype]
bun scripts/trace-pipeline.js 884469 27 95 marketTown
```

**Output structure:**

```
output/traces/seed-884469-marketTown/
  001-000-setup-elevation.ppm        — terrain
  002-000-setup-slope.ppm            — slope gradient
  003-000-setup-waterMask.ppm        — water mask
  004-000-setup-buildability.ppm     — initial buildability
  005-001-skeleton-roadGrid.ppm      — skeleton roads
  006-002-land-value-landValue.ppm   — land value
  007-003-zones-zoneGrid.ppm         — development zones
  008-004-spatial-layers-centrality.ppm
  009-004-spatial-layers-waterfrontness.ppm
  ...
  013-005-tick-5-reservationGrid.ppm — reservations after growth tick 1
  014-006-tick-6-reservationGrid.ppm — reservations after growth tick 2
  ...
  038-final-reservationGrid.ppm      — final state
  index.md                           — listing of all snapshots
```

Files are numbered sequentially so they sort correctly in any file browser.

### Render script (`scripts/render-reservations.js`)

Simpler single-output script — runs a pipeline and writes just the final reservation grid as an image.

```bash
bun scripts/render-reservations.js [seed] [gx] [gz] [maxTicks]
```

Writes to `output/reservations-seed{N}-tick{N}.ppm` with reservation type counts printed to console.

## Not Yet Implemented

### Comparative traces

Running two pipeline variants side by side and generating diff images. The trace directory structure supports this (variant name in the directory path), but no comparison script exists yet. To compare manually: run `trace-pipeline.js` with different archetypes and browse the output directories side by side.

### Pipeline-integrated logging

Currently tracing is done by the external scripts. The logger could be passed into pipeline functions so they log their own intermediate state (e.g. `computeLandValue` logging the flatness grid before and after blur). This would capture internal steps not visible from outside.

## Relationship to Existing Debug Tools

- The [[debugging-cities|debug screen]] is for interactive exploration of a single city
- The [[debugging-cities|compare archetypes screen]] is for live side-by-side viewing
- Pipeline observability is for **batch, offline analysis** — run a pipeline, inspect the trace later, compare variants without needing the browser open
