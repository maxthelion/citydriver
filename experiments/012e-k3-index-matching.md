# Experiment 012e: k3 with index-based matching + elevation filter

## Previous state
012d used elevation-only junction matching which created long diagonal connections between distant junctions at the same height. Parallels zigzagged across the zone.

## Changes
Reverted to sequential index matching (the original 007k3 approach) which keeps parallels local and straight. Added 15% gradient filter to reject steep connections where contours curve and same-index junctions end up at different heights.

## Results
17/18 invariant tests pass. 1 borderline steep parallel on seed 42.

Parallels are local and orderly again. No diagonal zigzag connections.

## Decision
KEEP
