# River Profile Carving Design

**Date:** 2026-03-17
**Status:** Draft

## Problem

The current corridor system in the regional pipeline depresses terrain by up to 15m along planned river corridors and suppresses mountain ridges. Combined with the power curve normalisation (exponent 1.3–1.7), this pushes terrain below sea level along corridors. `extractStreams` skips all cells below sea level, fragmenting what should be a single river into dozens of disconnected root segments.

For seed 786031, 30.9% of the main corridor polyline is below sea level, creating a 90-cell gap that splits the river into 67 disconnected root segments.

The root cause: the corridor system nudges terrain indirectly and hopes the result works out. It has no authority over the actual elevation profile.

## Solution

Replace the indirect corridor depression with **authoritative river elevation profiles**. After terrain generation (including the power curve), compute a smooth elevation gradient along each corridor polyline and carve the terrain to match. The river's elevation is defined explicitly, not discovered from noisy terrain.

## Design

### Entry Point Selection

When a corridor enters from a map edge, scan a window of ±5 cells along the edge around the planned entry point. Pick the cell with the lowest terrain elevation above sea level. Clamp the scan window to avoid extending past map corners.

If all cells in the window are below sea level (e.g., the entry edge is partially submerged), expand the search inward along the corridor polyline until an above-sea-level cell is found.

### Entry Accumulation from Elevation

Entry accumulation scales inversely with start elevation. A river entering near sea level has had more catchment (large river), while a high-altitude entry is a mountain stream.

```
elevRange = maxTerrainElevation - seaLevel
elevFraction = (startElev - seaLevel) / elevRange   // 0 = sea level, 1 = peak
baseAcc = lerp(ACC_MAX, ACC_MIN, elevFraction)       // 10000 → 1500
corridorAcc = baseAcc * importance                    // importance: 1.0, 0.6, 0.3
```

Constants `ACC_MAX = 10000` and `ACC_MIN = 1500`. The importance multiplier (1.0, 0.6, 0.3 for corridors 1–3) is the existing `importance` field on the corridor object.

### Elevation Profile via Binary Subdivision

Given start elevation and end elevation (sea level), build the river's long profile using recursive binary subdivision modulated by the erosion resistance grid:

1. Walk the corridor polyline and sample `erosionResistance` at each point
2. Binary subdivision, 6 levels deep (yields ~4–6 cells per segment on a 256-cell diagonal):
   - Start with two endpoints: `(pathStart, startElev)` and `(pathEnd, seaLevel)`
   - Find the midpoint along the path
   - Read erosion resistance at the midpoint from the grid
   - Compute split ratio: `splitRatio = 1.0 - resistance`
   - Midpoint elevation = `upstreamElev - (upstreamElev - downstreamElev) * splitRatio`
   - High resistance (hard rock) → low splitRatio → midpoint stays near upstream elevation → steep drop downstream (knickpoint)
   - Low resistance (soft rock) → high splitRatio → midpoint drops most of the way → flat section downstream
   - Recurse on each half
3. Interpolate between subdivision points for per-cell elevation along the corridor

The geology modulation is a single continuous function of the grid value — no special cases or if/else bands.

### Terrain Carving

After computing the elevation profile, carve the terrain:

1. For each cell along the corridor polyline, set `elevation = min(elevation, profileElevation)`. Never raise terrain.
2. Valley widening: adjacent cells get blended toward the profile elevation with distance falloff. Valley width is proportional to accumulation using the existing `valleyHalfWidth(accumulation)` from `riverGeometry.js`.
3. Cross-section uses the existing `valleyProfile()` function: flat bottom near the river centre, sloping sides.
4. Recompute `slope` for all cells modified by the carving.

This is a Grid2D operation: compute a target elevation grid along the corridor, then apply `min(elevation, target)` for each affected cell.

