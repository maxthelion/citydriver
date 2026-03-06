# V5: Interactive Debug Viewer & Terrain Tuning

## Status: Implemented

## Motivation

V5's A*-based road growth produces spaghetti roads regardless of tuning. The fundamental problem: A* optimizing a complex cost function on a coarse grid can't produce the regular block patterns that make a city look like a city. Before designing a better growth algorithm, we need tooling to see what's happening at each pipeline stage.

The previous debug workflow (run `debug-city.js`, open static PNGs) was slow and opaque. We needed a live, interactive viewer embedded in the app where you can toggle layers, adjust opacity, and step through growth one tick at a time.

## What Was Built

### Interactive layer viewer (DebugScreen)

A new screen in the app, accessible via "Debug City" on the region screen. Runs the city setup phase in-browser and renders 9 composited layer canvases with live controls.

**Flow:** Region screen -> select settlement -> "Debug City" -> layer viewer with tick controls -> "Back" returns to region screen.

**Files created:**

| File | Purpose |
|------|---------|
| `src/ui/DebugScreen.js` | Screen class: builds DOM, renders layers to stacked canvases via ImageData, handles tick/reset/zoom |
| `src/city/interactivePipeline.js` | `setupCity()` extracts Phase 0 from the pipeline; `tickGrowth()` is a placeholder for the future growth algorithm |
| `src/rendering/layerRenderers.js` | 9 render functions, each producing a transparent RGBA buffer `{ data: Uint8Array, width, height }` |

**Files modified:**

| File | Change |
|------|--------|
| `src/main.js` | Added DebugScreen import and navigation (backToRegion handles both city and debug disposal) |
| `src/ui/RegionScreen.js` | Constructor accepts `{ onEnter, onDebug }` (backward-compatible). Added "Debug City" button |

### The 9 layers

| # | Name | Source | Rendering |
|---|------|--------|-----------|
| 1 | elevation | `cityLayers.getGrid('elevation')` | Colored heightmap, blue below sea level. Opaque base. |
| 2 | clusters | `nuclei[]` from `seedNuclei()` | Colored circles by type + labels (id, type, tier) |
| 3 | connections | `nuclei[]` + `roadGraph` | Dashed lines from each nucleus to nearest road node |
| 4 | arterials | `roadGraph` edges | Thick colored lines by hierarchy (white=arterial, yellow=collector, cyan=structural, grey=local) |
| 5 | rivers | `waterMask` + regional rivers | Blue water cells + river path polylines |
| 6 | available-land | elevation, waterMask, slope, occupancy | Green overlay on buildable cells |
| 7 | high-value | `terrainAttraction` from `terrainFields.js` | Yellow-red heat map |
| 8 | river-roads | (stub) | Will render river-following roads once the growth algorithm produces them |
| 9 | promenades | (stub) | Will render coastal setback roads once built |

### UI controls

- **Left sidebar:** Per-layer checkbox + opacity slider
- **Right panel:** Seed, tick count, per-nucleus population vs target, connected/disconnected status
- **Bottom bar:** Tick +1, Tick +10, Reset, seed input, zoom +/-
- **Keyboard:** Space/T = tick, Shift+T = tick 10, +/- = zoom, Esc = back
- **Mouse:** Scroll wheel zoom on canvas area

### Architecture decision: no server

The original plan used a Node HTTP server with `sharp` for PNG encoding. This was replaced with a pure in-browser approach: `layerRenderers.js` produces raw RGBA buffers, and `DebugScreen` writes them directly to canvases via `ImageData`. This avoids a separate dev server and integrates naturally into the existing app flow (RegionScreen -> DebugScreen).

## Terrain tuning

The debug viewer immediately revealed that the available-land and high-value layers were penalising terrain too heavily, leaving most of the map dark. Three changes were made:

### 1. Available-land slope threshold

**File:** `src/rendering/layerRenderers.js`

Raised from 0.15 to 0.3. The old threshold excluded moderate slopes that real cities routinely build on (San Francisco, Lisbon, etc.).

### 2. Terrain attraction scoring

**File:** `src/city/terrainFields.js` — `computeTerrainAttraction()`

| Slope range | Old bonus | New bonus |
|-------------|-----------|-----------|
| < 0.05 | +0.3 | +0.3 |
| 0.05 - 0.1 | +0.15 | +0.2 |
| 0.1 - 0.15 | 0 | +0.1 |
| 0.15 - 0.2 | -0.3 (penalty) | +0.1 |
| 0.2 - 0.3 | -0.3 (penalty) | -0.1 |
| > 0.3 | -0.3 (penalty) | -0.3 |

