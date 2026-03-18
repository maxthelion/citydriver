# Experiment 006: Ribbon Streets in a Subdivided Zone

## Previous state
See `005-zone-subdivision.md`. Zones subdivided by secondary roads and interior cuts. But unclear if subdivision actually creates separate zones or just roads running through one zone.

## Problems
1. Do subdivision cuts actually split zones into separate flood-fill components?
2. Do the new zones have proper metadata (slope, centroid, boundary) for ribbon layout?
3. Can we run layoutRibbonStreets on a subdivided zone and get sensible results?

## Hypothesis
Pick a random subdivided zone, run ribbon layout in it, render the result. If the zone has proper boundary/slope data, ribbons should work. If the zone is still one big connected component with a road through it, the ribbons will span the entire un-split area.

## Changes
- New render script that subdivides zones, picks one, runs ribbon layout, renders the result

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
