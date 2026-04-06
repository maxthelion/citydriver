# 051 — Perpendicular Frontage Cuts

This follows `050`.

`050` moved commercial frontage to a vector-first model:

- smoothed frontage spans
- offset service-road polylines
- parcel polygons between them

That improved the service road itself, but the parcel side cuts were still
derived too loosely from corresponding samples on two different polylines. The
result was that the lines running back from the anchor road did not read as
proper perpendicular cuts.

`051` adds an explicit helper for:

- the local tangent at a point on the frontage
- the corresponding inward normal
- a perpendicular cut line from frontage to service depth

The parcel polygons are then built from those normal-derived cuts rather than
just matching two sliced polylines by distance.

The question for this experiment is very specific:

- when zoomed into the SVG, do the parcel cuts now read as clean perpendicular
  lines from the frontage road?

This is still a micro representation experiment, not a full land-allocation
solution. If it works, the same primitive should later be used for:

- terrace edge bands
- park-edge frontage
- plot subdivision from frontage parcels
