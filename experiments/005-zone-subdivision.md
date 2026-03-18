# Experiment 005: Zone Subdivision After Secondary Roads

## Previous state
See `004-zone-boundary-roads.md`. Secondary roads created from zone boundaries, connected to arterials via skeleton-walk merge.

## Problems
First-level zones are too large for per-tick allocation (some cover 25% of the map). Need smaller parcels.

## Hypothesis
Zone boundary roads alone run along edges, not through interiors. To actually subdivide, cut roads through large zone interiors:
1. Find the longest boundary edge of each large zone
2. Find its midpoint (on the boundary)
3. Project a point inward, perpendicular to the edge
4. Walk from the midpoint toward the projected point until hitting a road
5. This road cuts through the interior, splitting the zone when re-extracted

## Changes
- New `subdivideLargeZones()` in `src/city/pipeline/subdivideZones.js`
- Runs after `createZoneBoundaryRoads`, before `extractZones` re-extraction
- Only targets zones > 5000 cells

## Results
- `005-output/zones-before-seed884469.png` — 37 first-level zones, largest 108K cells
- `005-output/zones-after-seed884469.png` — 53 zones after subdivision, largest 86K cells
- `005-output/zones-before-seed42.png` — 73 zones, largest 120K
- `005-output/zones-after-seed42.png` — 93 zones, largest 119K

18-23 cuts placed per seed. Zones in the upper areas are noticeably more subdivided. Some large zones remain in areas where cuts didn't reach a road or the boundary edge wasn't long enough.

Could iterate further: run subdivision multiple times, reduce MIN_ZONE_SIZE threshold, or add multiple cuts per zone.

## Decision
KEEP — the subdivision approach works. Zones are smaller and more numerous. The cuts are geometric (straight lines) but functional. Could be improved with iterative passes.
