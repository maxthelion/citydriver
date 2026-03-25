# Plan: Polygons as Source of Truth

Addresses the five violations identified in [polygons-vs-cells](../../wiki/pages/polygons-vs-cells.md). Each phase builds on the previous and produces testable, shippable results.

## Principles

- Each phase must leave the pipeline working — no big-bang rewrite
- Polygon is source of truth; grid is derived. Never reconstruct polygon from cells.
- Existing tests must keep passing. New postcondition tests added per phase.
- Concepts follow [spatial-concepts](../../wiki/pages/spatial-concepts.md): zone → parcel → ribbon → plot

---

## Phase 1: Unify Zone Extraction

**Problem:** Two zone extraction methods coexist (graph-face and flood-fill). They disagree. `forceFloodFill` is a workaround.

**Approach:** Flood-fill finds cell blobs (robust, always works). Then trace each blob's boundary to get a polygon. Then match polygon edges to nearby graph edges (roads, rivers, map boundary) to get `boundingEdgeIds`. This gives us flood-fill's robustness AND graph-face's topology.

### Steps

**1.1 Extract `matchBoundaryToGraphEdges(polygon, graph)` utility**

Given a zone's boundary polygon and the planar graph, walk each polygon edge and find the closest graph edge within a tolerance. Return `boundingEdgeIds` — the graph edges that form this zone's boundary.

Algorithm:
- For each segment of the boundary polygon, find the graph edge whose polyline is closest (by Hausdorff distance or midpoint proximity)
- Tolerance: `cellSize * 2` — boundary tracing from cells is approximate
- An edge can bound multiple zones (one on each side)

Files: new `src/city/pipeline/matchBoundaryEdges.js`
Tests: synthetic polygon + graph, verify correct edge matching

**1.2 Update flood-fill path to produce polygon zones with edge refs**

Currently `extractDevelopmentZones` returns zones with cells and a traced boundary polygon but no `boundingEdgeIds`. Add a call to `matchBoundaryToGraphEdges` after boundary tracing.

Files: modify `src/city/zoneExtraction.js`
Tests: flood-fill zones now have `boundingEdgeIds` populated

**1.3 Make flood-fill the only extraction method**

Remove `extractBlocksFromGraph`. The `zones` step always uses flood-fill + boundary trace + edge matching. Remove the `forceFloodFill` option — it's now always flood-fill.

The graph-face extraction code in `extractZones.js` (the `extractBlocksFromGraph` function) is deleted. The `zones-refine` step uses the same path as `zones`.

Files: modify `src/city/pipeline/extractZones.js`, `cityPipeline.js`
Tests: all existing zone tests pass. New postcondition: every zone has `boundingEdgeIds.length > 0`.

**1.4 Add postcondition tests**

From [pipeline-step-postconditions](../../wiki/pages/pipeline-step-postconditions.md):
- After `zones`: zone count > 0, every zone has cells, zone coverage > 10%, no overlaps
- After `zones-refine`: zone count >= initial count, coverage >= 30%
- Every zone has `boundingEdgeIds` matching real graph edges

Files: `test/integration/pipelineProperties.test.js` (update)

### What this gives us
- One zone extraction path (flood-fill + trace + match)
- Every zone has both cells AND polygon AND graph edge references
- `forceFloodFill` removed — no more two-path confusion
- Polygon is source of truth for zone boundary
- zoneGrid is derived by rasterising the polygon

---

## Phase 2: Parcel Objects

**Problem:** Reservations are per-cell labels (`reservationGrid`) with no parcel geometry, edge classification, or relationships.

**Approach:** When growth agents allocate cells, collect them into Parcel objects. Each parcel is a contiguous area with one use type, a traced boundary polygon, and edges classified by what they border.

### Steps

**2.1 Define Parcel data structure**

```javascript
Parcel {
  id: number,
  zoneId: number,                    // parent zone
  reservationType: number,           // RESERVATION enum
  cells: Array<{gx, gz}>,           // grid cells
  polygon: Array<{x, z}>,           // boundary polygon (traced from cells)
  edges: Array<{
    segment: [{x,z}, {x,z}],        // polygon edge segment
    type: 'road' | 'water' | 'parcel-back' | 'zone-edge' | 'map-edge',
    refId: number | null,            // graph edge ID if road/water
  }>,
  area: number,                      // m² from polygon
  frontageLength: number,            // total length of road-type edges
}
```

