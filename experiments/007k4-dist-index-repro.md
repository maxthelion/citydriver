# Experiment 007k4 — Distance-indexed junctions (repro on current pipeline)

## Previous state
007k3 used seed 884469 which no longer produces usable zones with the current pipeline.

## Problem
Need to verify k3's distance-indexed junction approach still works on the current pipeline.

## Hypothesis
Same render script (render-ribbon-dist-index.js) with seed 42 should produce equivalent output.

## Changes
No code changes. Seed changed from 884469 to 42.

## Results

Seed 42:15:50 — zone 42,360 cells, avgSlope=0.207, 8 terrain faces.

- 62 cross streets, 176 parallel streets, 250 junction points
- Full coverage across all faces — no gaps from elevation snapping (k3's fix confirmed)

Output matches k3's pattern: terrain-following cross streets with distance-indexed parallel connections.

## Decision
KEEP — k3's approach confirmed working on current pipeline.
