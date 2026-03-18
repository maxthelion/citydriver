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
- `004-output/zone-roads-seed884469.png`, `roads-only-seed884469.png`
- `004-output/zone-roads-seed42.png`, `roads-only-seed42.png`
- `004-output/zone-roads-seed12345.png`, `roads-only-seed12345.png`

Secondary road network created from zone boundaries connecting to arterials:
- 21-24 zone boundaries qualify per seed → 28-48 road segments after clipping
- Roads follow zone geometry (terrain-aware) and connect to arterial network
- Uses existing road system (addRoad, clipStreetToGrid, graph integration)
- RDP simplification (no Chaikin smoothing — it drifts junction vertices)
- Wide clip buffer (8m) prevents parallel duplicates from shared zone edges
- Endpoint snapping (15m) connects clipped segment ends to nearby arterials
- Min segment length 60m removes disconnected stubs

### Remaining issues
- Some zone boundaries along terrain/coast edges create roads that don't serve as inter-zone corridors — they're outer edges of buildable land, not between two zones
- A few small gaps remain where roads should connect to arterials
- Map edge roads still appear (bottom edge on some seeds)

## Decision
KEEP — the secondary road network is working. Zone boundaries produce terrain-following roads that connect to arterials. Dedup via clip buffer is effective. Next step: re-extract zones after these roads to see if large zones subdivide into smaller parcels.
