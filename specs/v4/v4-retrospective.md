# V4 Retrospective: What We Learned

## The V4 Thesis

Cities are neighborhoods connected by roads. Start with terrain, place nuclei on buildable land, connect them with pathfound roads, then grow outward. This mirrors how real cities form and how the regional pipeline already works.

## What's Solid (carry forward)

### Regional generation
Terrain, geology-responsive coasts, drainage networks, settlement placement, road connectivity — all proven. No architectural changes needed.

### Terrain refinement
Bilinear upsampling + Perlin detail, slope recomputation, river channel carving. The import pattern (inherit regional data, refine at city resolution) is correct.

### River model
Vector paths with per-vertex width from accumulation, Chaikin smoothing, shared geometry module (`riverGeometry.js`). Single source of truth consumed by terrain carving, waterMask painting, and rendering. The pattern: **create the authoritative representation once, derive everything else from it.**

### Anchor route import
Shared-grid approach: pathfind regional roads onto a usage grid at city resolution, extract segments between junctions. Eliminates overlapping roads by construction. Re-pathfinding at city resolution is the right way to inherit regional roads.

### Nucleus connectivity
Union-Find + Kruskal's MST guarantees all nuclei are connected before the growth loop starts. Importance-derived hierarchy (continuous 0-1 score from tier, path length, cluster bridging) is cleaner than string labels.

### Buildability grid
Single source of truth for "can we build here?" Composites elevation, slope, water, edge margin, waterfront bonus into one float32 grid. Incremental zeroing when roads/plots are stamped. Eliminates the 5 duplicated buildability checks that existed before.

### Bridge detection
Two-phase: initial pass after anchor routes, incremental on every `stampEdge`. Roads added at any pipeline stage automatically register bridges. Bresenham rasterization of polylines for reliable detection.

### Debug viewer
9-layer composition, tick-by-tick stepping, seed propagation, URL deep-linking. Essential for understanding algorithm behavior. **Should have been built first, not midway through.**

## What Broke (don't repeat)

### A* growth produces spaghetti roads
The fundamental problem: A* pathfinding on a 10m grid with complex cost functions cannot produce regular block patterns. Roads weave around each other, creating dense organic spaghetti instead of structured street grids. Parameter tuning (proximity penalties, reuse discounts) helps at the margins but can't fix the core issue. **The growth algorithm needs to think in blocks and plots, not individual pathfound roads.**

### Road merging is fragile
`addMergedRoads` splits and reconnects edges, sometimes leaving orphaned fragments or disconnected components. Requires safety-net phases with direct `addEdge` calls. The merge pipeline assumes the graph stays planar through all operations — any desync cascades silently.

### Bitmap coordination is manual and error-prone
Adding a road means updating 3-5 data structures (occupancy, buildability, bridgeGrid, waterMask, bridges array) in the right order. Pipeline ordering is fragile: `attachGrids` must be called after `identifyRiverCrossings` but before stamping. Forgetting a step creates silent failures. **The map doesn't know what's on it.**

### Resolution mismatch (3m occupancy vs 10m terrain)
The occupancy grid runs at 3m for fine road stamping, but buildability and pathCost operate at 10m. A road stamps and zeros buildability for a 10m cell, but pathCost samples a single 3m occupancy cell that might miss the road mark. Result: dark-edge artifacts where road borders appear impassable. Fix was to scan all occupancy cells within a terrain cell, but this is a symptom of the architectural problem.

### Regional geometry doesn't translate cleanly
Regional roads go through multiple coordinate transforms (50m grid → world coords → city grid → A* path → smooth polyline → world coords). Each step makes assumptions about the input space. If any step produces inconsistent coordinates, bridge detection rasterizes to wrong cells, missing water crossings entirely.

## Architectural Lessons

### 1. Features first, grids second
A road is a polyline with width. A river is a polyline with per-vertex width. A plot is a polygon. These features are the source of truth. Grids (occupancy, buildability, waterMask, bridgeGrid) are **views** of the feature set at particular resolutions. Each grid should rasterize from the same feature geometry independently — no resolution mismatch possible.

### 2. Adding a feature should update everything automatically
`map.addFeature(road)` should update occupancy, buildability, bridgeGrid, and any other derived layer in one call. No manual multi-step stamping. No pipeline ordering dependencies. The FeatureMap proposal (specs/v6/feature-map-architecture.md) describes this.

### 3. One resolution per map, or principled multi-resolution
Three resolutions (3m, 10m, 50m) cause subtle bugs. Options: single resolution per map (5m compromise?), or feature-driven rasterization where each grid rasterizes at its own resolution from the same feature geometry.

### 4. Debug visibility before algorithm development
The debug viewer revealed problems (spaghetti roads, terrain over-penalization, nucleus clustering) that were invisible from test output alone. Build the viewer first next time.

### 5. Cost functions are fragile and contextual
Small changes in reuse discounts or penalties dramatically change behavior. Different use cases need different presets (MST connections want strong reuse, shortcuts want none). The space is hard to navigate. Document presets and their rationale.

### 6. Block subdivision, not road projection
The growth algorithm should think in blocks (enclosed space between roads) and subdivide them into plots. Not: pathfind a road, then project plots perpendicular to it. Real streets create blocks; blocks create plots. Getting this causal chain right prevents plot overlaps by construction.

### 7. Occupancy grid is a band-aid
The 3m occupancy grid exists because plots and roads need fine collision detection. But if blocks are derived from planar graph faces (enclosed regions between roads), collision is handled by topology — plots can't overlap roads because they're carved from the space between them.

## What V5 Should Focus On

1. **FeatureMap class** — wraps all spatial data, handles incremental grid updates automatically
2. **Block-based growth** — extract planar faces from road graph, subdivide as blocks, not individual road pathfinding
3. **Debug viewer as day-one tooling** — not an afterthought
4. **Single resolution or feature-driven rasterization** — eliminate the 3m/10m mismatch
5. **Neighborhood character** — each nucleus type (oldTown, waterfront, market, suburban) drives plot dimensions, street spacing, building types. Currently all treated identically.

## What to Keep From V4 Code

| Module | Status | Notes |
|--------|--------|-------|
| Regional pipeline (A1-A7) | Keep | Stable, no changes needed |
| `riverGeometry.js` | Keep | Shared width/depth/profile functions |
| `importRivers.js` | Keep | Vector path import + Chaikin refinement |
| `classifyWater.js` | Keep | Sea/lake/river flood-fill classification |
| `refineTerrain.js` | Keep | Channel carving from shared profile |
| `extractWaterPolygons.js` | Keep | Marching squares boundary extraction |
| `buildability.js` | Refactor | Move into FeatureMap as derived layer |
| `pathCost.js` | Refactor | Parameterized presets are good; grid sampling needs FeatureMap |
| `roadOccupancy.js` | Replace | Absorbed into FeatureMap |
| `generateAnchorRoutes.js` | Keep core | Shared-grid approach is sound; merge pipeline needs cleanup |
| `connectNuclei.js` | Keep | Union-Find MST is correct |
| `seedNuclei.js` | Keep | Buildability-aware placement works |
| `growCity.js` | Rewrite | A* spaghetti needs fundamentally different approach |
| `PlanarGraph.js` | Keep | Core data structure, well-tested |
| Debug viewer | Keep | Essential tooling |
| Interactive pipeline | Refactor | Wrap with FeatureMap |
