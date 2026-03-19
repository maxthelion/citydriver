# Experiment 007b: Post-process Parallel Streets for Minimum Spacing

## Previous state
See `006-ribbon-in-subdivided-zone.md`. Ribbon streets are generated inside subdivided zones.
Parallel streets bunch where zones narrow or terrain curves because the perpendicular sweep
produces converging lines.

## Problem
Parallel streets bunch together at zone boundaries or on curved terrain. The sweep places
lines at fixed offsets from the spine centroid, but those lines converge when the zone
narrows — leaving pairs with far less than the intended spacing.

## Hypothesis
Post-processing the sorted parallel-street array and removing any street that is closer than
`spacing * 0.6` to its neighbour (keeping the longer one) should thin out bunched clusters
while leaving well-spaced streets untouched.

## Approach
1. Run `layoutRibbonStreets` as normal to get the raw sorted parallel array.
2. Walk adjacent pairs; measure minimum distance using sampled midpoints.
3. If distance < `spacing * 0.6`, remove the shorter street.
4. Re-generate cross streets only between surviving parallel streets.
5. Render: removed streets in dim red, survivors in cyan, cross streets in magenta.

## Changes
- New render script: `scripts/render-ribbon-min-spacing.js`

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
