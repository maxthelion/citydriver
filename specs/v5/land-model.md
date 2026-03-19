# Land Model

## Status: Proposal (not implemented)

## Problem Statement

Land in the city generator is described by overlapping, loosely-connected representations that make spatial reasoning difficult.

### Current representations

| Concept | Representation | Defined by |
|---|---|---|
| Zone | Bitmap flood-fill | Cells bounded by road/water/edge |
| Subzone | Bitmap subdivision of a zone | Cuts placed through large zones |
| Reservation | Type label on a zone | Archetype scoring |
| Block | Graph face polygon | PlanarGraph face extraction |
| Ribbon | Strip of cells along a road | Frontage allocation |
| Parcel | Strip within a ribbon | Plot subdivision |
| Plot | Individual lot | Building placement |

### What's wrong

**1. Zones and blocks are the same idea computed two ways.** Zones are bitmap flood-fills bounded by road cells. Blocks are graph face polygons bounded by road edges. Both mean "area enclosed by roads" but they're computed independently and can disagree. A zone might span multiple graph faces. A graph face might straddle two zones.

**2. Navigation between related things is hard.** Given a zone, finding its bounding roads requires scanning the bitmap boundary and matching road cells back to polylines. Given a road, finding the land on either side requires rasterizing and flood-filling. Given a parcel, finding which road it fronts onto is a spatial proximity search. These relationships exist physically but aren't captured in the data.

**3. Roads and boundaries are conflated.** When the pipeline needs to separate two areas, it adds a road. But not every boundary is a road — it could be a river, a railway, a back-lot line, or a planning edge. The only tool available is "add a road," so everything that separates land looks like a road.

**4. Width accounting is implicit.** Road width, sidewalk width, river width, and railway width all consume land, but this is handled by bitmap stamping (zeroing buildability cells). There's no explicit "this face has 5200m² gross, minus 380m² of road surface, leaving 4820m² net buildable." The land budget is never stated, only implied by which cells are non-zero.

**5. Disconnected zones are hard to fix.** Some zones share no edge with the road network — they're bitmap blobs with no topological relationship to anything. Connecting them requires brute-force A* search because the zone doesn't know what's around it or why it's disconnected.

---

## Proposed Model

### Boundaries, not just roads

A **boundary** is anything that separates one area of land from another. Roads, rivers, railways, and map edges are all boundary types. A zone subdivision can place a boundary that later becomes a road, or that remains an administrative line with no physical form.

```
Boundary
  ├── RoadBoundary    → references a Road in the RoadNetwork
  ├── WaterBoundary   → references a river segment
  ├── RailBoundary    → references a railway segment
  ├── EdgeBoundary    → map edge
  └── PlanningLine    → no physical form, just a separation
```

This separates the decision of *where to divide land* from *what kind of thing does the dividing*.

### Blocks as the primary unit

A **block** is a face in the planar graph — an area enclosed by boundaries. It replaces both the current "zone" (bitmap flood-fill) and "face" (graph polygon) with a single concept that has explicit topology.

```js
Block {
  id
  facePolygon       // [{x, z}] — the raw face boundary from the graph
  boundingEdges     // [{ boundaryId, side: 'left'|'right' }]
  insetPolygon      // [{x, z}] — face boundary shrunk by road half-width + sidewalk

  // Land budget
  grossArea         // m² — area of facePolygon
  roadConsumption   // m² — area between facePolygon and insetPolygon
  waterConsumption  // m² — river/canal overlap
  railConsumption   // m² — railway overlap
  netBuildable      // m² — grossArea minus all consumption

  // Allocation
  reservation       // 'residential' | 'industrial' | 'commercial' | ...
  parcels           // allocated strips of buildable land
  plots             // individual lots cut from parcels
}
```

### Bidirectional road-area references

Each road knows which blocks it bounds. Each block knows which roads enclose it. This is computed from the planar graph face extraction and persisted.

```
Road A ←→ Block 1 (left side)
Road A ←→ Block 2 (right side)
Block 1 ←→ [Road A, Road B, River segment 3]
```

"Give me the roads around this block" and "give me the blocks on either side of this road" are O(1) lookups, not spatial searches.

### Inset polygons for width accounting

The **inset polygon** is the face polygon shrunk inward by half-road-width + sidewalk for each bounding road edge. This is the actual buildable envelope — the land that's physically available after road surfaces and sidewalks are subtracted.

