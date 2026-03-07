# V5: Statement of Intent

## What This System Is

A generative world builder. It creates a region grounded in geological first principles — rock types determine terrain, terrain determines drainage, drainage determines rivers and coastline, land cover follows from all of these. Settlements are placed where geographic advantages concentrate. Roads connect them along paths of least resistance.

The system has two scales:

**Regional** (50m resolution, ~100km²). Generates the geology, terrain, hydrology, coastline, land cover, settlement placement, and road network. Viewed in a 3D region viewer with a minimap. Any settlement can be selected.

**Micro** (10m resolution, ~3km²). A zoomed-in view of a single settlement and its surroundings. Inherits everything from the regional map and refines it at higher resolution. This is where cities grow.

The micro view has two modes:
- **3D view** — the rendered world
- **Debug view** — a bitmap viewer showing the internal state of generation, with manual tick controls to step through growth incrementally

## The Core Loop

The micro area is built incrementally. Each tick adds complexity. The viewer lets you watch it happen.

### Tick 0: Setup

Inherit the regional data. Refine terrain at 10m. Import river paths, paint water, classify water bodies. Compute the initial buildability surface from terrain alone — the "blank canvas" of what's buildable.

### Tick 1: Satellite settlements and road skeleton

Place satellite nuclei across buildable land. These are the seeds of future neighborhoods — a market town center, a waterfront district, a hilltop village. Connect them to the regional road network via pathfound routes (Union-Find MST ensures connectivity). Stamp these roads onto the map. The buildability surface updates: road corridors are now occupied, bridges are detected where roads cross water.

This is the initial state the debug viewer shows. A terrain map with water, a road skeleton connecting settlement nuclei, and a buildability surface showing where development can happen.

### Ticks 2+: Growth

Each subsequent tick adds features to the map. Every feature added updates the derived bitmaps immediately (buildability zeroed for occupied cells, bridge detection for roads crossing water, etc). Growth stops when: population target reached, all buildable land consumed, or diminishing returns.

**The key open question for V5 is: what does each tick actually do?**

We know what it starts from (road skeleton + buildable land surface) and what it should produce (a city with blocks, plots, buildings, density gradient). We don't yet know the right algorithm for the middle.

### What we've tried and what failed

**V4: A* pathfinding individual roads.** Each growth tick pathfinds new roads using cost functions with terrain penalties, road reuse discounts, and occupancy awareness. The implementation was unsophisticated — roads were pathfound one at a time with no awareness of the block structure they were creating. The result was spaghetti. But the failure may be in the implementation, not the technique. Pathfinding with better heuristics (target points chosen to close blocks, cost functions that reward parallel/perpendicular alignment to nearby roads, explicit block-length constraints) might work well. A* is still the right tool for routing a road across complex terrain — the question is what the start points, end points, and cost function should be.

### Ideas to explore

Several approaches are worth prototyping. None is proven. The debug viewer exists precisely to evaluate these visually, tick by tick.

**Frontage + pressure.** Roads have two sides. Each side has frontage that can be filled with plots. When frontage fills up, "pressure" builds for new roads: a back lane appears behind filled plots (depth pressure), cross streets appear when a plot row gets too long (block length pressure). New roads create new frontage. The cycle repeats. Block structure emerges from pressure thresholds rather than being imposed. Open questions: how to compute pressure (purely geometric? density-weighted?), how to place back lanes on non-flat terrain, how to handle irregular road geometries, whether this produces realistic results at all.

**Template stamping.** Instead of growing one road at a time, stamp pre-defined block templates (grids, cul-de-sacs, crescents) onto available land, aligned to the nearest existing road. Different neighborhood types use different templates. The challenge: templates need to deform to fit terrain and connect to the existing network at arbitrary angles. Rigid templates on organic terrain will look wrong.

**Voronoi subdivision.** Scatter points on buildable land, compute a Voronoi diagram clipped to existing roads and water, use the Voronoi edges as street candidates. This naturally produces irregular organic patterns. The challenge: connecting Voronoi streets to the existing road skeleton, and ensuring the result has through-routes (Voronoi tends to produce disconnected cells).

**Offset curves.** From each existing road, generate parallel offset curves at fixed intervals (plot depth + road width). Where two offset curves from different roads approach each other, connect them with cross streets. This naturally creates block structure that follows road geometry. The challenge: offset curves from curved roads can self-intersect or diverge, requiring careful geometric handling.

**Smarter pathfinding.** Keep A* but make it block-aware. Instead of pathfinding from "somewhere" to "somewhere else," choose start and end points that would close a block or extend a grid. Use cost functions that penalize deviating from the local street direction (rewarding parallel/perpendicular alignment). Combine with a higher-level planner that decides "this area needs a cross street connecting roads A and B at roughly this interval." Pathfinding handles the terrain; the planner handles the structure. This might combine the strengths of A* (terrain-responsive routing) with geometric regularity.

**Agent-based.** Each nucleus runs its own growth logic, expanding outward from its center. Different nucleus types (market town, waterfront, hilltop) use different expansion strategies. Nuclei negotiate at their boundaries. The challenge: coordination between agents, preventing overlapping growth, ensuring connectivity.

### What any approach must satisfy

Whatever growth algorithm we build, it must:

