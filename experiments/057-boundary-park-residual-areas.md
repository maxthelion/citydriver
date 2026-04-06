# 057 — Boundary Park Residual Areas

This follows `056`.

`056` got the civic structure into a cleaner place:

- a park attached to a real sector boundary span
- a regularized quad rather than a boundary-wobble arrowhead
- side and rear park roads committed as real roads with proper junctions

The next question is not "fill everything with generic streets" yet.

It is:

> Once that park reservation and its roads exist, what meaningful land is
> actually left?

So `057` deliberately stops before ribbon or cross-street fill and instead
derives a first explicit **ResidualArea** polygon from the vector structure.

The residual is built from:

- the traced sector polygon
- the attached park notch
- the park road structure as the notch boundary

This is intentionally a specific construction for the clean boundary-park case,
not a fake general polygon-boolean system.

The goal is to keep the experiment honest:

- vector geometry remains the source of truth
- tiny raster scraps are not promoted to real urban blocks
- the next fill steps can operate on a named residual polygon rather than a
  pile of leftover cells

If this works, later experiments can choose a strategy per residual area:

- frontage-only
- terrace edge
- street fill
- further civic subdivision
