# Experiment 007k3 — Distance-indexed junctions (no elevation snapping)

## Goal

Take 007k2's distance-based junction approach and remove the elevation snapping. Key each junction by its sequential **distance index** (0, 1, 2, 3...) along the cross street instead of by snapped elevation. This eliminates gaps on flat terrain where many points collapsed to the same elevation key.

## Problem with 007k2

007k2 walked each cross street in 35 m horizontal-distance steps, then snapped the junction elevation to the nearest 2 m contour. On flat terrain multiple 35 m steps landed at the same snapped elevation level, so only the first was recorded — subsequent ones were discarded as duplicates. This left gaps in the parallel street grid on low-slope terrain.

## New approach

For each cross street:
1. Walk the cross street measuring **horizontal arc-length** distance (step = half cell-size).
2. Every `PARALLEL_SPACING` (35 m) of arc-length, note the current position.
3. Key the junction by its **sequential index** (0, 1, 2, 3...) — not by elevation.
4. Connect index N on adjacent cross street A to index N on adjacent cross street B.

No elevation snapping, no search window — just the position at the 35 m mark.

## Parameters

| Parameter | Value |
|---|---|
| `CROSS_SPACING` | 90 m (spacing between cross streets along contour axis) |
| `PARALLEL_SPACING` | 35 m (horizontal arc-length between junction points) |
| `MIN_STREET_LEN` | 20 m (skip degenerate segments) |

Removed vs 007k2: `ELEV_INTERVAL` (2 m quantisation step) and `SNAP_SEARCH` (±10 sample search window).

## Results — seed 884469:27:95

- Zone: 40 421 cells, avgSlope=0.163
- 6 terrain faces
- **71 cross streets, 229 parallel streets, 267 junction points**

| | 007k (elev-interval) | 007k2 (dist + elev-snap) | 007k3 (dist-index) |
|---|---|---|---|
| Cross streets | 71 | 71 | 71 |
| Parallel streets | 693 | 96 | 229 |
| Junction points | 1812 | 265 | 267 |

007k2's elevation snapping collapsed many junctions on flat faces, reducing parallels to 96. Removing the snap restores full coverage: 229 parallels with the same 267 junction points as 007k2 (same 35 m walk, no elevation refinement).

## Rendering

- Face tints (coloured bands by elevation quartile)
- Cross streets: magenta (1 px) — gradient direction, uphill
- Parallel streets: cyan (1 px) — distance-indexed, following cross-street positions
- Junction points: red dots (1 px)
- Zone boundary: yellow (1 px)
