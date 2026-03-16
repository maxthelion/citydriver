# Sea Floor Plunge & Coastal Terrain Fix

## Problem

The city generator produces too many small islands in the sea. Low-lying terrain near the coastline hovers around 0m elevation, creating a patchwork of tiny land patches with buildings on them. The floodplain system flattens river mouths to sea level (0m), contributing to the problem. Previous fix (removing aggressive bank enforcement) helped but didn't eliminate the root cause: terrain near the coast doesn't drop fast enough below sea level.

### Root Causes Identified

1. **The `-0.5m` sea floor clamp in `carveValleys.js`** (`h = Math.max(h, seaLevel - 0.5)`) prevents any terrain from going more than 0.5m below sea level after valley carving. This undoes the existing coastal falloff (`SUB_SEA_DEPTH_BASE/SCALE`) which tries to push ocean cells 10-30m deep.
2. **Floodplain target at 0m** — `max(seaLevel, riverElev)` flattens river mouth terrain right to sea level.
3. **Building flood margin too narrow** — only 2 cells from water, only 2m above sea level.

## Design

Three coordinated changes plus a critical clamp fix.

### Pipeline Execution Order

```
generateTerrain.js:
  1. Base terrain generation (existing)
  2. Coastal falloff with SUB_SEA_DEPTH (existing)
  3. Sea floor plunge pass (NEW) — runs after all terrain gen

carveValleys.js:
  4. Valley carving (existing)
  5. Floodplain with below-sea-level targets (MODIFIED)
  6. Sea floor clamp changed from -0.5m to -50m (FIX)

terrainSuitability.js:
  7. Wider flood margin (MODIFIED)
```

### 0. Fix Sea Floor Clamp (Critical)

**Location:** `src/regional/carveValleys.js`, line 186.

**Current:** `h = Math.max(h, seaLevel - 0.5)`
**New:** `h = Math.max(h, seaLevel - 50)` (or remove entirely)

This single line is likely the primary reason the existing coastal falloff doesn't work — it clamps everything back to -0.5m. Must be fixed or the plunge pass and river mouth changes will also be clamped.

### 1. Regional Sea Floor Plunge Pass

**Location:** `src/regional/generateTerrain.js`, new post-processing pass after all terrain generation completes.

**Logic:** For every cell in the water mask (coast field < 0, or waterMask = true) — NOT based on `elevation < 0`, since cells at +0.3m in the water mask are the exact problem:

1. Compute distance from the nearest land cell (coast field > 0) via BFS or distance field
2. Apply a minimum depth and distance-based drop-off:
   ```
   depthBase = 3..5m  (immediate minimum depth at coastline)
   dropRate  = 0.04..0.08 m/m  (slope, not per-cell, to be cell-size independent)
   newElevation = min(currentElevation, -(depthBase + distFromCoast_meters * dropRate))
   ```
3. Modulate by rock resistance:
   - Hard rock (resistance > 0.6): higher `depthBase` (~5m) and `dropRate` (~0.08) — steep rocky cliffs
   - Soft rock (resistance < 0.3): lower `depthBase` (~3m) and `dropRate` (~0.04) — still steep, but less dramatic

**Effect:** The first underwater cell is at -3 to -5m. 100m out: -7 to -13m. No terrain lingers near 0m in the sea.

### 2. River Mouth Carving Below Sea Level

**Location:** `src/regional/carveValleys.js`, modify floodplain target computation.

**Current behavior:**
```
floodplainTarget = max(seaLevel, riverElev)
```
Flattens river mouth terrain to 0m.

**New behavior:**
```
depthOffset = scale(accumulation, smallRiver..largeRiver, 1..5m)
floodplainTarget = seaLevel - depthOffset
```
- Small rivers: target -1 to -2m at the mouth
- Large rivers: target -3 to -5m at the mouth
- The below-sea-level targeting ramps in over the last 400m before the coast (single value, scales with proximity)
- Blending uses `min(currentElevation, newTarget)` to avoid raising already-plunged terrain

**Effect:** River mouths become natural channels carved into the sea floor. No flat marshy patches at 0m creating islands.

### 3. Wider Building Flood Margin

**Location:** `src/core/terrainSuitability.js`, modify flood margin check.

**Current rule:**
```
elevation < seaLevel + 2.0m AND waterDist <= 2 cells -> unbuildable
```

**New rule:**
```
elevation < seaLevel + 3.0m AND waterDist <= 5 cells -> unbuildable
```

**Effect:** Safety net. Even if a small land patch survives the plunge pass, buildings won't appear unless the land is at least 3m above sea level and well away from the water's edge.

## Files Modified

| File | Change |
|------|--------|
| `src/regional/generateTerrain.js` | Add sea floor plunge post-processing pass |
| `src/regional/carveValleys.js` | Fix -0.5m clamp; modify floodplain target to go below sea level near coast |
| `src/core/terrainSuitability.js` | Widen flood margin (3m elevation, 5-cell water distance) |

## Constants

| Name | Value | Notes |
|------|-------|-------|
| `SEA_PLUNGE_DEPTH_BASE_HARD` | 5m | Minimum depth for hard rock coastline |
| `SEA_PLUNGE_DEPTH_BASE_SOFT` | 3m | Minimum depth for soft rock coastline |
| `SEA_PLUNGE_SLOPE_HARD` | 0.08 m/m | Drop rate for hard rock (cell-size independent) |
| `SEA_PLUNGE_SLOPE_SOFT` | 0.04 m/m | Drop rate for soft rock (cell-size independent) |
| `RIVER_MOUTH_DEPTH_MIN` | 1m | Depth below sea level for small river mouths |
| `RIVER_MOUTH_DEPTH_MAX` | 5m | Depth below sea level for large river mouths |
| `RIVER_MOUTH_RAMP_DIST` | 400m | Distance over which river bed descends below sea level |
| `FLOOD_MARGIN_M` | 3.0m | Minimum elevation above sea level for buildings |
| `FLOOD_MARGIN_DIST` | 5 cells | Water distance threshold for flood margin |
| `SEA_FLOOR_CLAMP` | -50m | Minimum terrain elevation (replaces -0.5m clamp) |

## Testing

- Visual: no small islands visible in the sea at any seed
- Coastlines should have a clear land/sea boundary (no ambiguous near-0m terrain)
- River mouths should flow naturally below sea level
- Buildings should not appear on any remaining low-lying coastal patches
- Hard rock coastlines should have steeper underwater profiles than soft rock
- Unit: after plunge pass, no water-mask cell within 2+ cells of coast should be above -5m
- Unit: river mouth cells at coast should have elevation < seaLevel
- Unit: cells at seaLevel + 2.5m within 3 cells of water should be unbuildable
