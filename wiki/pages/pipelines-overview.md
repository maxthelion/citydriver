---
title: "Pipelines Overview"
category: "pipeline"
tags: [pipeline, regional, city, archetypes, overview, generator, hooks]
summary: "How the regional and city generation pipelines work after the pipeline refactor: generator-based, hook-driven, with named steps at every level."
last-modified-by: user
---

## Overview

The generator runs two main pipelines in sequence.

1. The **regional pipeline** builds a complete landscape: terrain, rivers, roads, railways, settlements.
2. The **city pipeline** zooms into one settlement, inherits regional data, and grows the city through a sequence of named steps driven by the settlement's [[city-archetypes|archetype]].

Both pipelines produce grids and graph structures. The city pipeline is implemented as a JavaScript generator with a `PipelineRunner` executor — every step has a stable string ID and can be hooked, timed, or inspected individually.

---

## Regional Pipeline

Generates the full 128×128-cell regional map from a seed. Each phase enriches a shared `LayerStack`. See [[regional-pipeline]] for the full breakdown.

| Phase | Summary |
|-------|---------|
| A0/A0b | Tectonic plates + river corridor planning |
| A2 | Terrain from layered noise + geology + corridor depression |
| A3 | River networks, valley carving, floodplains |
| A4 | Coastline erosion (bays, headlands, harbours) |
| A6 | Settlements, farms, market towns (feedback loop with roads) |
| A7 | Terrain-aware A* road network |
| A8 | Off-map cities and railway routing |

---

## City Pipeline

Takes a regional `LayerStack` and a settlement, extracts a 1200×1200-cell window at 5m resolution, and generates the city through a generator-based pipeline.

### Architecture

```
LandFirstDevelopment.tick()
  └── PipelineRunner.advance()
        └── cityPipeline(map, archetype)  ← generator
              yields step('skeleton',   fn)
              yields step('land-value', fn)
              ...
              yields* organicGrowthPipeline(map, archetype)
              yields step('connect',    fn)
```

`LandFirstDevelopment` is a thin wrapper — it calls `runner.advance()` once per `tick()`. `cityPipeline` is a generator that yields step descriptors `{ id, fn }`. The runner executes `fn()`, fires hooks, and advances.

**Hook system:** attach timing, invariant checks, or bitmap loggers without touching pipeline code:

```js
strategy.runner.addHook({
  onAfter(stepId, result, ms) {
    timingLog.push({ stepId, ms });
    if (stepId === 'zones') checkInvariants(map);
  }
});
```

### Step Sequence

| Step ID | What it does |
|---------|-------------|
| `setup` | Region inheritance, terrain refinement, nucleus placement (pre-runner) |
| `skeleton` | Arterial network via MST + A* pathfinding; writes `roadGrid`, planar graph |
| `land-value` | Nucleus-aware land value: flatness + proximity + water bonus |
| `zones` | Extract development zones as **graph faces** (first pass, coarse) |
| `zone-boundary` | Add collector roads along zone polygons → splits large zones into finer parcels |
| `zones-refine` | Re-extract zones after new roads; finer faces now visible in graph |
| `spatial` | Centrality, waterfrontness, edgeness, road frontage, downwindness |
| `growth-N:influence` | BFS blur reservation → proximity gradients; agriculture retreat |
| `growth-N:value` | Compose per-agent value bitmaps from spatial + influence layers |
| `growth-N:ribbons` | Throttled ribbon layout into high-value zones (Phase 2.5) |
| `growth-N:allocate` | Agent allocation loop (blob / frontage / ribbon allocators) |
| `growth-N:roads` | Grow roads from ribbon gaps; agriculture fill |
| `connect` | Connect zone spines to skeleton; full connectivity check |

For archetypes without organic growth config, `growth-N:*` is replaced by `reserve` → `ribbons`.

The growth loop runs N = 1, 2, … until all agent budgets are exhausted or `maxGrowthTicks` is reached.

### Zone Extraction

