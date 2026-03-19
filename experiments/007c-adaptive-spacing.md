# Experiment 007c: Adaptive Ribbon Spacing — Enforce Minimum Distance During Generation

## Previous state
See `007b-min-spacing.md`. Post-processing the sorted parallel array removed streets that
were closer than `spacing * 0.6` to an adjacent street (keeping the longer one).

## Problem with 007b's approach
Post-processing walks adjacent pairs in a single pass. When three or more streets bunch
together at a narrowing, removing one pair may leave another adjacent pair still too close.
The single-pass sweep also depends on the order streets were removed, which can produce
asymmetric results.

## Hypothesis
Enforcing the minimum spacing check DURING generation — when each candidate segment is
first produced — is simpler and more predictable:
- Each newly clipped segment is measured against the last ACCEPTED segment's midpoint.
- If the midpoint distance is less than `spacing * 0.7`, the segment is skipped entirely.
- Because the check is against the last accepted (not last generated), we avoid cascading
  bunching: once a sparse gap is established, it persists.
- Cross streets are generated only between accepted parallels, so the grid is consistent.

The threshold is raised from 0.6 (007b) to 0.7 to be slightly more aggressive.

## Approach
1. Inline a modified `layoutRibbonStreetsAdaptive` in the render script (no changes to
   `ribbonLayout.js` — experiment is self-contained).
2. Track a separate "last accepted midpoint" for each side of the sweep (positive offset
   vs. negative offset from the centroid), so the two sides don't interfere with each other.
3. Collect skipped segments for debug rendering (dim red).
4. Re-generate cross streets only between accepted parallels using the same overlap logic.

## Key difference from 007b
| Aspect | 007b (post-process) | 007c (during generation) |
|---|---|---|
| When | After all streets clipped | As each segment is clipped |
| Comparison | Adjacent pair in sorted array | New segment vs. last ACCEPTED |
| Threshold | 0.6 | 0.7 |
| Multi-bunch handling | Single pass, may leave residuals | Naturally prevents cascading |
| Cross streets | Regenerated after pruning | Generated only for accepted |

## Changes
- New render script: `scripts/render-ribbon-adaptive-spacing.js`

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