Ribbon allocation and plot cutting operate on the inset polygon, not the raw face. This makes width accounting explicit and consistent.

### Zones as groups of blocks

A **zone** becomes a group of adjacent blocks that share a reservation type, not an independently-computed bitmap region. Zone operations (like "subdivide this zone") become graph operations (like "add a boundary edge that splits this face into two faces").

---

## Containment hierarchy

```
City map
  └── Blocks (graph faces, defined by boundaries)
        ├── boundary references → Roads, Rivers, Railways, Edges
        ├── inset polygon → net buildable area
        ├── reservation type → residential, industrial, ...
        └── Parcels (strips of buildable land along a road frontage)
              └── Plots (individual lots)
                    └── Buildings
```

Zones are an optional grouping layer over blocks — useful for labelling ("the industrial district") but not a separate spatial primitive.

---

## Invariants

These rules should always hold. An integration test suite can check them after each pipeline stage to catch the stage where an invariant first breaks.

### Land accounting

- **Cell exclusivity**: every cell is exactly one of road, water, railway, buildable, or unbuildable. No overlaps, no gaps. The sum equals width × height.
- **Buildability consistency**: no buildable cell is under a road, river, or railway.
- **Width accounting**: no buildable cell is within `road.width / 2` of a road centerline. Same for river half-width and railway half-width.

### Containment

- Every plot is inside exactly one block.
- Every block is inside the map bounds.
- No plot boundary extends beyond its containing block's inset polygon.
- Every block's inset polygon is strictly contained within its face polygon.

### Topology

- **Face coverage**: every non-road, non-water cell belongs to exactly one graph face. No cell belongs to two faces. No cell is in no face.
- **Face-road duality**: every road in the network has exactly two faces on either side (or one face and the outer/edge face).
- **No orphan blocks**: every block shares at least one boundary edge with the road network. If a block has no bounding road, it's either a bug or a missing road.

### Road network (from road-network-abstraction.md)

- Every graph node has degree >= 1.
- Every road in the RoadNetwork has a corresponding graph edge.
- Every graph edge corresponds to a road in the RoadNetwork.
- Road grid cells form connected paths — no isolated road pixels.

### Connectivity

- **Reachability**: every block's bounding road is reachable from every other block's bounding road via the road graph. If not, a connecting road must be added.
- **No landlocked blocks**: no block is completely enclosed by water with no bridge access.

### Monotonicity during the pipeline

- Total road cells never decrease between growth ticks (roads are added, not removed).
- Total buildable cells never increase after skeleton roads are placed (things only consume land, never create it).
- Once a cell is claimed by a plot, it stays claimed.

---

## How this fixes the disconnected-zone problem

With the current model, a disconnected zone is a bitmap blob with no topological relationship to anything. Finding the nearest road is a brute-force search.

With blocks as graph faces: a disconnected block means a face whose bounding edges are all water/edge boundaries with no road boundary. This is structurally visible — you can query "which blocks have no road boundary?" The fix is a graph operation: find the nearest node on the road network to the block's centroid, extend a road edge to it, which splits the block's face and gives it a road boundary.

The connectivity invariant catches this automatically: after each pipeline stage, check that every block has a road boundary and that all road boundaries are in the same connected component.

---

## Migration path

This is a larger change than the road network abstraction. A pragmatic approach:

1. **Add invariant checks first** — write the integration tests that check cell exclusivity, width accounting, and connectivity against the *current* model. This finds existing bugs without changing any code.

2. **Unify zones and graph faces** — replace bitmap flood-fill zone extraction with graph face extraction. Zones become faces. This eliminates the dual-representation disagreement.

3. **Add bidirectional references** — when faces are extracted, store block→road and road→block references. This makes navigation O(1).

4. **Add inset polygons** — compute the buildable envelope per block from road widths. Ribbon allocation and plot cutting use the inset instead of scanning the bitmap.

5. **Introduce boundary types** — allow zone subdivision to place planning lines (not just roads). A planning line can later be promoted to a road if the pipeline decides one is needed.

Steps 1-2 give the biggest immediate payoff. Steps 3-5 build on that foundation.

---

## What doesn't change

- The RoadNetwork abstraction (just implemented) — roads stay as they are.
- River and railway representation — these are write-once and work fine.
- The rendering pipeline — it reads polylines and grids, not zones.
- Plot placement and building generation — these consume parcels, which are downstream of blocks.