**Corridor crossings:** When two corridors overlap at a cell, both apply `min(elevation, profile)`. The lower profile wins. This may create a discontinuity in the higher corridor's gradient at the crossing point, which is acceptable — it becomes a natural confluence where flow routing merges the two rivers.

### Pipeline Integration

New step **A2b** between terrain generation and coastline:

```
A0b  Corridor planning → polylines, importance
A2   Terrain gen → elevation (mountain suppression along corridors, NO base depression)
A2b  River profile carving (NEW)
       For each corridor:
         1. Find lowest entry point near planned entry (scan ±5 cells along edge)
         2. Compute entry accumulation from elevation
         3. Binary subdivide path with erosion resistance grid → elevation profile
         4. Carve terrain: min(elevation, profile) with valley widening
         5. Recompute slope for modified cells
       Output: corridors enriched with elevation profiles + accumulation
A4   Coastline
A3   Hydrology → flow routing follows carved valleys, no fragmentation
```

A2b runs after the power curve normalisation (which is part of A2), so the carved profile overwrites the post-power-curve terrain. If carving were moved inside A2 before the power curve, the same fragmentation bug could re-emerge.

**Coastline interaction (A4):** Coastline erosion runs after A2b and can erode near-coast cells by several metres. This may push the last few corridor cells below sea level at the river mouth. This is acceptable — `extractStreams` stops tracing at sea level (line 282: `if (elevation < seaLevel) break`), so the stream terminates cleanly at the coast. The river mouth being below sea level is correct geography.

**Double-carving with A3:** The hydrology phase (A3) applies its own valley carving along discovered rivers via `computeValleyDepthField` + `applyTerrainFields`. This operates on top of the A2b carving. Since both use `min(elevation, ...)` semantics (never raise), the double-carving just deepens or widens the valley slightly. This is the intended interaction — A2b establishes the major valley, A3 refines it and adds tributary valleys.

### Changes to Existing Code

- **`generateTerrain.js`**: Remove `corridorDepress = corridorInfluence * 15` (base depression). Keep `mountainContrib *= (1 - ci)` (mountain suppression).
- **`planRiverCorridors.js`**: Remove fixed `ACC_SMALL` / `ACC_MEDIUM` / `ACC_LARGE` constants. Accumulation is computed in A2b from terrain elevation.
- **`generateHydrology.js`**: Corridor entry accumulation comes from enriched corridor objects (computed in A2b) rather than fixed values. The downstream propagation logic for injected accumulation is unchanged.
- **New file: `src/regional/carveRiverProfiles.js`** — the A2b step. Exports a single function that takes corridors, elevation grid, slope grid, and erosion resistance grid, and returns enriched corridors with profiles.
- **`pipeline.js`**: Call `carveRiverProfiles()` between `generateTerrain()` and `generateCoastline()`. Pass enriched corridors to `generateHydrology()`.

### What Stays the Same

- `extractStreams`, `carveValleys`, `riverGeometry` — unchanged, operate on terrain as-is
- Mountain suppression in terrain gen — prevents ridges crossing corridors
- Valley carving in hydrology (A3) — continues to carve along discovered rivers (tributaries)
- `fillSinks`, flow routing, flow accumulation — unchanged
- Downstream accumulation propagation in `generateHydrology` — unchanged, reads accumulation from enriched corridor objects

## Why This Fixes the Fragmentation

The carved valley ensures all corridor cells are above sea level (the profile descends smoothly from start elevation to sea level). `extractStreams` will never hit a below-sea-level gap along the corridor. The injected accumulation ensures the river has enough flow volume. The result is a single connected river from edge to coast.

## Acceptance Criteria

1. Seed 786031 produces a single connected major river (not 67 fragments)
2. No corridor cell is below sea level after A2b (before coastline erosion)
3. Profile elevations are monotonically decreasing along each corridor
4. Valley widths are consistent with `valleyHalfWidth()` for the corridor's accumulation
5. `debug-rivers.js` and `debug-river-segments.js` confirm visual improvement
