# 032: Shared-Boundary Phase Cross Streets

## Goal

Make neighboring sectors feel less like they each generated their own separate
set of cross streets.

The specific target here is the case where two sectors share a boundary and the
cross streets are running away from that boundary. In those cases, the street
ends on each side should align closely enough that they read like a through
road, not two independent stubs.

At the same time, add coarse event logging for cross-street generation so we
can inspect sweep decisions the same way we now inspect ribbon decisions.

## Change

- Add coarse cross-street events to `layCrossStreets(...)`:
  - `sweep-plan`
  - `scanline-start`
  - `scanline-runs`
  - `street-candidate`
  - `street-rejected`
  - `street-accepted`
  - `street-pruned`
- Write those logs to `cross-events-zone*-seed*.ndjson` during the ribbon
  experiment render.
- Add an experiment-only shared-boundary phase rule:
  - find the strongest shared boundary for each sector
  - estimate that shared boundary's midpoint and tangent
  - if the boundary tangent roughly aligns with the sector contour axis, use the
    boundary midpoint as the contour sweep phase origin instead of the sector
    centroid

This does **not** change the basic cross-street algorithm. It only changes the
phase of the contour-axis sweep in sectors that appear to want boundary-aligned
cross streets.

## Result

This is a useful direction, but not a clean win yet.

On seed `884469`:

- Zone 0: `51` cross streets, `58` ribbons
- Zone 1: `17` cross streets, `13` ribbons
- Zone 2: `64` cross streets, `59` ribbons

Compared with `031j`, the seam behavior is a bit better in some boundary-facing
pairs: a few neighboring magenta street ends do line up more convincingly, so
they read more like one interrupted road crossing a sector boundary.

The downside is that using one shared-boundary phase for the whole sector is too
coarse. In some tapered or irregular sectors it shifts the entire sweep enough
that:

- fewer useful cross streets are generated deeper in the sector
- more lines get pruned by the normal separation rules
- downstream ribbon counts drop

So the first version helps the exact artifact we were targeting, but it also
introduces a new "wrong phase deeper inside the sector" problem.

## Conclusion

Cross-street logging is worth keeping.

The alignment idea also seems sound, but this version is probably too blunt. The
next refinement should likely be more local:

- align only the boundary-adjacent portion of the sweep
- or seed from the shared boundary but relax back toward the sector centroid as
  the streets move deeper into the sector
- or explicitly pair street ends across the shared boundary instead of shifting
  the whole sector's phase
