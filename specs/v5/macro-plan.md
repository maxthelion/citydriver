# Macro Plan

## Status: Active

Four sequential workstreams. Each creates the foundation the next one needs.

---

## 1. Road Network Refactor

**Goal:** Single authority for road mutations. Three representations (feature list, PlanarGraph, roadGrid) currently drift out of sync — roads removed from the feature list leave ghost corridors in the grid, growth-tick roads bypass the graph entirely, bridge splicing destructively mutates polylines.

**Key deliverables:**
- `Road` class — immutable polyline, bridges as a parametric first-class collection rather than in-place polyline splices
- `RoadNetwork` class — owns the feature list, graph, and roadGrid together; ref-counted cell stamping so removal correctly clears the grid; `addFromCells()` so growth roads get a proper identity
- `FeatureMap` wires through `RoadNetwork` with backward-compatible getters during migration

**Spec:** `specs/v5/road-network-abstraction.md`

**Status:** In progress — `Road` and `RoadNetwork` classes added, `FeatureMap` wired, `growRoads` updated.

---

## 2. Pipeline Refactor

**Goal:** Make the pipeline a reifiable concept rather than an implied state machine. Enable archetype-driven composition of growth strategies.

**Key deliverables:**
- `PipelineRunner` with a hook array — timing, logging, and invariant checks attach as hooks without modifying pipeline steps
- Generator-based pipeline — `cityPipeline`, `organicGrowthPipeline`, `plannedGrowthPipeline` as generator functions; `yield*` composes them; named `step(id, fn)` descriptors give every step an owned identity including sub-steps within growth ticks
- Strategy registry — archetype config selects growth strategy (`growthStrategy: 'organic' | 'planned'`) and skeleton strategy by name; strategies are composeable (shared sub-generators for influence/value phases)
- `LandFirstDevelopment` becomes a thin wrapper around `PipelineRunner`; its `_phase`/`_tick` state machine is replaced by generator control flow

**Spec:** `wiki/pages/pipeline-abstraction.md`

**Dependency:** Road refactor should land first — pipeline hooks will be used to validate road refactor invariants hold throughout the pipeline.

---

## 3. Benchmarking and Invariant Checking

**Goal:** Measure per-step performance across many seeds and settlements; check bitmap invariants at every named step automatically.

**Key deliverables:**
- Benchmarking as a `PipelineRunner` hook — `onAfter(id, _, durationMs)` replaces the `PipelineProfiler` wrapper class; works identically across all growth strategies
- `benchmark-pipeline.js` script — runs the full pipeline for all settlements in N regions, aggregates mean/p50/p95/p99/max per step, writes JSON
- Invariant checking as a `PipelineRunner` hook — fires after every named step; checks exclusion rules (water ∩ roads = ∅, etc.), derivation rules (roadGrid matches roads), consistency rules (nuclei on buildable land)
- CPU reference implementations of all invariants; these become the correctness baseline for GPU work in stage 4

**Specs:** `wiki/pages/pipeline-performance.md`, `wiki/pages/bitmap-invariants.md`

**Dependency:** Pipeline refactor must land first — hooks don't exist without `PipelineRunner`. Road refactor must land first — invariant checks on a grid with ghost corridors produce false positives.

---

## 4. GPU Bitmap Operations

**Goal:** Accelerate the hot bitmap operations identified by benchmarking. Likely candidates based on algorithmic structure:

| Operation | GPU fit | Notes |
|---|---|---|
| Influence layer computation (BFS blur) | Good — separable kernel | Per-cell, small radius |
| Value layer composition | Excellent — pure per-cell | Multiply-add with layer weights |
| Invariant checking | Excellent — embarrassingly parallel | Atomic counter per violation |
| Zone extraction (flood fill) | Harder — parallel BFS | Needs careful workgroup coordination |

**Key deliverables:**
- WebGPU compute shaders for influence/value layers inside growth ticks (highest tick count, most repeated work)
- CPU fallback for test environments where WebGPU is unavailable
- GPU invariant checking — same checks as CPU but as compute kernels; output should match CPU reference exactly during transition
- `RoadNetwork` grid access via method (not direct property) so grid backing can swap between CPU `Grid2D` and GPU buffer without changing callers

**Dependency:** Benchmarking identifies which operations to accelerate. Invariant checks provide the correctness harness to verify GPU output matches CPU.

---

## Dependency Graph

```
Road Network Refactor
        │
        ▼
Pipeline Refactor
        │
        ├──────────────────┐
        ▼                  ▼
  Benchmarking      Invariant Checking
        │                  │
        └──────────┬───────┘
                   ▼
          GPU Bitmap Operations
```

---

## What Each Stage Enables

| Stage | Immediately enables |
|---|---|
| Road refactor | Correct bitmaps; bridges as queryable data; growth roads in graph |
| Pipeline refactor | Hook-based benchmarking; per-sub-step invariant checks; planned growth strategy |
| Benchmarking | Identifies GPU targets; confirms pipeline refactor has no regressions |
| Invariant checking | GPU correctness harness; ongoing regression safety net |
| GPU ops | Performance for large cities and high-tick-count archetypes |
