# Experiment 007e: Gradient Construction Lines

## Problem

007d's cross streets were too parallel and regular because all directions were
derived from the same perpendicular to the ribbon. Real streets on a hill fan out
or converge because they actually follow the slope gradient. Coverage was also
uneven — some parts of steep zones were missed.

## Hypothesis

Shooting construction lines uphill from the zone's base edge, then connecting
measured points between adjacent lines, will produce streets that naturally fan
and converge with the terrain. Every point on a given "row" will be at a similar
elevation because they were all placed the same arc-length distance from the base.

## Algorithm

1. **Find the base edge** — walk the zone boundary, pick the segment whose
   endpoints have the lowest average elevation. This is the bottom of the hill.

2. **Mark base points** — place sample points every `BASE_SPACING` (35 m) along
   the base edge.

3. **Walk uphill from each base point** — at each step, look at the 8-connected
   grid neighbours that are still within the zone; move to the one with the
   highest elevation. Repeat until no uphill neighbour exists or the zone boundary
   is reached. This produces a set of construction-line polylines that follow the
   gradient and naturally fan or converge with the terrain shape.

4. **Mark grid points along each construction line** — place a point every
   `CONTOUR_INTERVAL` (90 m) of arc length. Points at the same distance from the
   base will be at similar elevations.

5. **Connect corresponding points between adjacent lines** — line K point N
   connects to line K+1 point N. Because both points are the same arc-length
   above the base they follow the contour naturally.

6. **Promote every 3rd construction line** — those become visible roads (magenta);
   the rest are geometry-only (dark green, 1 px).

## Rendering

| Element | Colour | Weight |
|---|---|---|
| Zone fill | green tint | — |
| Zone boundary | yellow | 1 px |
| Base edge | bright red | 3 px |
| Construction lines | dark green | 1 px |
| Promoted construction lines (every 3rd) | magenta | 3 px |
| Contour connections | cyan | 3 px |

## Key difference from 007d

| Aspect | 007d (cross-first) | 007e (gradient construction) |
|---|---|---|
| Direction source | Ribbon orientation vector (fixed) | Terrain gradient (per-step) |
| Street shape | Straight clipped lines | Polylines following slope |
| Coverage | Uniform in projection | Follows terrain topology |
| Fanning | No — parallel fixed | Yes — lines diverge/converge |

## Changes

- New render script: `scripts/render-ribbon-gradient.js`

## Results

_To be filled after rendering._

## Decision

_KEEP or REVERT_
