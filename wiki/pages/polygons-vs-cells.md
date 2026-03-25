---
title: "Polygons vs Cells"
category: "architecture"
tags: [architecture, polygons, cells, grid, source-of-truth, design]
summary: "Architectural principle: polygons are source of truth for things on the map, cells are a derived working surface for spatial operations."
last-modified-by: user
---

## The Principle

**Things on the map** (roads, zones, parcels, plots) should be represented as **polygons** (source of truth) that get **rasterised to cells** when needed for grid operations.

**Spatial fields** (land value, terrain, influence layers) are natively cell-based — they represent continuous surfaces, not discrete things.

```
Source of truth          Derived (when needed)
─────────────────        ────────────────────
Road polyline + width  → roadGrid cells
River polyline + width → waterMask cells
Zone polygon + refs    → zoneGrid cells
Parcel polygon + type  → reservationGrid cells
Plot polygon + owner   → (render only)

Land value grid        ← native (IS a field)
Elevation grid         ← native (IS a field)
Influence grids        ← native (IS a field)
Terrain suitability    ← native (IS a field)
```

## Why Polygons as Source of Truth

### They represent the real thing

A road isn't 2 cells wide. It's a polyline with a width of 8 metres. The polyline IS the road. The cells are an approximation used for grid-based operations.

A zone isn't a blob of cells. It's a piece of land bounded by roads and water. The polygon IS the zone. The cells are a rasterisation used for flood-fill and scoring.

### They preserve relationships

A zone polygon knows which road polylines bound it. A parcel polygon knows which edge is a road (frontage) and which is the back of another parcel (no access). These relationships are explicit in the geometry.

Cell blobs don't know their relationships. "Which roads bound this zone?" requires scanning the boundary cells and matching them to road cells — a spatial search that reconstructs what the polygon already knew.

### They support clean operations

Splitting a zone along a new road is a polygon clip operation — well-defined, exact. Splitting a cell blob requires re-flood-filling from scratch, which can produce different results depending on grid alignment.

Width accounting is exact with polygons — inset by half-road-width gives the buildable envelope. With cells, width is quantised to cell boundaries and "half a cell" doesn't exist.

### They're scale-independent

Polygon coordinates are in metres. Change the grid resolution and all the polygons still work. Cell-based representations break when you change cellSize — every constant expressed in cell counts gets the wrong physical meaning.

## Why Cells Still Matter

Cells aren't going away. They're the right representation for:

### Path finding
A* needs a grid (or navmesh). Route a road from A to B by searching cells. The result becomes a polyline (source of truth).

### Spatial scoring
Land value is a continuous field computed by blurring, gradient calculation, and distance transforms. These are grid operations. The result is a field, not a thing on the map.

### Influence and proximity
"How far is the nearest industrial zone?" is a BFS on the grid. "What's the development pressure here?" is a blur of the reservation grid. These produce fields, consumed by value composition.

### Flood fill
Finding connected regions of buildable land. Useful as an intermediate step — find the cell blob, then trace its boundary to get a polygon.

### Fast spatial lookup
"What's at cell (x, z)?" is O(1) on a grid. Useful for rendering, sampling, and checking constraints.

## The Pattern

For each thing on the map:

1. **Create as polygon** — the canonical representation with geometry, relationships, and metadata
2. **Rasterise to grid when needed** — stamp cells for grid operations (path finding, scoring, flood fill)
3. **When the grid changes, update the polygon** — if a new road splits a zone, clip the polygon geometrically, then re-rasterise
4. **Never reconstruct the polygon from cells** — the polygon is source of truth. If you need a polygon, you should already have one. Going from cells back to a polygon loses precision, relationships, and intent.

Exception: the initial creation of zones can use flood-fill to find cell blobs on the terrain, then trace their boundaries to create the initial polygon. But once the polygon exists, it's the source of truth from that point forward.

## Current State

