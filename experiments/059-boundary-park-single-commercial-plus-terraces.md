# 059 — Boundary Park, Single Commercial Edge, Plus Terraces

This follows `058`.

`058` proved that the attached-park model could support commercial frontage on
the remaining boundary edge, but it was too greedy in larger sectors:

- multiple commercial spans
- many parcels
- extra service-road structure

`059` deliberately slows that down.

It does three things:

- keep the attached boundary park from `056`
- allow only **one** strongest remaining commercial boundary span
- give a residential buyer a chance to claim shallow terrace bands on the park
  side and rear edges before the rest is left as residual

So the intended order here is:

1. civic claim: boundary-attached park
2. commercial claim: one best remaining edge span
3. residential claim: park-facing terraces
4. residual: whatever still remains unallocated

This stays within the vector-first model:

- park is a polygon
- commercial frontage is built from frontage and service-road geometry
- terrace bands are polygons built from park edges
- the residual is rebuilt from those claims rather than painted as housing

The main question is whether that feels more intentional than `058`:

- less greedy at the sector boundary
- a clearer civic/residential relationship around the park
- a residual area that still looks like something we could plan into later
