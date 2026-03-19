# Experiment 007r: Grid Between Two Non-Parallel Anchor Roads

## Previous state
007k3 is the best baseline — distance-indexed, gradient cross streets, full coverage.

## Problem
When a zone is bounded by two anchor roads at an angle, the street grid needs to compromise between being perpendicular to both.

## Hypothesis
Subdivide both road edges at regular intervals, connect corresponding points between them. Cross streets gradually rotate from one road's perpendicular to the other's. Fill between with parallels.

## Changes
New script that finds a zone between two angled roads, connects edge points, fills parallels.

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
