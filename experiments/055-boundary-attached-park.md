# 055 — Boundary-Attached Park

This is a variant that deliberately removes the commercial frontage system.

Instead of:

- anchor road
- commercial frontage
- road behind commercial
- park as an interior island

it tries a different civic allocation move:

- anchor road
- park attached directly to that edge
- park extends inward as a single quad
- only the side and rear park roads are emitted

This is closer to a real reservation pattern where a use claims land *from the
boundary* of a sector rather than being dropped into the middle of it.

Two new geometric primitives support this direction:

- `buildAttachedBoundaryQuad(...)`
  - take a span along a boundary/frontage and extrude a four-sided polygon
    inward
- `buildCornerCutPolygon(...)`
  - a simple corner-chop reservation primitive for future use

The first one is used here directly.

The main question is whether this reads like a more plausible land-allocation
move than the island-park case:

- fewer roads
- a clearer civic edge
- a more realistic way to claim land from an existing street

If this direction holds up, it is probably a better basis for later residual
subdivision than the earlier cell-heavy micro-allocation branch.
