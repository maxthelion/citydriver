# Experiment 007s2: Fix Reversed Road Connections

## Previous state
007s1 connected perpA subdivisions to road B and perpB to road A, but the road points were in the wrong order — farA connected to farB instead of nearB, creating crossed fan shapes.

## Problem
The connections crossed because they linked opposite corners of the quad instead of adjacent corners. perpA[0]=farA should connect to nearB (adjacent around the quad perimeter), not farB (diagonally opposite).

## Hypothesis
Reverse the road subdivision ordering so adjacent quad corners connect:
- perpA: farA→apex connects to road B: nearB→farB
- perpB: farB→apex connects to road A: nearA→farA

## Changes
Reversed `subdivide(farB, nearB)` to `subdivide(nearB, farB)` for road B, and similarly for road A.

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
