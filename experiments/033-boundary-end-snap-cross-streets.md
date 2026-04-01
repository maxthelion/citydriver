# 033: Boundary-End Snap Cross Streets

## Goal

Improve the "these should feel like one through road" effect across shared
sector boundaries without shifting the whole sector's cross-street phase.

The targeted artifact is:

- one sector has a cross street ending near a shared boundary
- the neighboring sector generates a nearby but visibly misaligned street end
- together they read like two unrelated stubs instead of one interrupted road

## Change

- Keep the existing cross-street sweep and spacing logic
- For sectors that share a strong boundary with an already-processed neighbor:
  - collect existing neighboring cross-street endpoints near that shared
    boundary
  - for each new cross-street candidate, see whether one of its endpoints is
    already close to one of those boundary endpoints
  - if so, rebuild that street locally by:
    - taking the original street midpoint
    - aiming from the snapped boundary endpoint through that midpoint
    - rescanning along that new direction
    - keeping the run that still contains the midpoint and approaches the shared
      boundary more cleanly
- Keep the normal length and convergence pruning afterward

This makes alignment a per-street adjustment rather than a whole-sector phase
shift.

## Result

This is conceptually cleaner than `032`, and the output reflects that.

On seed `884469`:

- Zone 0: `51` cross streets, `54` ribbons
- Zone 1: `17` cross streets, `15` ribbons
- Zone 2: `63` cross streets, `72` ribbons

Compared with `032`, this is a better tradeoff. It preserves the internal
sector rhythm much better because it leaves the main sweep phase alone and only
nudges individual streets near the seam.

Compared with `031j`, it is mixed:

- Zone 1 is effectively unchanged
- Zone 2 actually improves and fills more aggressively
- Zone 0 still has one sector where too many cross streets get pruned after the
  snap adjustment, so that area ends up too sparse

So the local snapping idea seems sound, but the current thresholds are still a
bit too eager in some awkward sectors.

## Conclusion

This feels like a better shape of experiment than `032` because it preserves the
existing sweep and only nudges streets that are already close to a plausible
shared-boundary connection.

The likely next refinement would be to make the snap stricter and more local:

- only snap streets whose boundary-facing endpoint is already very close to an
  existing neighboring endpoint
- or only apply the snap if it does not worsen later separation pruning in that
  sector
- eventually make the shared-boundary snap bidirectional or pairwise, so both
  sectors can be solved against the same seam constraints instead of whichever
  one happened to render second
