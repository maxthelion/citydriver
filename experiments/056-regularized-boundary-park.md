# 056 — Regularized Boundary Park

This follows `055`.

`055` was useful because it moved the park to the right side of the problem:

- the park claims land from a real road-facing boundary
- the front edge is shared with that boundary
- only side and rear park roads are emitted

But using the exact curved boundary slice as the front edge produced awkward
"arrowhead" shapes in some sectors. That is faithful to the sampled boundary,
but not a very believable civic reservation.

`056` keeps the good part of `055`:

- choose the park from a real boundary-attached span
- still score against the true sector boundary

and then regularizes the final reservation:

- prefer straighter candidate boundary spans
- collapse the chosen span to a clean chord
- extrude a cleaner quad inward from that chord

So the boundary still decides **where** the park attaches, but it no longer
forces the park front to inherit every bend in the sector edge.

This is closer to the kind of move we are likely to want later:

- reserve a simple civic polygon from a street edge
- keep the reservation legible at plot scale
- let the emitted side/rear roads read like deliberate streets, not noisy
  geometry artifacts

If this holds up, it is a better primitive than `055` for later work like:

- terraced housing facing the park
- corner-chop civic reservations
- residual polygons derived from simple attached claims
