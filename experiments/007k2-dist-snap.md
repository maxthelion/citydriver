# Experiment 007k2 — Distance-spaced elevation-snapped junctions

## Goal

Fix 007k's over-density. Junction points should be spaced by **horizontal distance** (35 m between streets) but snapped to the nearest elevation contour (2 m intervals). This gives consistent street spacing regardless of slope, while ensuring contour alignment for continuous lines.

## Problem with 007k

007k placed a junction point at every 2 m elevation crossing along each cross street. On steep terrain the elevation changes 2 m over just a few metres of horizontal distance, producing points every ~2–3 m and 693 parallel streets in a single zone. The elevation interval drove spacing rather than horizontal distance.

## New approach

For each cross street:
1. Walk the cross street measuring **horizontal arc-length** distance (step = half cell-size).
2. Every `PARALLEL_SPACING` (35 m) of arc-length, note the current position.
3. Read the elevation at that position and snap it: `snappedElev = round(elev / 2) * 2`.
4. Search ±10 samples along the cross street for the position whose elevation is closest to `snappedElev`.
5. Record the junction at that refined position with `round(snappedElev / 2)` as the integer key.

Adjacent cross streets independently find the same quantised elevation keys → continuous parallels without jogs, but now at ~35 m horizontal spacing.

## Parameters

| Parameter | Value |
|---|---|
| `CROSS_SPACING` | 90 m (spacing between cross streets along contour axis) |
| `PARALLEL_SPACING` | 35 m (horizontal arc-length between junction points) |
| `ELEV_INTERVAL` | 2 m (elevation quantisation step) |
| `SNAP_SEARCH` | ±10 samples (search window for elevation refinement) |
| `MIN_STREET_LEN` | 20 m (skip degenerate segments) |

## Results — seed 884469:27:95

- Zone: 40 421 cells, avgSlope=0.163
- 6 terrain faces
- **71 cross streets, 96 parallel streets, 265 junction points**

Compare with 007k: 71 cross streets, **693** parallel streets, 1 812 junction points.

The distance-based spacing reduced parallel count from 693 → 96 (an 86% reduction) while retaining contour alignment.

## Rendering

- Face tints (coloured bands by elevation quartile)
- Cross streets: magenta (1 px) — gradient direction, uphill
- Parallel streets: cyan (1 px) — elevation-snapped contour followers
- Junction points: red dots (1 px)
- Zone boundary: yellow (1 px)
