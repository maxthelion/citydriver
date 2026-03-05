# Progress: Roads, Plots, and Water

Summary of changes to the city generation pipeline addressing road overlap,
plot placement quality, and water rendering.

## Road Network: Shared Grid Extraction

**Problem:** Regional roads were imported as independent point-to-point edges.
When two roads followed the same terrain corridor, they produced nearly
identical A* paths stored as separate overlapping edges. Attempted fixes
(road-grid discounting, node snapping, duplicate detection, parallel detection)
treated symptoms, not the cause.

**Solution:** Rewrite anchor route import (C3) to build roads as a shared
network rather than independent routes.

1. **Pathfind onto shared usage grid.** All regional roads are A*-pathfound
   onto a common grid. Arterials go first and define the primary network.
   Later roads get a strong reuse discount (0.15x cost) for cells already
   used, so they naturally merge onto existing paths.

2. **Find junctions from the usage grid.** Cells where road count changes
   or branching occurs become junction nodes. Endpoints (1 neighbor) and
   branch points (3+ neighbors) are identified automatically.

3. **Trace segments between junctions.** Walk the usage grid from each
   junction, following connected road cells until reaching another junction
   or dead end. Each unique segment becomes one graph edge.

4. **Convert to graph.** Segments are simplified, smoothed, and added as
   PlanarGraph edges. Hierarchy is inherited from the highest-ranked road
   using each segment.

No overlapping roads by construction. See `observations-road-merging.md`
for the design rationale and five road-interaction scenarios.

**File:** `src/city/generateAnchorRoutes.js`

## Plot Placement: Availability Grid

**Problem:** Plots overlapped roads at junctions, extended into water, and
were rigid rectangles even on curved roads.

**Solution:** Build a fine-resolution (3m) availability grid before placing
any plots. The grid marks space as unavailable for three reasons:

- **Water/sea** (value 1): From smooth water polygons with 6m buffer
- **Road corridors** (value 2): Each road edge stamped at its full width + 2m
- **Junction clearings** (value 2): 15m radius circle around nodes with 3+ edges
- **Claimed plots** (value 3): Stamped as each plot is placed

Plots are validated against this grid with zero tolerance: any cell overlap
with unavailable space causes rejection.

### Curved Plots

Plots are generated as a band along each road edge's polyline, subdivided
into individual lots. Each plot's front edge follows the road curve, producing
trapezoids rather than rectangles. This is done by walking the polyline at
the configured frontage width and sampling the local perpendicular at each
plot boundary.

Short segments near junction nodes (within 15m) are skipped entirely.

### Institutional Plot Alignment

Large institutional plots (markets, churches, parks, schools, hospitals)
now find the nearest road segment and align their rotation to match. The
search uses closest-point-on-polyline distance (not just edge midpoints)
with a 150m search radius.

**Files:** `src/city/generateStreetsAndPlots.js`,
`src/city/generateInstitutionalPlots.js`

## Water Polygons: Smooth Coastlines

**Problem:** Water was rendered as 10m grid squares, producing blocky
coastlines that looked wrong at schematic zoom levels. The coarse grid
also made plot boundary detection unreliable near coasts.

**Solution:** Extract smooth water boundary polygons from the grid using
marching squares contour tracing.

1. **Dilate the water grid** by 1 cell to connect diagonally adjacent
   water cells into continuous bodies.

2. **Marching squares** traces the boundary between water and land cells,
   producing line segments at cell-edge midpoints.

3. **Chain segments** into polylines using exact coordinate matching.

4. **Simplify** with Douglas-Peucker (tolerance = half cell size).

5. **Smooth** with Chaikin corner-cutting (2 iterations).

The resulting polygons are:
- Rendered in schematics as smooth filled shapes (replacing grid squares)
- Used by the availability grid for precise water boundary detection
- Stored as `waterPolygons` on cityLayers for downstream use

**File:** `src/city/extractWaterPolygons.js`

## Pipeline Changes

- Removed neighborhood connector roads (C5) — too noisy
- Removed back lanes and cross streets — unsalvageable, simplify first
- Added `--stop-after` flag to debug pipeline for intermediate inspection
- Debug script now cleans output directory before regenerating
- Schematic renderer draws smooth water polygons when available
