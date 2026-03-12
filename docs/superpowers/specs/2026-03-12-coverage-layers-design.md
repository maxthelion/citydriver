# Unified Coverage Layer System

## Status: Proposed

## Problem

Cell-based features (forests, water, roads, development zones) produce visible stair-stepped boundaries at the 5m city grid resolution. Each feature currently handles its own smoothing inconsistently:

- **Development proximity** — box blur with 8-cell radius, the only properly smoothed layer
- **Forest/land cover** — bilinear interpolation of regional 50m cells, plus separate forestStrength noise and stochastic thinning against dev proximity
- **Water/coastline** — binary waterMask, no smoothing at all
- **Roads** — polylines are Chaikin-smoothed but the roadGrid stamp is binary

This produces boxy edges on forests, coastlines, and development zones. Adding new features that depend on transition zones (e.g. beaches) requires ad-hoc solutions each time.

## Design

### Core Concept

Create a set of continuous float layers on the city grid that replace raw cell lookups for rendering. Each layer is produced by: **stamp → blur → noise → clamp**. Layers interact via priority suppression so they don't overlap nonsensically.

This is the visual counterpart to the bitmap pipeline (specs/v4/archive/bitmap-pipeline.md), which unified buildability and pathCost for the simulation side. This system unifies the rendering side.

### Layers

| Layer | Source data | Blur radius | Priority | Notes |
|-------|-----------|-------------|----------|-------|
| `water` | waterMask (binary) | ~6 cells (30m) | 1 (highest) | Transition zone = beach |
| `road` | roadGrid (binary) + buffer | ~3 cells (15m) | 2 | Smooth pavement-to-grass |
| `development` | zone cells + regional settlement (landCover=5) | ~8 cells (40m) | 3 | Replaces `_devProximity` |
| `forest` | landCover=2,6 from regional | ~4 cells (20m) | 4 | Replaces bilinear land cover + forestStrength |
| `landCover` | other regional cover types | ~4 cells (20m) | 5 (lowest) | Moorland, scrub, farmland |

Each layer is a `Float32Array` at city grid resolution (5m cells).

### Pipeline Per Layer

1. **Stamp** — fill values from source data onto the city grid. For layers sourced from the regional grid (forest, landCover), use **nearest-neighbor lookup** (each city cell queries its regional cell and stamps 0 or 1). The blur step handles smoothing — bilinear pre-interpolation would muddy the signal before the blur has a chance to shape it.
2. **Blur** — separable box blur (same technique as existing `_buildDevelopedProximity`)
3. **Noise** — perturb with deterministic hash noise. Amplitude scaled by `base_amplitude * 4 * v * (1 - v)` where `v` is the pre-noise value — parabolic scaling that goes to zero at both extremes (cells fully inside or fully outside a feature stay stable, edges get the most displacement).
4. **Clamp** — back to [0, 1]

### Priority Suppression

After all layers are individually blurred and noised, a single pass enforces priority:

```
available = 1.0
for each layer in priority order (water, road, development, forest, landCover):
    layer[cell] = min(layer[cell], available)
    available -= layer[cell]
    available = max(0, available)
```

Higher-priority layers claim space first. A cell that's 0.6 water can only be 0.4 everything else combined. Beaches emerge naturally where water is ~0.2–0.5 — there's "room" for sand in the remaining budget.

### Consumer Changes

**`_buildTerrain()` — ground coloring:**
- Reads coverage layers instead of doing its own bilinear regional interpolation
- Each layer has an associated color; final terrain color is a weighted blend: `color = water_color * water + road_color * road + dev_color * development + forest_color * forest + landCover_color * landCover + grass_color * remaining`. The `remaining` term (1 - sum of all layers) gets the base grass color.
- `water` transition zone (0.1–0.5) blends toward sand/beach color
- `road` layer is for **ground coloring only** (pavement apron around road meshes), not replacing the road ribbon mesh
- `development` drives grass→urban tone (replaces `_devProximity` read)
- `forest` drives green tinting intensity
- `landCover` layer: at each city cell, the dominant regional cover type (moorland, scrub, farmland, bare rock) determines which color the float value blends toward

**`_buildTrees()` — forest placement:**
- Tree density scales directly with `forest` layer value
- `forest=0.8` → full canopy, `0.3` → scattered, `< 0.1` → none
- No separate dev proximity check — development suppression already encoded in the forest layer via priority interaction

**`_buildWater()` — water surface and beaches:**
- Water mesh threshold at `water > 0.5` instead of binary waterMask
- Transition zone (0.1–0.5) identifies beach/shore areas for ground coloring

**Debug layers:**
- Each coverage layer directly visualizable as a heatmap

### Pipeline Position

Runs at the same point as `_buildDevelopedProximity()` currently — during CityScreen setup, after all source data (waterMask, roadGrid, zone cells, regional landCover) is available. Coverage layers computed once and stored on the CityScreen instance.

### What Gets Deleted

- `_buildDevelopedProximity()` — absorbed into the layer system
- Inline bilinear land cover interpolation in `_buildTerrain()`
- Separate `forestStrength` noise calculation in `_buildTerrain()`
- Per-cell `dev > 0.5` / stochastic thinning logic in `_buildTrees()`

### New Module

`src/city/coverageLayers.js` — contains:
- Layer definitions (source, blur radius, priority)
- `computeCoverageLayers(cityLayers, regionalLayers, ...)` → returns object of named Float32Arrays
- Reusable `separableBoxBlur(grid, width, height, radius)` utility (extracted from `_buildDevelopedProximity`)
- `applyHashNoise(grid, width, height, amplitude, seed)` utility
- `enforcePriority(layers, width, height)` — the top-down suppression pass

## Files

| Action | File | Change |
|--------|------|--------|
| New | `src/city/coverageLayers.js` | Layer computation: stamp, blur, noise, priority |
| Edit | `src/ui/CityScreen.js` | Replace `_buildDevelopedProximity` call with `computeCoverageLayers`; update `_buildTerrain` and `_buildTrees` to read layers |
| Edit | `src/rendering/debugLayers.js` | Add coverage layer heatmap visualizations |
| New | `test/city/coverageLayers.test.js` | Unit tests for blur, noise, priority suppression |
