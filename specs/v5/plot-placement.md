# Plot Placement

## Coordinate system

- The planar graph stores road centerlines in **world coordinates**
- The 3D scene uses **local coordinates** (world - originX/Z)
- Parcel `roadEdge` polylines come from `graph.edgePolyline()` — world coords, grid resolution
- Road polylines and parcel edges are Chaikin-smoothed (2 passes) in CityScreen before rendering — this gives sub-cell resolution curves
- Smoothing must happen to parcel edges too, not just road polylines, otherwise houses snap to grid cells

## Layout from road centerline outward

For each plot, measured perpendicular from the road centerline:

1. **Road half-width** — varies per road (stored on graph edge, typically 3-5m)
2. **Sidewalk** — 1.5m
3. **Front fence** — plot boundary starts here
4. **Front garden** — 3m
5. **House front wall**
6. **House** — 9m deep (victorian terrace)
7. **Back garden** — remainder of plot
8. **Back fence** — plot boundary ends at ~20m total depth

## Plot subdivision

Parcels are subdivided along their road edge into plots of ~5m width (victorian terrace plot width). Each plot gets:
- A house box (currently placeholder, will be victorian terrace archetype)
- A fence boundary (4 sides)

The subdivision walks the smoothed road edge polyline, interpolating position at each plot-width interval. The perpendicular direction is computed per-segment, so houses follow road curves accurately.

## Parcel data model

Each parcel stores:
- `id` — unique identifier
- `edgeId` — graph edge this parcel sits along
- `side` — -1 or 1 (which side of road)
- `roadWidth` — width of the associated road (meters)
- `roadEdge` — polyline along the road (world coords, gets smoothed)
- `offsetEdge` — polyline along the far side of the parcel
- `polygon` — closed polygon (roadEdge + reversed offsetEdge)
- `cells` — grid cells within the polygon (for 2D debug rendering)

## Known issues

- **Corner clashes**: where two parcels meet at a junction, plots from both sides overlap. Need to detect junction proximity and trim parcels short or skip overlapping plots.
- **No terrain following per-house**: currently all houses in a row share the terrain height sampled at the road edge. Should sample per-house and handle sloping terrain (stepped foundations).
- **Party walls**: terraced houses should share party walls — adjacent houses in a row shouldn't have side fences between them, only at the ends.