Files: new `src/city/Parcel.js`

**2.2 Collect parcels after allocation**

After each allocate phase, scan `reservationGrid` for contiguous regions of the same type within each zone. Each region becomes a Parcel. Trace boundary, classify edges (compare to adjacent cells — road cell = road edge, other reservation type = parcel-back, etc.).

Store parcels on the zone: `zone.parcels = [...]`

Files: new `src/city/pipeline/collectParcels.js`
Tests: after allocation, every non-NONE reservation cell belongs to exactly one parcel. Parcel polygon area approximates cell count × cellSize².

**2.3 Classify parcel edges**

For each edge segment of a parcel polygon:
- Sample midpoint of segment
- Check adjacent cell (one step perpendicular to segment, outside the parcel)
- If road cell → `type: 'road'`, match to graph edge for `refId`
- If water cell → `type: 'water'`
- If cell belongs to different reservation type → `type: 'parcel-back'`
- If no zone → `type: 'zone-edge'`
- If outside map → `type: 'map-edge'`

Files: part of `collectParcels.js`
Tests: commercial parcels have at least one `road` edge. Residential parcels behind commercial have at least one `parcel-back` edge.

**2.4 Make reservationGrid derived**

`reservationGrid` becomes a rasterisation of parcel polygons rather than the primary data. Allocators still write to `reservationGrid` during allocation (for performance — BFS needs the grid), but after allocation completes, `collectParcels` builds the polygon objects and `reservationGrid` can be regenerated from them.

Files: modify growth tick to call `collectParcels` after allocate phase
Tests: regenerated reservationGrid matches original (within cell-boundary tolerance)

### What this gives us
- Parcel objects with geometry and edge classification
- "Which roads border this residential area?" is a property lookup, not a spatial search
- "How much frontage does this parcel have?" is `frontageLength`
- Foundation for ribbon layout to know which edges have frontage

---

## Phase 3: Width Accounting (Inset Polygons)

**Problem:** Zone polygons extend to road centrelines. The actual buildable area is smaller — inset by half-road-width.

**Approach:** Compute inset polygons for zones and parcels by shrinking each boundary edge inward based on what's on the other side.

### Steps

**3.1 Implement polygon inset**

Given a polygon and per-edge inset distances, compute the inset polygon. Each edge moves inward by its distance. Handles convex and concave polygons.

Algorithm: offset each edge inward by its distance, intersect consecutive offset edges to find new vertices. Handle degenerate cases (collapsed edges, self-intersection) by clipping.

Files: new `src/core/polygonInset.js`
Tests: square polygon inset by uniform distance produces smaller square. Non-uniform inset (one road edge, one water edge with different widths) produces correct trapezoid.

**3.2 Compute zone inset polygons**

For each zone, compute `zone.insetPolygon` by insetting each edge:
- Road edge: inset by `road.width / 2 + sidewalkWidth`
- Water edge: inset by `riverWidth / 2 + bankBuffer`
- Map edge: inset by `cellSize` (margin)
- Other: no inset

Files: add to zone extraction pipeline
Tests: inset polygon area < raw polygon area. No inset polygon extends beyond its raw polygon.

**3.3 Compute parcel inset polygons**

Same as zones but per-parcel. Parcel-back edges get zero inset (shared boundary, no road).

Files: add to `collectParcels`
Tests: parcel inset area accounts for road widths on road edges.

**3.4 Use inset polygons for ribbon layout**

Ribbon streets are placed within the inset polygon, not the raw zone polygon. Streets don't overlap road surfaces.

Files: modify `layoutRibbons.js` to clip against inset polygon
Tests: no ribbon street cell overlaps a road cell (existing bitmap invariant, should now pass more cleanly)

### What this gives us
- Explicit land budget per zone and parcel
- `grossArea - roadConsumption - waterConsumption = netBuildable`
- Ribbon streets placed within actual buildable envelope
- No more implicit width accounting via cell stamping

---

## Phase 4: Persistent Plots

**Problem:** Plots are computed transiently during building placement and discarded. No persistent spatial record of property boundaries.

