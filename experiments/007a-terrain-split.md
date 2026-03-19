# Experiment 007a: Terrain-Split Ribbon Layout

## Previous state
See `006-ribbon-in-subdivided-zone.md`. Ribbon streets run in a single
subdivided zone using one globally-averaged slope direction. When terrain
varies across the zone, streets bunch or misalign where the local slope
direction deviates from the average.

## Problem
`computeRibbonOrientation` uses `zone.avgSlope` and `zone.slopeDir`, which
are aggregated over all cells. For large or irregular zones spanning a ridgeline
or slope-direction change, the resulting street orientation is a compromise that
fits neither part of the zone well.

## Hypothesis
Splitting a zone along the centroid elevation contour (above vs. below) and
running ribbon layout independently in each sub-zone should produce streets
that better follow local terrain, with fewer bunching artefacts.

## Approach
1. Sample slope-gradient direction at 5 points across the zone's bounding box.
2. If adjacent sample directions differ by >30°, split cells into two groups:
   above and below the zone's centroid elevation.
3. Recompute centroid, avgSlope, slopeDir, and boundary (via `extractZoneBoundary`)
   for each group.
4. Run `computeRibbonOrientation` + `layoutRibbonStreets` + contour adjustment
   independently on each sub-zone.
5. Render sub-zones in distinct tints (green / blue) with separate parallel-street
   colours (cyan / lime) and cross-street colours (magenta / orange).

## Changes
- New render script: `scripts/render-ribbon-terrain-split.js`

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
