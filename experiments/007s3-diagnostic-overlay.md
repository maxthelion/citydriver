# Experiment 007s3: Diagnostic Overlay — k3 + s2 on Same Zone

## Previous state
007k3 produces organic terrain-following streets (gradient cross streets + distance-indexed parallels). 007s2 produces geometric construction lines between anchor roads. They operate on different zones.

## Problem
To blend the two approaches, we first need to see how the two sets of lines relate when rendered on the same zone.

## Hypothesis
Overlaying both sets of lines on the k3 zone will reveal which s2 line set (perpA→roadB or perpB→roadA) is most similar to the k3 cross streets, and how the angles and positions compare. This diagnostic informs the next step: rotating/splicing k3 lines to match s2 geometry near roads.

## Changes
New render script `render-ribbon-overlay.js`:
- Uses k3 zone selection (large zone near center with slope data)
- Computes k3 terrain faces, gradient cross streets, distance-indexed parallels
- Finds two longest road segments near zone boundary (using corner detection in boundary polygon)
- Computes s2-style construction geometry (road intersection, perpendiculars, apex, subdivisions)
- Renders all layers in different colours:
  - Magenta: k3 cross streets (gradient-following)
  - Cyan: k3 parallels (contour-following)
  - Yellow-green: s2 set A (perpA→roadB)
  - Orange: s2 set B (perpB→roadA)
  - Green: construction lines + apex

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