Zones are extracted as **planar graph faces** (`PlanarGraph.facesWithEdges()`), not bitmap flood-fills. Each zone has:
- `cells` — rasterized grid cells
- `polygon` / `boundingEdgeIds` / `boundingNodeIds` — topological references
- `centroid`, `avgSlope`, `slopeDir`, `avgLandValue`

The two-pass extraction (`zones` → `zone-boundary` → `zones-refine`) ensures that zone boundary roads are reflected in the face graph before growth begins.

### Terrain Face Streets

Within each zone, `layoutRibbons` calls `segmentZoneIntoFaces` to split the zone into terrain faces (groups of cells with consistent slope direction and steepness). Each face gets its own ribbon orientation. A flat face gets a regular grid; a sloped face gets contour-following streets.

### Street Connectivity

After ribbon layout, two connectivity mechanisms fire:
1. **T-junction splitting** — cross street endpoints that land on a parallel street edge split that edge, creating a proper graph junction.
2. **Full connectivity check** (`connectToNetwork`) — disconnected local-road components are connected to the nearest skeleton node via pathfinding.

---

## Archetypes

Each settlement is scored against all archetypes; the best fit is selected. The archetype controls:
- Growth agent budgets and priorities
- Ribbon street density
- Value layer composition weights
- Whether organic growth or simple reservation runs

| Archetype | Key trait | Growth path |
|-----------|-----------|-------------|
| `marketTown` | Medieval organic town | Organic growth (8 ticks) |
| `portCity` | Waterfront-driven | Simple reservation |
| `gridTown` | Colonial planned grid | Simple reservation |
| `industrialTown` | Single-industry dominated | Simple reservation |
| `civicCentre` | Cathedral/university city | Simple reservation |

Only `marketTown` currently uses the organic growth pipeline. Planned and Haussmann growth strategies are described in [[pipeline-abstraction]] but not yet implemented.

---

## Pipeline Integrity

Three layers of invariant checking run as `PipelineRunner` hooks:

- **Bitmap invariants** — single grid pass after every step: `noRoadOnWater`, `noZoneOnWater`, `noResOutsideZone`, `bridgesOnlyOnWater`
- **Polyline invariants** — road structure: no degenerate roads, no out-of-bounds points, graph/network agreement, no orphan nodes
- **Block invariants** — zone structure: no stale edge refs (checked at extraction steps), no cell overlaps

See [[pipeline-invariant-tests]] for the integration test suite.

---

## Benchmarking

The pipeline exposes per-step timing via hooks. `scripts/benchmark-pipeline.js` runs many cities and aggregates per-step statistics:

```bash
# All settlements, auto-select archetype
bun scripts/benchmark-pipeline.js --seeds 42,100,255,999

# Force organic growth path for all cities
bun scripts/benchmark-pipeline.js --seeds 42,100,255 --archetype marketTown

# Measure only skeleton step
bun scripts/benchmark-pipeline.js --seeds $(seq -s, 1 20) --stop-after skeleton
```

Output: per-city timings + aggregate (mean/p50/p95/p99/max) per step, plus growth phase totals across all ticks. See [[pipeline-performance]] for interpretation.

---

## Related Docs

| Doc | Content |
|-----|---------|
| [[city-generation-pipeline]] | Detailed step-by-step description of the city pipeline |
| [[pipeline-abstraction]] | PipelineRunner design, generator composition, strategy registry |
| [[pipeline-invariant-tests]] | Integration test strategy for bitmap/polyline/block invariants |
| [[pipeline-performance]] | Benchmark script, how to read results, what to look for |
| [[pipeline-observability]] | Hook-based bitmap tracing and comparative views |
| [[regional-pipeline]] | Regional pipeline phase-by-phase breakdown |
| [[land-reservation]] | Detailed doc on organic growth agent allocation |
| [[terrain-face-streets]] | Per-face ribbon layout algorithm |
| [[city-archetypes]] | Archetype descriptions and selection criteria |