**Approach:** Create Plot objects during subdivision, store them on parcels, use them for building placement and rendering.

### Steps

**4.1 Define Plot data structure**

```javascript
Plot {
  id: number,
  parcelId: number,                  // parent parcel
  polygon: Array<{x, z}>,           // 4+ corners in world coords
  frontageEdge: {                    // which edge faces the road
    segment: [{x,z}, {x,z}],
    roadId: number,                  // graph edge
  },
  width: number,                     // along street
  depth: number,                     // perpendicular to street
  area: number,                      // m²
  buildingId: number | null,         // what's built here (null = empty)
  usage: string,                     // 'house' | 'shop' | 'garden' | 'parking' | etc.
}
```

Files: new `src/city/Plot.js`

**4.2 Create plots during ribbon layout**

When `layoutRibbons` places parallel streets, the land between adjacent streets is cut into plots. Instead of computing this transiently in `placeBuildings`, do it in the ribbon layout step and store the plots on the parcel.

Files: modify `layoutRibbons.js` or new `src/city/pipeline/subdividePlots.js`
Tests: every plot has road frontage. No plot extends beyond its parcel's inset polygon. Plot areas sum to approximately parcel inset area.

**4.3 Place buildings on plots**

`placeBuildings` reads plot objects instead of computing them from scratch. Building placement becomes: for each plot, select a building type based on the parcel's reservation type and the plot's dimensions, place the building within the plot polygon.

Files: modify `src/city/placeBuildings.js`
Tests: every building has a parent plot. No building extends beyond its plot polygon.

### What this gives us
- Persistent property boundaries
- "Show me plot outlines" is a rendering of stored polygons
- "How many plots are in this zone?" is a count, not a spatial query
- Foundation for property-level simulation (ownership, value, redevelopment)

---

## Phase 5: Bidirectional References

**Problem:** Zones know their bounding roads, but roads don't know their bounding zones. Navigation is one-way.

**Approach:** After zone extraction, build reverse lookups from graph edges to zones/parcels.

### Steps

**5.1 Build edge→zone lookup**

After zone extraction, for each zone's `boundingEdgeIds`, register the zone on both sides of each edge.

```javascript
edgeZones: Map<edgeId, { left: zoneId | null, right: zoneId | null }>
```

Determining left/right: use the edge direction and polygon winding.

Files: add to zone extraction
Tests: every edge with two zones has one on each side. No edge has the same zone on both sides.

**5.2 Build edge→parcel lookup**

Same pattern for parcels after `collectParcels`.

Files: add to `collectParcels`
Tests: road edges between commercial and residential parcels correctly reference both.

**5.3 Road-level queries**

Add to RoadNetwork:
- `zonesAlongRoad(roadId)` → zones on left and right
- `parcelsAlongRoad(roadId)` → parcels on left and right
- `frontageForRoad(roadId)` → total frontage length per use type

Files: modify `src/core/RoadNetwork.js`
Tests: for a road between a commercial zone and a residential zone, returns both.

### What this gives us
- O(1) "what's on either side of this road?"
- Commercial allocation can query "which roads have no commercial frontage yet?"
- Connectivity checking can verify "every zone is reachable from every other zone via the road network"

---

## Dependencies

```
Phase 1 (zones) ← independent, start here
Phase 2 (parcels) ← depends on Phase 1 (needs zone edge refs)
Phase 3 (inset polygons) ← depends on Phase 1 (needs zone polygons)
Phase 4 (plots) ← depends on Phase 2 + 3 (needs parcels with inset polygons)
Phase 5 (bidirectional refs) ← depends on Phase 1 + 2
```

Phases 2 and 3 can run in parallel after Phase 1. Phase 4 needs both. Phase 5 can start after Phase 1.

## Estimated Scope

| Phase | New files | Modified files | Tests | Size |
|-------|----------|---------------|-------|------|
| 1 | 1 | 3 | ~15 | Medium — mostly removing code |
| 2 | 2 | 2 | ~10 | Medium — new data structure + collection |
| 3 | 1 | 3 | ~8 | Small — polygon math |
| 4 | 1 | 2 | ~8 | Medium — refactor building placement |
| 5 | 0 | 3 | ~6 | Small — reverse lookups |
