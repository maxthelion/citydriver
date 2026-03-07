# River Model Spec

## Overview

Rivers are generated at the regional level (50m cells) via flow
accumulation and stream extraction, then refined at the city level (10m
cells) with smoothed vector paths and detailed channel carving.

The **vector path** (with width + curves) is created at the regional
level and is the single source of truth. City refines it with higher
resolution. All downstream systems (carving, buildability, pathcost)
derive from the path.

Shared geometry functions live in `src/core/riverGeometry.js`.

## River width model

River width scales consistently everywhere via one canonical function:

```
halfWidth(accumulation) = clamp(sqrt(accumulation) / 8, 1.5, 25)
```

This gives:
- acc=50 (small stream): halfWidth 1.5m (minimum), fullWidth 3m
- acc=200 (stream): halfWidth 1.8m, fullWidth 3.5m
- acc=800 (river): halfWidth 3.5m, fullWidth 7m
- acc=5000 (major river): halfWidth 8.8m, fullWidth 17.7m
- acc=40000 (huge river): halfWidth 25m (cap), fullWidth 50m

Source: `riverGeometry.js:riverHalfWidth()`.

## River depth model

### Cross-section profile

Rivers have a smooth cross-section defined by normalized distance from
the centerline (`nd = distance / halfWidth`):

```
nd < 0.6:       deep channel (full depth)
nd 0.6 - 1.0:   bank slope (ramps from full to 30% depth)
nd 1.0 - 1.5:   gentle bank (ramps from 30% to 0)
nd > 1.5:       no modification
```

Source: `riverGeometry.js:channelProfile()`.

### Max depth

Max channel depth scales with river width:

```
maxDepth = clamp(1.5 + halfWidth / 15, 1.5, 4.0)
```

Source: `riverGeometry.js:riverMaxDepth()`.

### Regional vs city carving

| Level | Purpose | Depth | Width |
|-------|---------|-------|-------|
| Regional | Guide flow routing, plausible elevation | Mild: 0.3-1.2m | Canonical halfWidth (via shared profile) |
| City | Detailed channel for rendering, buildability | Full profile: 1.5-4m | Canonical halfWidth |

Both levels use `channelProfile()` for consistent cross-sections.
Regional carving is intentionally shallow.

**Design rule**: Regional carving should never produce artifacts visible
at city scale. If it does, reduce regional carving further.

## Pipeline

```
REGIONAL (50m cells)
  1. generateHydrology.js
     a. fillSinks — ensure drainage to edges
     b. computeFlowDirections — D8 routing
     c. computeFlowAccumulation — upstream cell count
     d. extractStreams — trace river segments
     e. smoothRiverPaths — sinusoidal meanders
     f. segmentsToVectorPaths — create vector paths with width    ← SSoT
     g. carveFloodplains — mild carving via shared channelProfile
     h. paintPathsOntoWaterMask — waterMask from paths (not raw cells)
     → Output: rivers (tree), riverPaths (vector), elevation, waterMask

CITY EXTRACTION (50m → 10m)
  2. extractCityContext.js
     - Bilinear interpolation of elevation
     - Copy regionalRiverPaths for city import

CITY (10m cells)
  3. importRivers.js
     a. Receive regional riverPaths (already smoothed with width)
     b. Clip to city bounds + coordinate transform
     c. Additional Chaikin pass for 10m resolution
     d. Paint onto waterMask
     → Output: riverPaths (city-local vector), updated waterMask

  4. classifyWater.js
     - Categorize: land / sea / lake / river

  5. refineTerrain.js
     a. Add Perlin noise detail
     b. Recompute slope
     c. computeRiverDistanceGrid — per-cell distance to centerline
     d. carveRiverChannels — via shared channelProfile + riverMaxDepth
     → Output: carved elevation, riverDist grid

  6. buildability.js
     - Computed once from terrain (including riverDist for soft gradient)
     - Deep channel: unbuildable (0)
     - River edge (nd 0.8-1.0): marginal (0-0.15)
     - Dry land: normal scoring with waterfront bonus
     - Incrementally updated: stamp operations zero affected cells
```

## Data flow

```
                    accumulation
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
        regional     river path   river width
        carving      smoothing    (canonical)
        (shared      (Chaikin)    (riverHalfWidth)
        profile)
              │          │          │
              ▼          ▼          ▼
        regional    riverPaths (vector, SSoT)
        elevation        │
              │     ┌────┴────┐
              ▼     ▼         ▼
        city     city-local  waterMask
        elevation paths      (painted from paths)
              │     │
              ▼     ▼
        channel carving (shared channelProfile + riverMaxDepth)
              │
              ▼
        buildability (soft gradient from riverDist)
```

## Shared module: `src/core/riverGeometry.js`

| Function | Purpose |
|----------|---------|
| `riverHalfWidth(acc)` | Half-width in world units from accumulation |
| `riverMaxDepth(hw)` | Max channel depth from half-width |
| `channelProfile(nd)` | Cross-section profile: normalizedDist → depthFraction |
| `chaikinSmooth(pts, iter)` | Corner-cutting polyline smoothing |
| `segmentsToVectorPaths(roots, cellSize, opts)` | Convert segment tree to vector paths |
| `paintPathsOntoWaterMask(mask, paths, ...)` | Paint paths onto grid |

## Files

| File | River responsibility |
|------|---------------------|
| `src/core/riverGeometry.js` | Shared width, depth, profile, smoothing, path conversion |
| `src/core/flowAccumulation.js` | Stream extraction, flow routing |
| `src/regional/generateHydrology.js` | Regional pipeline, vector paths, mild carving |
| `src/city/extractCityContext.js` | Copy regionalRiverPaths to city |
| `src/city/importRivers.js` | Clip/transform paths, subdivide, paint waterMask |
| `src/city/refineTerrain.js` | Centerline distance grid, channel carving (shared funcs) |
| `src/city/classifyWater.js` | Water type classification |
| `src/city/buildability.js` | Soft river-edge gradient |
| `src/rendering/waterMesh.js` | River ribbon meshes (shared width/smoothing) |

## Open issues

1. **River depth not accounting for geology**: Hard rock should produce
   narrow deep gorges; soft rock should produce wide shallow channels.

2. **No meanders**: Rivers follow D8 flow directions which are
   inherently grid-aligned. Chaikin smoothing helps but the underlying
   path is still blocky.

3. **Endorheic basins**: Rivers that should terminate in inland lakes
   are currently routed to map edges by `fillSinks`. Deferred.
