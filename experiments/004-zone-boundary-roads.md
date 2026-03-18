# Experiment 004: Zone Boundary Roads

## Previous state
See `003-zone-visualisation.md`. Zones are large parcels between arterials. No secondary road network exists.

## Problems
- Zones are too large for per-tick allocation (some cover 25% of the map)
- No secondary road network — only sparse skeleton arterials
- Residential ribbon allocator can't find enough road seeds
- layoutRibbons fills entire zones at once (too aggressive)

## Hypothesis
Create secondary roads by selecting zone boundary segments that connect to arterial roads. Algorithm:
1. Collect all zone polygon vertices
2. Cluster nearby vertices into junction candidates (where multiple zones meet)
3. Find which candidates are near arterial road cells → confirmed junctions
4. Mark zone boundary segments between confirmed junctions as road cells

This uses the zone geometry directly — no pathfinding needed. The zone boundaries already follow terrain and are guaranteed to be on land.

## Changes
- New function: extract zone boundary junctions, cluster, snap to arterials, mark segments as roads
- Run after first zone extraction (tick 3), before spatial layers (tick 4)
- Re-extract zones afterward so new roads split the large zones into smaller parcels

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
