# Experiment 007s1: Perpendicular-Subdivision Grid

## Previous state
007s used bilinear interpolation of quad corners (A0, A1, B0, B1). The grid converged to a point because edge B was only 5m long.

## Problem
The bilinear approach treats the two road edges as opposite sides of a quad. When one edge is much shorter than the other, the grid degenerates into a fan converging to a point.

## Hypothesis
Use the perpendicular construction lines as the grid skeleton instead. Subdivide each perpendicular (farA→apex, farB→apex) into equal parts and connect each subdivision point to the OPPOSITE road edge. This creates two sets of fanning streets that cross each other to form a warped grid, starting from the far end (furthest from road intersection).

## Changes
New render script `render-ribbon-warped-grid-v2.js`:
- Finds nearA/nearB (closest points on each edge to road intersection)
- Subdivides perpA → connects to road B (farB→nearB)
- Subdivides perpB → connects to road A (farA→nearA)
- Two crossing street sets form the grid

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
