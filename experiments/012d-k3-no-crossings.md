# Experiment 012d: k3 with self-crossing removal

## Previous state
012c fixed elevation matching, parallel separation, and road clipping. But streets from different terrain faces still crossed each other at face boundaries.

## Changes
Added self-crossing detection: after all faces generate streets, find crossing segment pairs and remove the shorter segment. Combined with the existing fixes from 012c.

## Results
Self-crossing filter removed 10-40 parallels per zone. 17/18 invariant tests pass (1 borderline steep parallel on seed 42).

## Decision
KEEP
