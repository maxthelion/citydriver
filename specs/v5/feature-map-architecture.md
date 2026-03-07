# Architectural Discussion: Unified Feature Map

## Status: Proposal (not implemented)

## The Problem

The current system has two separate map representations — regional (50m, `LayerStack`) and city (10m, separate `LayerStack`) — each with their own grids, their own stamping logic, and their own derived bitmaps. Features like roads, rivers, and bridges are added through bespoke code paths, and each code path is responsible for updating every affected bitmap. This has produced a growing list of coordination bugs:

- **Bridge detection misses roads** because `detectBridgeCells` and `identifyRiverCrossings` are two separate systems with different walking strategies (vertex vs Bresenham), different triggering conditions (requires `attachGrids` to have been called), and different pipeline positions.
- **Buildability gets out of sync** because stamp operations zero it incrementally but the occupancy grid samples at 3m while buildability lives at 10m. The resolution mismatch creates dark-edge artifacts in pathCost.
- **Regional geometry doesn't translate cleanly** because regional roads are in 50m grid space, go through multiple coordinate transforms, and arrive in the city graph through a different code path than city-generated roads. Each code path makes its own assumptions about what bitmaps to update.
- **Pipeline ordering is fragile** — `attachGrids` must be called after `identifyRiverCrossings` but before stamping, `computeBuildability` must be called after `refineTerrain` but before anything reads it. Getting this wrong produces silent failures (bridges not detected, buildability not updated).

The root cause: **the map doesn't know what's on it.** Grids and graphs are independent data structures. Adding a road means writing to 3-5 different data structures in the right order, and forgetting one creates a bug that's hard to detect.

## The Idea

A single `FeatureMap` object that:

1. Operates at a defined resolution (cell size)
2. Maintains a set of **features** (roads, rivers, plots, buildings)
3. Maintains a set of **derived layers** (buildability, pathCost inputs, bridgeGrid, waterMask)
4. When a feature is added via `addFeature(feature)`, the derived layers update automatically

Both the regional map and the city map would be instances of the same class, just at different resolutions. Features added at the regional level are inherited by the city map through coordinate transform and optional re-resolution (e.g. re-pathfinding roads, subdividing river curves).

## What a Feature Is

A feature is a typed geometric object placed on the map:

```
{ type: 'road', polyline: [...], width: 12, hierarchy: 'arterial' }
{ type: 'river', polyline: [...], widths: [...], accumulations: [...] }
{ type: 'plot', polygon: [...], usage: 'residential' }
{ type: 'building', polygon: [...], height: 8 }
```

Features carry their own geometry and metadata. The map doesn't need to know about PlanarGraph or road hierarchy rules — it just knows how to stamp different feature types onto its grids.

## What Derived Layers Are

Each derived layer is a grid that can be recomputed from the feature set + terrain. But full recomputation is expensive. The key insight from the current bitmap pipeline work: **most updates are incremental**. Adding a road only affects the cells it covers. So:

- **On add**: the new feature's footprint is computed and the affected cells in each derived layer are updated. For buildability, those cells are zeroed. For waterMask, river cells are painted. For bridgeGrid, water crossings are detected along the road's path.
- **On bulk load** (e.g. importing all regional roads at once): batch the updates, or do a single full recompute at the end.
- **On query**: layers are always up to date because adds are immediate.

## What This Replaces

| Current | Proposed |
|---------|----------|
| `createOccupancyGrid` + `attachGrids` + manual stamping | `map.addFeature()` updates all grids |
| `computeBuildability` (separate function, called once) | Buildability is a derived layer, initialized from terrain, zeroed by feature adds |
| `identifyRiverCrossings` + `detectBridgeCells` (two systems) | Bridge detection is part of road-feature add, applied uniformly |
| `stampEdge` + `stampPlot` + `stampJunction` (separate functions) | `addFeature` dispatches to the right stamp logic by type |
| `importRivers` painting waterMask | River features paint waterMask as part of `addFeature` |
| Manual `setGrid`/`setData` calls throughout pipeline | Features and derived layers managed by the map |

## Resolution and Coordinate Spaces

The current system has three resolutions in play:
- City grid: 10m (elevation, slope, buildability, waterMask, bridgeGrid)
- Occupancy grid: 3m (road/plot/junction stamps)
- Regional grid: 50m

The 3m occupancy grid exists because roads need finer resolution than 10m terrain cells. This resolution mismatch is the source of the pathCost dark-edge bug — a 10m cell partially covered by a road has its buildability zeroed but pathCost samples a single 3m cell that might miss the road.

Options:

