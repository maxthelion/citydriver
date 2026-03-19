# Experiment 007s4: Overlay with Opposite-Side Road Selection

## Previous state
007s3 selected anchor roads by score (preferring skeleton arterials), but both roads ended up on the same side of the zone (top-left), so the s2 construction lines only covered part of the zone.

## Problem
The s2 lines need to span the full zone to be useful for blending with k3 streets. Two roads on the same side produce construction geometry that fans out from one corner rather than spanning across.

## Hypothesis
Add a constraint: the second anchor road must have its midpoint on the opposite side of the zone centroid from the first road. This ensures the construction geometry spans across the zone.

## Changes
After selecting the highest-scoring first road, check each candidate for the second road:
1. Must form > 15° angle with the first (same as before)
2. Dot product of (centroid→roadA_midpoint) and (centroid→roadB_midpoint) must be negative (opposite sides)

Falls back to angle-only if no opposite-side road is found.

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
