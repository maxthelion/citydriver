# Experiment 007f: Multi-Edge Construction Lines

## Problem

007e climbed uphill from the lowest boundary edge only. When a zone has a
relatively flat section on the opposite side, or when the highest point is a
ridge rather than a single peak, the lines stopped at the ridge and left
large areas of the zone uncovered.

## Hypothesis

Starting construction lines from **every** boundary edge — walking inward toward
the zone centroid from all sides simultaneously — guarantees full coverage.
Lines from opposite sides meet somewhere in the middle, with no uncovered gaps.

## Algorithm

1. **Walk the entire perimeter** — compute cumulative arc-lengths around the
   closed boundary polygon and place starting points every `BASE_SPACING` (35 m).
   This visits every edge of the zone, regardless of elevation.

2. **Walk inward from each starting point** — at each step the preferred
   direction is a weighted blend:
   - 70% toward the zone centroid (normalized vector)
   - 30% toward the highest-elevation 8-connected neighbour

   Among in-zone, unvisited 8-connected neighbours, pick the one whose unit
   direction most closely matches this weighted target (maximum dot product).

3. **Stop conditions** (any of):
   - Within `CENTROID_STOP_CELLS` (20) grid cells of the centroid
   - No valid in-zone unvisited neighbour
   - `MAX_STEPS` (200) reached

4. **Mark grid points** every `CONTOUR_INTERVAL` (90 m) of arc length along
   each construction line.

5. **Connect adjacent lines** — connect Nth grid points between lines whose
   starting points are adjacent around the perimeter. Also wraps the last line
   back to the first.

6. **Promote every `PROMOTE_NTH` (4th) construction line** — those become
   visible roads (magenta); the rest are geometry-only (dark green, 1 px).

## Key difference from 007e

| Aspect | 007e (gradient, single base edge) | 007f (multi-edge, inward walk) |
|---|---|---|
| Starting edges | Lowest-elevation edge only | All boundary edges |
| Walk direction | Uphill (highest neighbour) | Toward centroid (70%) + highest (30%) |
| Coverage | Stops at ridges, leaves flat sides empty | Full zone coverage |
| Line meeting | All lines diverge from one base | Lines converge from all sides |
| Perimeter wrapping | No | Yes — last line connects back to first |

## Rendering

| Element | Colour | Weight |
|---|---|---|
| Zone fill | green tint | — |
| Zone boundary | yellow | 1 px |
| Starting points (all edges) | red dots | 3x3 px |
| Construction lines | dark green | 1 px |
| Promoted construction lines (every 4th) | magenta | 3 px |
| Contour connections | cyan | 3 px |

## Changes

- New render script: `scripts/render-ribbon-multiedge.js`

## Results

_To be filled after rendering._

## Decision

_KEEP or REVERT_