1. **Produce blocks, not spaghetti.** Roads should enclose space, creating blocks that can be subdivided into plots. Not a dense web of crossing paths.
2. **Respond to terrain.** Streets should follow contours on slopes, avoid water, prefer flat land. Not ignore the landscape.
3. **Create a density gradient.** The center should be denser (smaller plots, more roads per hectare) than the fringe. This should emerge from the growth order, not be imposed.
4. **Be visible in the debug viewer.** Each tick's additions should be inspectable. If we can't see what the algorithm is doing, we can't fix it.
5. **Update the map correctly.** Every road, plot, and building added must update all derived layers through the map's `addFeature` interface. No manual bitmap coordination.
6. **Terminate gracefully.** Population target, land exhaustion, or diminishing returns.

### The exploration strategy

Build the map class and debug viewer first. Then prototype growth algorithms one at a time, using the viewer to evaluate results visually. Start with the simplest approach that could work (probably frontage + pressure, since it's closest to how real towns grow). If it fails, try the next. The viewer makes iteration fast — you can see in seconds whether an approach produces blocks or spaghetti.

## The Map

The central architectural element. Both the regional map and the micro map are instances of the same concept: **a spatial container that holds features and maintains derived layers.**

### Features

A feature is a typed geometric object placed on the map:
- **Road**: polyline with width and hierarchy
- **River**: polyline with per-vertex width
- **Plot**: polygon with usage type
- **Building**: polygon with height and type

Features are the source of truth. They carry their own geometry and metadata.

### Derived layers

Grids computed from the feature set + terrain. Updated when features are added.

- **Buildability** (float32, 0-1): "How suitable is this cell for development?" Composites terrain (slope, water, elevation) with occupation (roads, plots zero it out). Read by plot placement, nucleus seeding, growth target selection.

- **Path cost** (function): "What does it cost to route through this cell?" Reads buildability for terrain suitability, reads features for road reuse discount and plot avoidance penalty. Parameterized per use case (anchor routes vs growth roads vs shortcuts).

- **Water mask** (uint8): "Is this cell water?" Painted from river features and sea-level elevation. Read by bridge detection, terrain carving, rendering.

- **Bridge grid** (uint8): "Is there a bridge here?" Marked where road features cross water. Read by path cost (bridges bypass impassable water).

### The key rule

**When a feature is added, the derived layers update automatically.** No manual multi-step stamping. No pipeline ordering dependencies. No resolution mismatches. The map handles it.

This eliminates the class of bugs from v4 where adding a road required updating 3-5 data structures in the right order, and forgetting one created silent failures.

### Resolution

Features exist at arbitrary precision (polylines in world coordinates). Each derived layer rasterizes features at its own resolution. A road polyline can stamp onto a 3m occupancy layer AND a 10m buildability layer from the same source geometry — no mismatch because each layer does its own rasterization from the authoritative feature.

### Regional-micro inheritance

When creating a micro map from the regional map:
1. Terrain layers are interpolated to micro resolution (existing, works well)
2. River features are inherited as polylines, subdivided with an extra Chaikin pass, added to the micro map via `addFeature` which paints waterMask
3. Road features are inherited as coarse polylines, re-pathfound at micro resolution, added via `addFeature` which updates all grids

No separate "import rivers" or "import roads" code paths with their own bitmap-update logic. Import = take feature from parent, optionally refine geometry, `addFeature` on child.

## Growth Algorithm

**This is the key unsolved problem.** V4 proved that A* pathfinding individual roads on a coarse grid produces spaghetti. V5 needs to find a better approach. The "Ideas to explore" section above lists candidates. None is proven yet.

The strategy: build the map class and debug viewer first, then prototype growth algorithms using the viewer for rapid visual evaluation. Pathfinding isn't ruled out — it's good at terrain-responsive routing. The v4 failure was in how targets were chosen and how cost functions were shaped, not in A* itself. The growth algorithm is the last thing to finalize, not the first.

## What Carries Forward From V4

| System | Status |
|--------|--------|
| Regional pipeline (geology → terrain → hydrology → settlements → roads) | Keep unchanged |
| 3D region viewer with minimap and settlement selection | Keep unchanged |
| River model (vector paths, shared geometry module, Chaikin smoothing) | Keep unchanged |
| Terrain refinement (bilinear + Perlin, slope recompute, channel carving) | Keep unchanged |
| Water classification (sea/lake/river flood-fill) | Keep unchanged |
| PlanarGraph (road topology) | Keep unchanged |
| Anchor route import (shared-grid, re-pathfind at micro resolution) | Keep unchanged |
| Nucleus connectivity (Union-Find MST) | Keep unchanged |
| Buildability computation (terrain-only base) | Refactor into map derived layer |
| Path cost presets (parameterized cost functions) | Keep, adapt to read from map |
| Debug viewer (9-layer bitmap composition, tick controls) | Keep, extend |
| Occupancy grid + stamp functions | Replace with map feature system |
| Growth algorithm (A* road pathfinding) | Replace with frontage/pressure model |
| Road merging (`addMergedRoads`) | Simplify or remove |

## What's New in V5

1. **Map class** with `addFeature()` and automatic derived layer updates
2. **Frontage/pressure growth** instead of A* road pathfinding
3. **Tick-by-tick debug viewer as day-one tooling** — build the viewer before the algorithm
4. **Neighborhood character** — each nucleus type (oldTown, waterfront, market, suburban) drives plot dimensions, street spacing, building density
5. **Feature-driven rasterization** — no more 3m/10m resolution mismatch

## What We're Not Doing Yet

- Building detail (footprints, heights, facades, materials) — comes after growth works
- Economic simulation (trade, competition between settlements)
- Temporal layering (historic core vs later expansion rings)
- Interior/street-level detail
- Defensive structures (walls, castles)