| Feature | Polygon exists? | Grid exists? | Source of truth | Notes |
|---------|----------------|-------------|-----------------|-------|
| Roads | Yes (polyline) | Yes (roadGrid) | Polygon ✅ | Correct — polyline is canonical, grid is stamped |
| Rivers | Yes (polyline) | Yes (waterMask) | Polygon ✅ | Correct — polyline is canonical |
| Zones | Yes (polygon) | Yes (zoneGrid) | **Confused** ⚠️ | Both exist but sometimes disagree. Graph-face extraction creates polygons; flood-fill creates cell blobs. Two paths coexist. |
| Parcels / Reservations | No polygon | Yes (reservationGrid) | **Grid** ❌ | Per-cell labels only. No parcel geometry, no edge classification, no relationships. |
| Plots | No polygon | No grid | **Neither** ❌ | Plots exist only transiently during building placement. Not stored as spatial objects. |
| Skeleton graph | Yes (edges + nodes) | Derived from road polylines | Polygon ✅ | Graph topology is canonical |
| Land value | N/A | Yes | Grid ✅ | Correct — it IS a field |
| Elevation | N/A | Yes | Grid ✅ | Correct — it IS a field |
| Influence layers | N/A | Yes | Grid ✅ | Correct — they ARE fields |
| Terrain suitability | N/A | Yes | Grid ✅ | Correct — it IS a field |

## Violations

### 1. Zone extraction: two competing sources of truth

Graph-face extraction creates zone polygons from the planar graph (polygon-first). Flood-fill creates zone cell blobs from the bitmap (cell-first, polygon traced afterward). Both claim to be the source of truth.

The pipeline currently uses graph-face extraction for the initial `zones` step, then falls back to flood-fill for `zones-refine` with `forceFloodFill`. The two methods produce different results. Neither is authoritative.

**Fix direction:** Use one extraction method. Either:
- Graph-face extraction produces polygons, rasterise to cells (polygon-first)
- Flood-fill finds cell blobs, trace boundary, match to graph edges (cell-first, then upgrade to polygon)

The second approach is more robust (flood-fill always works) and still ends up with proper polygon + edge references.

### 2. Reservations: grid-only, no polygon

`reservationGrid` stamps a use-type value per cell. There are no parcel objects — no polygon, no edge classification, no relationships.

This means:
- "What's the shape of the commercial area?" → scan all cells with type=COMMERCIAL and reconstruct a blob. Lossy.
- "Which roads border this residential parcel?" → scan boundary cells of the blob and match to road cells. Expensive and imprecise.
- "How much frontage does this parcel have?" → impossible without edge classification.

**Fix direction:** Create parcel objects when agents allocate land. Each parcel is a polygon with a use type, explicit edges classified by type (road/water/back-of-parcel), and a parent zone reference. The reservationGrid becomes a derived rasterisation.

### 3. Plots: not stored at all

During building placement, plots are computed transiently — cut from the land between streets, a building placed, then the plot geometry is discarded. Only the building survives.

This means:
- "How many plots are in this zone?" → count buildings (loses empty plots, gardens, driveways)
- "What's the plot frontage of this house?" → not stored
- "Show me the property boundaries" → can't, they don't exist

**Fix direction:** Create plot objects during subdivision. Each plot is a polygon with: frontage edge (which road it faces), owner reference (which building, if any), dimensions, and parent parcel reference. Stored as persistent spatial objects.

### 4. Zone polygon vs zoneGrid disagreement

`extractBlocksFromGraph` creates zone polygons by tracing graph face boundaries. It then rasterises those polygons to fill the `zoneGrid` layer. But the rasterisation can disagree with the polygon — cells near polygon edges may be inside or outside depending on the rasterisation algorithm and grid alignment.

Meanwhile, flood-fill zones start from cells and trace boundaries afterward. The boundary polygon is an approximation of the cell blob, not the other way around.

**Fix direction:** The polygon is always source of truth. Rasterise from polygon to cells, never reconstruct polygon from cells. Accept that cell-level precision is limited by grid resolution.

### 5. Road width not accounted for in zone polygons

Zone polygons extend to road centrelines (the graph edge), not to the road edge. The actual buildable area is smaller — inset by half the road width. Currently this isn't computed, so zones appear to overlap the road surface.

**Fix direction:** Compute inset polygons (the buildable envelope) by shrinking the zone polygon inward from each road boundary by half-road-width + sidewalk. This is the land-model spec's "inset polygon" concept.

## Migration Priority

1. **Unify zone extraction** — one path (flood-fill + trace + match to graph edges), polygon as source of truth, zoneGrid derived
2. **Create parcel objects** — when agents allocate, create polygons with edge classification, reservationGrid derived
3. **Compute inset polygons** — width accounting from road boundaries
4. **Store plots** — polygon objects during subdivision, not transient
5. **Add bidirectional references** — road↔zone, road↔parcel lookups
