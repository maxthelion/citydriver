# 050 — Vector Frontage Parcels

This is a deliberate step away from the cell-canonical micro allocation
experiments.

The goal is to test a different abstraction:

- **frontage spans** are explicit geometric objects
- **commercial parcels** are polygons derived from those spans
- **service roads** and **stubs** are planned road polylines
- the grid is only a planning aid and background overlay

The immediate motivation is the zoomed-in failure mode from `045`–`049`:
the back road behind commercial frontage looked jagged because it was generated
as a painted cell ribbon first, then interpreted as a road.

`050` flips that around:

1. find road-facing anchor runs as before
2. convert each run into a smoothed frontage polyline
3. offset that frontage to create a service-road polyline
4. split the frontage by access gaps
5. build commercial parcel polygons between frontage and service road
6. optionally commit the planned roads to the real road network for inspection

This is intentionally narrower than the recent park/residual-fill experiments.
It is a representation experiment first:

- can we get a plausible commercial strip structure?
- does the back road read as a real street at SVG zoom?
- do the parcels already look closer to something that could later be cut into
  plots?

If this direction is right, later experiments should add:

- park polygons as true reservation parcels
- terrace edge bands as frontage-derived polygons
- residual areas derived from polygon subtraction / real roads, not cell blobs
