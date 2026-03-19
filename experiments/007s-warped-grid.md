# Experiment 007s: Warped Grid Between Angled Roads

## Previous state
007r lays a simple grid between two angled roads by subdividing each edge at regular intervals and connecting corresponding points with straight cross streets, then filling parallel streets between them.

## Problem
The simple approach in 007r connects corresponding points with straight lines, which doesn't account for the geometry of the zone between the roads. The grid doesn't warp to fill the space naturally.

## Hypothesis
Using bilinear interpolation over a (u,v) parameterisation of the quadrilateral formed by the two road edges should produce a grid that warps smoothly to fill the zone. Find the road intersection point, compute perpendicular construction lines to an apex, then interpolate between the two edges.

## Changes
New render script `render-ribbon-warped-grid.js` that:
- Finds where the two road lines intersect
- Computes perpendicular construction lines from the furthest edge points to an apex
- Generates a bilinear (u,v) grid between the two road edges
- Cross streets at constant u (connecting A to B), parallel streets at constant v (following along edges)

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
