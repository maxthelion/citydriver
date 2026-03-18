---
title: "Bitmap Invariants"
category: "testing"
tags: [testing, invariants, bitmaps, grids, pipeline]
summary: "Grid-level invariants that must hold at every pipeline step, and the relationships between bitmap layers."
last-modified-by: user
---

## Overview

The generator produces multiple grid layers (bitmaps) that represent terrain, water, roads, railways, buildings, and land use. These layers have invariant relationships — a cell that is water cannot also be a road, a building cannot sit on a railway, etc. Violations indicate pipeline bugs where one step produces output that contradicts another.

These invariants should be checked **at every pipeline step**, not just at the end. A violation introduced at step 3 is much easier to diagnose when caught at step 3 than when it causes a rendering glitch at step 7.

## Layer Relationships

### Exclusion Rules (cells MUST NOT overlap)

| Layer A | Layer B | Rule |
|---------|---------|------|
| waterMask | roadGrid | No roads in water (bridges are separate) |
| waterMask | railwayGrid | No railways in water (bridges recorded separately) |
| waterMask | buildingGrid | No buildings in water |
| railwayGrid | buildingGrid | No buildings on railway tracks |
| roadGrid | buildingGrid | No buildings on skeleton/collector roads |

### Derivation Rules (layer B is derived from layer A)

| Source | Derived | Rule |
|--------|---------|------|
| road polyline | roadGrid | Grid is stamped by walking the polyline — they always agree |
| railway polyline | railwayGrid | Grid is stamped by walking the polyline — they always agree |
| river polyline | waterMask (river cells) | River channel carved from polyline, waterMask updated |
| roadGrid / railwayGrid | buildability | Cells with road or railway have buildability = 0 |
| elevation + seaLevel | waterMask (sea cells) | Cells below sea level are water |

### Consistency Rules (cross-layer constraints)

| Rule | Layers involved |
|------|----------------|
| Station on dry land | station position → waterMask = 0 |
| Station near railway | station position → railwayGrid > 0 within 3 cells |
| Railway elevation is smooth | railwayGrid cells sorted by path distance → elevation change ≤ maxGradient × cellSize per step |
| Entry elevations above sea level | railway entry points → elevation > seaLevel |
| Nuclei on buildable land | nuclei positions → buildability > 0.2 |
| Development zones on buildable land | zone cells → buildability > threshold |
| Land reservation within zones | reservationGrid cells → zoneGrid > 0 |

## Regional Pipeline Invariants

Checked after each phase of `generateRegion`:

| After Phase | Invariant |
|-------------|-----------|
| A2 (terrain) | Elevation is finite, within reasonable range |
| A3 (hydrology) | waterMask cells have elevation ≤ seaLevel (for sea/lake) |
| A6 (settlements) | Settlement positions are on buildable land (not water, not cliff) |
| A7 (roads) | Road cells are not water cells (except bridges) |
| A8 (railways) | Railway cells are not water cells; off-map cities on inland edges |
| A5 (land cover) | Land cover values are valid enum (1-8) |

## City Pipeline Invariants

Checked after each tick of city generation:

| After Step | Invariant |
|------------|-----------|
| Tick 0 (setup) | waterMask ∩ roadGrid = ∅; waterMask ∩ railwayGrid = ∅; station on dry land; railway elevation is smooth; nuclei on buildable land |
| Tick 1 (skeleton roads) | New road cells ∩ waterMask = ∅ (except bridges); road polylines match roadGrid |
| Tick 3 (zones) | Zone cells have buildability > threshold; zones don't overlap water |
| Tick 5 (reservation) | Reserved cells are within zones; reservation types are valid (1-4) |
| Tick 6 (ribbons) | Ribbon streets don't cross water; streets are within zones |
| After buildings | Building cells ∩ waterMask = ∅; building cells ∩ roadGrid = ∅; building cells ∩ railwayGrid = ∅ |

## Polyline-Grid Agreement

A critical invariant for roads and railways: **the grid must be derived from the polyline, never computed independently.** When both exist, every grid cell should be explainable by walking the polyline at fine intervals and stamping within the feature's width.

Violations happen when:
- The grid is stamped from a raw A* path and the polyline is a simplified version (they diverge)
- Two different code paths stamp the same grid (e.g. both routeCityRailways and FeatureMap._stampRailway write railwayGrid)
- Grading modifies terrain along a different path than what's rendered

The fix is always the same: **one source of truth** (the polyline), grid derived from it.

## Performance Considerations

Running bitmap invariant checks at every pipeline step on a 1200×1200 city grid (1.4M cells) across multiple seeds could be slow. Strategies:

- **Sampled checks** — check every Nth cell instead of all cells. Catches most violations with O(1/N) cost.
- **Region-only for CI** — full bitmap checks on the 128×128 regional grid (fast), sampled checks on city grid.
- **GPU acceleration** — invariant checks are embarrassingly parallel (per-cell independence). Could use WebGPU compute shaders for O(1) wall-clock invariant checking on the full grid. Each check is a simple kernel: `if (gridA[i] > 0 && gridB[i] > 0) atomicAdd(violations, 1)`.
- **Incremental checking** — only check cells modified by the most recent pipeline step, not the entire grid.

## Source Files

| File | Role |
|------|------|
| `test/city/routeCityRailways.test.js` | Railway bitmap invariant tests |
| `test/regional/pipeline.test.js` | Regional pipeline step tests |
