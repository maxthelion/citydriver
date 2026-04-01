# 034: Shared-Boundary Anchor Cross Streets

## Goal

Use a real shared-boundary street end as the phasing anchor for a neighboring
sector's cross streets.

The idea is:

- if one sector already has a cross street ending on the shared boundary
- the neighboring sector should use that exact point as the first street anchor
- then the rest of its cross streets should be phased from that same anchor

That should make the sector feel more like it continues an existing through-road
fabric instead of inventing a separate one.

## Change

- Keep the normal contour-axis sweep
- For sectors with a strong shared boundary and an already-processed neighbor:
  - collect the neighboring sector's cross-street endpoints near that boundary
  - choose the candidate endpoint nearest the shared boundary midpoint
  - use that exact point as the sector's `phaseOrigin`
- This means the `ct = 0` sweep line runs through that shared boundary anchor,
  and the rest of the streets inherit their spacing from it

Unlike `033`, this does not rotate streets one by one. It changes the whole
sector's phase, but anchors it to a real neighboring street end instead of an
abstract boundary midpoint.

## Result

This works mechanically, but it is still too blunt.

On seed `884469`:

- Zone 0: `51` cross streets, `54` ribbons
- Zone 1: `17` cross streets, `15` ribbons
- Zone 2: `61` cross streets, `63` ribbons

Compared with `032`, this is a better version of the "shift the whole sector"
idea. Using a real shared boundary street end is more grounded than using a
generic midpoint, and some seams do read more convincingly.

Compared with `033`, though, it loses too much internal flexibility. Once the
whole sector is phased from one shared boundary anchor, awkward or tapered
sectors still end up underfilled deeper inside.

So this is a cleaner experiment than `032`, but not as good as the more local
street-by-street seam adjustment in `033`.

## Conclusion

Anchoring from a real shared boundary street end is a good principle, but using
that one point to phase the entire sector is still too global.

The likely next refinement would be a hybrid:

- choose a real shared boundary anchor first
- use it to guarantee one boundary-aligned street
- but only let it influence nearby streets strongly
- then relax back toward the sector's natural sweep deeper inside
