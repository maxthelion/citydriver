# Experiment 007s5: Overlay Using Zone Boundary Polygon Edges

## Previous state
007s3/s4 tried to find anchor roads from `map.roads` but selected wrong roads — short arterials or roads on the same side. The user identified the correct anchor roads: the two longest straight edges of the zone boundary polygon itself.

## Problem
The zone is bounded by roads that follow its boundary. These roads appear as the edges of the zone boundary polygon. Individual `map.roads` entries don't correspond cleanly to these edges because boundary roads are split into many segments.

## Hypothesis
Simplify the zone boundary polygon using Douglas-Peucker to extract its major straight edges. Pick the two longest edges that form a meaningful angle (> 15°). These edges correspond to the actual bounding roads.

## Changes
Replace road selection with polygon simplification:
1. Apply Douglas-Peucker (tolerance = 50m) to the zone boundary
2. Extract edges from simplified polygon
3. Collect original boundary points near each edge for the points array
4. Pick two longest edges with angle difference > 15°

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
