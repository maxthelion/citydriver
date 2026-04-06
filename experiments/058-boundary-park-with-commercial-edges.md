# 058 — Boundary Park With Commercial Edges

This follows `057`.

`057` made one thing explicit:

- after the boundary-attached park and its park roads, the leftover is just a
  **residual area**
- not housing yet
- not a street pattern yet

`058` takes the next obvious move on that remainder:

- keep the attached civic park from `056`
- keep the residual concept from `057`
- add commercial frontage strips on the remaining road-facing boundary
  intervals around the park

So this is the first experiment in this branch where the edge of the residual
starts to receive a second declarative claim:

- park claim on one boundary span
- commercial claims on the remaining boundary-facing edge spans
- updated residual area after those claims

The important constraint is still the same:

- vector geometry is truth
- the park is a real polygon
- service roads are real roads
- the residual is derived from boundary claims, not painted as a cell mask

This should answer the question:

> If the park takes part of the anchor edge, can the remaining edge still host
> believable commercial frontage without collapsing back into grid-first logic?