### A. Single resolution per map
The FeatureMap operates at one resolution. The city map runs at 3m (or 5m as a compromise). Derived layers like buildability are at the same resolution. No mismatch. Cost: more memory and computation for layers that don't need 3m precision.

### B. Multi-resolution with consistent sampling
Keep the current split but make sampling consistent: pathCost scans all occupancy cells within a terrain cell (already implemented as a fix). The FeatureMap manages the resolution mapping internally.

### C. Feature resolution, not grid resolution
Features carry their own geometry at arbitrary precision. The map rasterizes features onto grids at whatever resolution each grid needs. A road is a polyline with width — it can stamp onto a 3m occupancy grid AND a 10m buildability grid from the same source geometry, with no mismatch because each grid does its own rasterization.

**Option C seems most natural.** The feature is the source of truth, and grids are views of it at particular resolutions. This is closest to how the architecture spec describes the world: features cause grid values, not the other way around.

## Regional-City Inheritance

When creating a city map from a regional map:

1. **Terrain layers** (elevation, slope) are interpolated to city resolution — this doesn't change.
2. **River features** are inherited as-is (they're polylines in world coordinates), then subdivided (extra Chaikin pass) for higher resolution. The city map's `addFeature` paints them onto city-resolution waterMask.
3. **Road features** are inherited as coarse polylines, then re-pathfound at city resolution. The re-pathfound result is added via `addFeature`, which handles all grid updates.

The key difference from today: there's no separate "import rivers" or "import roads" step that each has its own bitmap-update logic. Import means: take the feature from the parent map, optionally refine its geometry, and `addFeature` on the child map.

## What This Doesn't Change

- The PlanarGraph still exists for road topology (intersections, edge traversal, etc.)
- A* pathfinding still uses cost functions that read from grids
- The pipeline still has phases (terrain → water → roads → growth)
- The rendering system still reads grids and feature data

The change is in how grid state is managed: features are added to the map, and the map updates its grids. The pipeline orchestrates what features are created and in what order, but doesn't manually manage grid consistency.

## Update Strategy: Immediate vs Per-Tick

Two options for when derived layers update:

### Immediate (current approach, formalized)
Every `addFeature` call updates all affected grid cells before returning. Simple, always consistent, no stale reads. Cost: many small updates if features are added in a loop (e.g. stamping 50 road edges one by one).

### Deferred (mark-dirty, flush on read)
`addFeature` records the feature but marks affected grid regions as dirty. Derived layers are recomputed lazily when read, or explicitly via `map.flush()`. Benefit: batch efficiency. Cost: complexity, possible stale reads if flush is forgotten.

**Recommendation: immediate.** The current incremental approach (zeroing cells in O(affected cells)) is already fast enough. The bugs we're fixing are all about consistency, not performance. Deferred updates add complexity and a new class of bugs (stale reads) for marginal performance gain.

## Migration Path

This doesn't need to be built all at once. Incremental steps:

1. **Wrap occupancy + derived grids in a FeatureMap class** that has `addRoad()`, `addPlot()`, `addRiver()` methods. These call the existing stamp functions internally. The pipeline calls the wrapper instead of raw stamp functions.

2. **Move bridge detection into `addRoad()`** so it always happens when a road is added, regardless of pipeline position or whether `attachGrids` was called.

3. **Move buildability zeroing into the wrapper** so it's guaranteed to happen on every add, with correct resolution mapping.

4. **Extract the regional map** into the same class (different resolution, same interface). River/road import becomes: iterate parent features, transform geometry, `addFeature` on child.

5. **Eventually**: the FeatureMap replaces LayerStack for spatial data. LayerStack persists for non-spatial data (params, config).

## Open Questions

- **Should the PlanarGraph live inside the FeatureMap?** Roads are both features (geometry on the map) and a graph (topology for pathfinding). Currently the graph is the source of truth and the grid is derived from it. If the map is the source of truth, the graph needs to stay in sync. Possibly the graph is a derived structure, rebuilt when roads change — but that's expensive. More likely the graph and the map co-own road data: the graph owns topology, the map owns grid rasterization, and `addRoad` updates both.

- **How do features relate to each other?** A bridge is where a road crosses a river. Currently this is detected by walking road geometry against the waterMask. In the FeatureMap model, should bridges be explicit features added when a road-river intersection is detected? Or should they remain a derived grid (bridgeGrid) computed from road + water features?

- **What about terrain modification?** River channel carving modifies the elevation grid based on river features. This is a feature→terrain feedback that doesn't fit the "features stamp onto derived grids" model cleanly. Terrain might need to be a special case — modified once during setup, then frozen.
