# 031g: Midpoint Segment Guide

## Goal

Try a more geometric version of inherited child rows.

Instead of taking each parent junction and shifting it by a fixed offset along
the corresponding cross street, build each child step from the **parent segment
between two junctions**:

- take the midpoint between the two parent junctions
- offset that midpoint perpendicular to the parent segment by the child's
  current spacing
- shoot the child step from the current child junction through that spacer
  point to the next cross street

This is meant to be closer to "stay parallel to the parent row in 2D" than the
older "same `deltaT` on every cross street" rule.

## Change

- Keep the existing family model from `031e`
- Keep the same slot-family queueing and gap restarts
- Keep the same global validity checks
- Change only inherited child-row stepping:
  - use the midpoint of the current parent segment
  - offset that midpoint by the child row's signed spacing
  - build a guide from the current child junction through that spacer point
  - find the first hit on the next target street
  - choose a landing sample near that hit
- Fall back to the older inherited-target logic if the midpoint guide cannot
  produce a usable hit

So this does **not** negate families. It keeps the family structure and changes
the local geometry of how family members are laid.

## Result

Mixed, but useful.

On seed `884469`:

- Zone 0 stays at `35` ribbons
- Zone 1 drops from `18` in `031e` to `17`
- Zone 2 drops from `66` in `031e` to `63`

Visually, the child rows do feel a bit more like they are being guided by the
parent row's actual segments, which is the right conceptual direction. But the
tradeoff is slightly worse fill and more misses, especially once the geometry
gets awkward and the stricter midpoint guide runs out of room.

So `031g` is a cleaner statement of the idea, but not yet a net improvement
over `031e`.

## Likely Next Step

Keep the midpoint-segment guide as a local preference, but allow it to truncate
cleanly at the last good inherited junction instead of trying to carry a child
row farther into awkward geometry than it can support.