With a base of 0.3, moderate hills (slope 0.1-0.2) now score 0.3-0.4 instead of 0.0. Only truly steep terrain (>0.3) gets zeroed out.

### 3. Nuclei count and placement

**File:** `src/city/seedNuclei.js`

**Problem:** Two issues compounding. Regional satellites had no cap (seed 42 produced 39 nuclei — every hamlet/farm in the city bounds). And the niche-fill only triggered when nuclei < 3, capping at 6.

**Fix:**

- Total nuclei capped by settlement tier: 12 (tier 1), 8 (tier 2), 6 (tier 3)
- Regional satellites sorted by tier (important ones first) before adding, respecting the cap
- Niche-fill always runs if under the cap (was: only if < 3)
- Niche site slope threshold raised from 0.2 to 0.3
- Niche scoring rebalanced: 50% distance + 50% slope factor (was multiplicative, which collapsed to near-zero on any slope)

**Result across test seeds (all tier 1):**

| Seed | Before | After |
|------|--------|-------|
| 42 | 39 (uncapped satellites) | 12 |
| 7 | 3 (niche fill barely triggered) | 11 |
| 99 | 5 | 12 |
| 123 | 36 (uncapped satellites) | 12 |
| 777 | 8 | 12 |

### 4. Available-land gradient rendering

**File:** `src/rendering/layerRenderers.js` — `renderAvailableLandLayer()`

**Problem:** The original layer was binary — green if slope < threshold, invisible otherwise. On steep terrain (e.g. seed 224694, a tier-3 mountain village where 72% of cells have slope > 0.3) the layer showed almost nothing useful.

**Fix:** Replaced with a gradient showing buildability by slope band:

| Slope | Color | Meaning |
|-------|-------|---------|
| < 0.1 | Bright green | Flat, easy to build |
| 0.1 - 0.2 | Yellow-green | Moderate, buildable |
| 0.2 - 0.3 | Orange | Difficult but possible |
| 0.3 - 0.5 | Dim red | Marginal |
| > 0.5 | Nothing | Unbuildable |
| Occupied | Dim blue | Already has roads/plots |

This makes the layer useful even on steep terrain — flat valleys and ridgelines are clearly visible against the gradient of increasingly difficult slopes.

## Known Issues

### River rendering: zigzag lines instead of smooth variable-width paths

The rivers layer (`renderRiversLayer` in `layerRenderers.js`) has two problems:

**1. Zigzag paths, not curves.** The renderer draws straight line segments between regional grid points (50m spacing). At city resolution (10m cells, typically 2-4x zoom) these appear as harsh zigzags rather than natural curves. The fix is to apply Chaikin subdivision or Catmull-Rom smoothing to the river polylines before rendering.

**2. Fixed width, should vary by flow.** Rivers are drawn as uniform 2px lines regardless of size. They should be rendered as filled paths whose width grows with downstream accumulation — narrow headwater streams widening to broad rivers. Each river cell already carries an `accumulation` field (from `generateHydrology.js`) that measures upstream catchment area.

**Reference implementation:** `src/rendering/waterMesh.js` already solves both problems for the 3D view:
- `chaikinSmooth()` (lines 5-27) smooths `{x, z, accumulation}` polylines via corner-cutting
- Width is `max(1.5, min(25, sqrt(accumulation) / 8))` per point (line 122)
- A ribbon mesh is built with perpendicular offsets at each point (lines 130-140)

The debug viewer's 2D river renderer should use the same approach: smooth the polyline, then for each segment draw a filled trapezoid (or thick line) whose width is derived from accumulation. The width formula may need adjustment for pixel scale (the 3D version uses world units).

### URL deep-link

The debug viewer now encodes `?mode=debug&seed=X&gx=Y&gz=Z` in the URL. Refreshing the page regenerates the region from the seed and reopens the debug viewer at the same settlement. The `gx`/`gz` params identify the settlement by nearest match.

## What's Next

The `tickGrowth()` function in `interactivePipeline.js` is a placeholder. The next step is to design a growth algorithm that produces regular block patterns visible through the debug viewer. Candidates:

- **Template stamping:** Place pre-defined block templates (grids, radial fans) aligned to arterials, rather than pathfinding individual roads
- **Voronoi-based blocks:** Subdivide the space between arterials into blocks using Voronoi cells seeded along road segments
- **Constraint-based grid projection:** Project a regular grid from each nucleus, warped by terrain contours, clipped by water/steep slopes

The debug viewer's tick-by-tick stepping and layer compositing will make it possible to evaluate these approaches visually as they're developed.
