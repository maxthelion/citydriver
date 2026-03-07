# Desire Lines Growth Strategy

## Concept

Instead of geometric subdivision or offset curves, simulate where people would
*want* to travel. Scatter many origin-destination (O/D) pairs weighted toward
nuclei and map edges, pathfind each one, accumulate traversal counts on a heat
grid, then threshold and trace the hot cells into road polylines.

The metaphor: ant trails forming, neural connections developing and being pruned,
or pedestrian desire lines wearing into grass.

## Why This Approach

- **No face extraction required.** Works bottom-up from accumulated demand, not
  top-down from graph topology. Avoids PlanarGraph DCEL issues entirely.
- **Naturally terrain-aware.** A* cost function penalizes slopes and water, so
  desire lines follow terrain contours automatically.
- **Density gradient emerges.** More O/D pairs near nuclei = more heat = more
  roads near town center. Fringe areas get fewer, sparser roads.
- **Through-routes emerge.** O/D pairs targeting map edges create arterial
  corridors that pass through the settlement.

## Algorithm

### Tick 1: Skeleton

`buildSkeletonRoads(map)` — same as all strategies.

### Tick 2: Primary Desire Lines

1. **Generate ~300 O/D pairs**, weighted:
   - Origins: random buildable cells, biased toward nuclei (Gaussian falloff,
     sigma = 20 cells, weighted by nucleus tier)
   - Destinations: other nuclei, map edge midpoints, random buildable cells
   - Skip pairs closer than 10 cells or further than 80% of map diagonal
2. **Pathfind each pair** using `growth` cost preset (respects terrain, gives
   road reuse discount)
3. **Accumulate** traversal count per cell on a Float32 heat grid
4. **Gaussian blur** the heat grid (radius 3 cells) to merge nearby parallel paths
5. **Threshold** at the 85th percentile of nonzero cells
6. **Thin** the binary mask to 1-cell-wide ridges (Zhang-Suen thinning)
7. **Trace** connected pixel runs into polylines
8. **Simplify** (RDP, epsilon 1.0) and **smooth** (Chaikin, 2 iterations)
9. Add as roads via `addFeature('road', ...)` with source `'desire'`

### Tick 3: Reinforcement Pass

Repeat with ~150 O/D pairs. Now that tick 2 roads exist, the cost function's
reuse discount reinforces popular corridors. Lower threshold (75th percentile)
to pick up secondary streets.

### Tick 4+: Return false (converged)

## Parameters

| Constant | Value | Rationale |
|----------|-------|-----------|
| `OD_PAIRS_PRIMARY` | 150 | Enough to establish main corridors |
| `OD_PAIRS_SECONDARY` | 80 | Fill in secondary streets |
| `BLUR_RADIUS` | 3 | Merge parallel paths ~30m apart |
| `PRIMARY_THRESHOLD` | 0.85 | Top 15% of heat = main roads |
| `SECONDARY_THRESHOLD` | 0.75 | Top 25% of heat = local streets |
| `MIN_POLYLINE_CELLS` | 5 | Ignore tiny fragments |
| `NUCLEUS_SIGMA` | 20 | Gaussian falloff for O/D weighting (cells) |
| `MIN_OD_DISTANCE` | 10 | Skip trivially short pairs (cells) |

## Thinning (Zhang-Suen)

Iterative morphological thinning that removes border pixels without breaking
connectivity. Two sub-iterations per pass check different neighbor conditions.
Converges in 5-15 iterations for road-width blobs.

## Tracing

Walk connected skeleton cells: start from endpoints (degree != 2) or junctions
(degree > 2), follow chain until next endpoint/junction. Produces clean polyline
segments.

## File

`src/city/strategies/desireLines.js`

No new core modules needed — uses existing `findPath`, `Grid2D`, `SeededRandom`,
and `FeatureMap.addFeature()`.
