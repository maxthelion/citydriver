# River Elevation Carving — Coarse-to-Fine Resolution Fix

## Problem

Rivers were carved into the elevation grid at regional resolution (50m
cells), then bilinearly interpolated to city resolution (10m cells). The
interpolated channels retained the blocky staircase shape of the coarse
grid. The city-level carving operated on the binary waterMask
(cell-by-cell), not the river's vector path, so the channel shape was
still rectangular. Buildability was binary (0 inside water, 1 outside),
creating hard edges in the path-cost bitmap.

## Root causes

1. **Regional carving too deep** — `carveFloodplains()` cut 0.8-3m
   channels at 50m resolution, baking coarse rectangular trenches into
   elevation before the city ever saw it.

2. **City carving used binary waterMask** — `refineTerrain.js` lowered
   cells by 1-3m based on water neighbor count, not distance from
   centerline. Same blocky shape, just at 10m cells.

3. **Buildability was binary at water boundary** — Every cell with
   `waterMask > 0` was identically unbuildable (score 0). No gradient
   from deep channel to bank to dry land.

## Implementation

### A. Reduced regional carving (`generateHydrology.js`)

Regional carving is now mild — just enough to guide flow routing:
- Channel depth: `min(1.2, sqrt(acc)/75 + 0.2)` — 0.3-1.2m (was 0.8-3m)
- Floodplain half-width: `min(2, floor(sqrt(acc)/30) + 1)` — 1-2 cells
  (was 1-4 cells)
- Blend factor reduced from 0.7 to 0.4

### B. Centerline distance grid (`refineTerrain.js`)

New `computeRiverDistanceGrid()` walks along each smoothed river path
(the vector data from `importRivers`) and computes per-cell:
- `dist`: world-unit distance to nearest centerline point
- `halfW`: river half-width at that closest point
- Normalized distance `nd = dist / halfW` (0 = center, 1 = edge)

This grid is stored as `cityLayers.setData('riverDist', ...)` for reuse
by buildability.

### C. Smooth channel cross-section (`refineTerrain.js`)

New `carveRiverChannels()` uses the distance grid for natural profiles:

```
nd < 0.6:       full depth (deep channel)
nd 0.6 - 1.0:   ramps from full to 30% depth (bank slope)
nd 1.0 - 1.5:   ramps from 30% to 0 (gentle bank)
nd > 1.5:       no modification
```

Max channel depth scales with river width: `min(4, 1.5 + halfWidth/15)`.
Wider rivers get deeper channels.

### D. Soft buildability gradient (`buildability.js`)

River cells now use the centerline distance for a gradient:
- `nd < 0.8`: unbuildable (score 0) — deep water
- `nd 0.8 - 1.0`: marginal (score 0 to 0.15) — river edge/bank
- Outside waterMask: normal buildability with waterfront bonus

Sea cells remain hard-unbuildable (no gradient needed).

## Files changed

- `src/regional/generateHydrology.js` — reduced `carveFloodplains()`
  depth and width
- `src/city/refineTerrain.js` — replaced waterMask-based carving with
  centerline-distance-based carving; computes and stores `riverDist`
  grid
- `src/city/buildability.js` — reads `riverDist` for soft gradient at
  river edges

## Design principle

Regional data provides structure (where rivers flow). City data provides
detail (channel shape, bank profiles, buildability gradients). The
coarse regional grid should never bake fine-grained terrain features
that become artifacts at higher resolution.
