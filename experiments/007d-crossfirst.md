# Experiment 007d: Cross-Street-First Ribbon Layout

## Problem

The existing ribbon layout sweeps parallel lines at fixed perpendicular offsets
from the zone centroid. When the zone narrows, or terrain changes direction, those
parallel lines converge and bunch together. Cross streets maintain their spacing
because they are placed at fixed metre intervals, but the parallels they connect
have no such guarantee.

## Hypothesis

Deriving parallel streets from the cross street grid — rather than sweeping them
independently — eliminates bunching. Because the parallel connections are anchored
to measured points on the cross streets, they can only be as close together as the
`spacing` parameter allows.

## Algorithm

1. **Compute ribbon direction** — same as existing (`computeRibbonOrientation`):
   contour-following on slopes, toward nucleus on flat terrain.

2. **Lay cross streets first** — sweep perpendicular lines along the parallel axis
   at `CROSS_STREET_INTERVAL` (90 m) intervals. Clip each to the zone boundary.

3. **Mark anchor points on each cross street** — at multiples of `spacing` (from
   `ribbonSpacingForPressure`) along the cross axis. Offsets are anchored to a
   global grid (nearest multiple of `spacing`), so the same offset appears on every
   cross street that reaches it — true correspondence regardless of where each cross
   street starts and ends.

4. **Connect corresponding points** — for each pair of adjacent cross streets, find
   offsets present in both, and draw a straight segment between the matching points.
   These become the parallel streets.

5. **Apply contour adjustment** — if the zone is sloped, pass the resulting parallel
   segments through `adjustStreetToContour` as before.

## Key difference from previous approaches

| Aspect | Previous (007a–007c) | 007d (cross-first) |
|---|---|---|
| Parallel source | Swept offset from centroid | Measured points on cross streets |
| Bunching prevention | Post-process / adaptive skip | Structurally impossible |
| Cross streets | Derived from parallels | Laid first; parallels derived from them |
| Correspondence | Approximate (overlap) | Exact (shared offset on grid) |

## Rendering

- Cross streets: magenta (3 px)
- Parallel streets (connections): cyan (3 px)
- Zone boundary: yellow

## Changes

- New render script: `scripts/render-ribbon-crossfirst.js`

## Results

_To be filled after rendering._

## Decision

_KEEP or REVERT_
