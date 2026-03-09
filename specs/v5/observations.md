# V5 Observations

## Land Value vs Buildability vs Availability

**Date:** Step 1 debugging, nucleus placement

**Problem:** Nucleus placement produces evenly-spaced grids instead of clustering at interesting locations. The scoring formula `0.5 * buildability + 0.5 * spacingBonus` treats buildability as a proxy for "where should a neighborhood be?" but buildability only encodes slope suitability and water avoidance. It answers "can you build here?" not "should you build here?"

**Three distinct concepts are currently conflated:**

1. **Land value** — how desirable is this location? Driven by proximity to: waterfront edges, hilltop views, road junctions, the town center, river crossings. This is the "why would anyone settle here?" signal. High-value spots are specific points/edges on the map.

2. **Buildability** — how physically easy is it to build here? Driven by: slope, soil stability, not underwater. This is a terrain property. A cliff has low buildability regardless of the view.

3. **Availability** — is this cell free? Not already occupied by a road, building, water body, or other feature. Changes over time as features are added.

These are linked but different. A waterfront hilltop with gentle slopes has high value AND high buildability. A steep cliff with ocean views has high value but low buildability. A flat field far from anything has high buildability but low value.

**Proposed approach: value bitmap with Gaussian blur**

Paint high-value source points directly onto a bitmap:
- Water edges (shoreline, riverbanks) — walk the waterMask boundary, paint those cells
- Hilltops — local elevation maxima (prominence above surroundings)
- Road junctions — cells where 3+ road directions meet
- Town center — the settlement origin point
- Bridge crossings — where roads cross water (rare, high value)

Then apply a Gaussian blur to spread value outward from sources. This naturally creates:
- Waterfront districts that fade inland
- Hilltop neighborhoods that extend down slopes
- Town center value that falls off with distance
- Road corridor value that drops off perpendicular to the road

The blur radius could vary by source type (town center: wide spread, waterfront: tighter).

**How nucleus placement would use it:**
```
suitability = value * buildability * availability
```
Multiplicative, not additive — a high-value unbuildable cell scores zero. A buildable cell with no value scores low. Only cells that are valuable AND buildable AND available score high.

**Implementation sketch:**
- New derived layer on FeatureMap: `landValue` (Float32, 0-1)
- Computed after terrain + water + roads are set up (tick 0 or start of tick 1)
- Source painting is fast (iterate waterMask boundary, find local maxima, etc.)
- Gaussian blur via two-pass separable filter (horizontal then vertical), O(n) per pixel
- Recomputed when roads are added (road junctions become value sources)
- Nucleus placement reads it directly: no custom scoring logic needed
- Growth algorithms can also use it: grow toward value, not just outward

**What this replaces:**
The ad-hoc `_nicheQuality()` function currently in skeleton.js, which computes the same terrain features but as a one-off scoring function rather than a reusable bitmap. That function should be removed once landValue exists.

**Open questions:**
- Should landValue update incrementally (addFeature stamps new sources + re-blurs locally) or recompute fully each tick?
- What blur radius feels right? Probably 15-25 cells (150-250m) for most sources, larger for town center.
- Should different source types have different intensities? (Town center = 1.0, waterfront = 0.8, hilltop = 0.6?)

**Status:** Implemented. landValue is a derived layer on FeatureMap, computed in setup (tick 0). Nucleus placement uses `value * buildability * spacingBonus`. Nuclei feed back into value when placed. Roads feed back via junction/bridge detection.

## City Roads: Grid-locked angles and diamond loops

**Date:** Step 1 debugging, skeleton roads

**Problem:** Roads at city scale look grid-aligned (strict horizontal/vertical/diagonal) and create diamond loop patterns where multiple roads share a corridor.

**Root cause — grid-locked angles:**
A* runs on an 8-connected grid (cardinal + diagonal neighbors). The resulting path is a staircase of grid cells. `simplifyPath` (Ramer-Douglas-Peucker) reduces this to key waypoints, then `smoothPath` (Chaikin corner-cutting) softens angles. With epsilon=1.5 and 2 Chaikin iterations, the smoothing was insufficient — roads still visibly snapped to 0°/45°/90° angles.

**Mitigation applied:** Reduced simplification epsilon to 1.0 (keeps more waypoints) and increased Chaikin iterations to 4. This helps significantly but doesn't eliminate the underlying grid artifact. True fix would be to pathfind on a non-grid structure (e.g. visibility graph, or add random perturbation to grid positions before pathfinding).

**Root cause — diamond loops:**
When multiple roads share a corridor, each runs independent A*. The `reuseDiscount` (0.1–0.5) makes existing road-grid cells cheap to traverse, but A* still finds cell-by-cell paths. Two paths through the same corridor can follow slightly different cell sequences (1 cell offset), both hitting road-grid cells but creating distinct polylines. After smoothing, these become near-parallel curves that cross at intervals — the diamond pattern.

This is the same problem as regional duplicate parallel routes (see known-issues.md). The reuse discount encourages sharing the same *area* but not the same *exact path*.

**Possible fixes (not yet implemented):**
1. **Polyline snapping:** When a new A* path follows an existing road for >N cells, snap those segments to the existing road's polyline rather than keeping the cell-by-cell path. Requires checking proximity to existing road polylines during or after pathfinding.
2. **Road merging pass:** After all roads are placed, detect near-parallel segments and merge them into a single polyline with increased width.
3. **Graph-based routing:** Instead of grid A*, route new connections along existing graph edges where possible, only grid-pathfinding for new segments that leave the existing network.

Option 3 is probably the right long-term approach — it's how real road networks grow. New roads branch off existing ones rather than independently pathfinding through the same terrain.

**Update:** The real root cause of the diamond loops is simpler than any of the above: the city skeleton doesn't use `mergeRoadPaths` at all. The regional pipeline does — it collects all raw cell paths, merges shared segments, then smooths. The city skeleton skips the merge entirely, smoothing and adding each road as a separate feature the moment it's pathfound. See "Failed abstraction" observation below.

## Failed abstraction: regional and city road building are the same pipeline

**Date:** Step 1 audit

**Problem:** The regional pipeline and city skeleton implement the same algorithm independently, with different code, and the city version is worse because it skips the merge step.

### What the two pipelines do

**Regional** (`generateRoads.js`):
1. Build connection list (settlement pairs, sorted by hierarchy)
2. Pathfind each with shared cost (stamp roadGrid after each for reuse discount)
3. **Merge shared segments** via `mergeRoadPaths`
4. Simplify (RDP) → assign hierarchy from cell membership
5. Output road objects with rawPath + simplified path

**City** (`skeleton.js`):
1. Build connection list (anchor routes + MST nucleus pairs)
2. Pathfind each with shared cost (stamp roadGrid via `addFeature` after each)
3. **— merge step missing —**
4. Simplify → smooth → immediately `addFeature` as separate road
5. Add to PlanarGraph

Steps 1-5 are structurally identical. The difference is that the city version adds each road as a feature immediately after pathfinding, which means: (a) no merge is possible because roads are already separate features, (b) smoothing happens per-road rather than per-merged-segment, creating independent polylines that run near-parallel through shared corridors.

### What the spec said

`statement-of-intent.md:74-76`:
> Both the regional map and the micro map are instances of the same concept: **a spatial container that holds features and maintains derived layers.**

`feature-map-architecture.md:25`:
> Both the regional map and the city map would be instances of the same class, just at different resolutions.

`technical-reference.md:229-236` (Anchor Route Import):
> 1. Sort regional roads by hierarchy
> 2. Pathfind each onto city grid with shared cost
> 3. Stamp onto shared roadGrid
> 4. **Merge pipeline: split shared segments at divergence points**

`statement-of-intent.md:142`:
> Road merging (`addMergedRoads`) | **Simplify or remove**

The spec calls for merging at step 4 and says to "simplify" the merge abstraction — meaning fold it into the shared pipeline, not eliminate it. The implementation eliminated it.

### Why this happened

The spec described the *what* (unified FeatureMap, addFeature updates everything, both scales use the same class) but not the *how* at the pipeline level. It described FeatureMap as a data container with auto-updating derived layers, but didn't define a shared `buildRoadNetwork()` function that both scales would call. The regional pipeline was kept unchanged ("Keep unchanged" in the migration plan), and the city skeleton was written from scratch against the FeatureMap API. Because `addFeature` makes it easy to add one road at a time with automatic grid updates, the city skeleton naturally fell into a pattern of pathfind-one → addFeature → pathfind-next. The merge step was never forced by the API — it was an optional optimization that got dropped.

The spec was too focused on the *data model* (features, derived layers, auto-updates) and not enough on the *workflow* (collect → merge → smooth → add). The FeatureMap API actively encouraged the wrong pattern by making single-road addition so easy.

### What should exist: `buildRoadNetwork()`

A shared function that both pipelines call:

```
buildRoadNetwork({
  grid: { width, height, cellSize },
  costFn,                              // or cost preset name
  connections: [{ from, to, hierarchy }],
  roadGrid,                            // stamped during pathfinding for reuse
  mergeOptions: { enabled: true },
  smoothOptions: { simplifyEpsilon: 1.0, chaikinIterations: 4 },
}) → [{ cells, polyline, hierarchy, width }]
```

The function does: pathfind all → stamp grid between each → merge shared segments → simplify → smooth → return. The caller decides what to do with the results (the regional pipeline stores them as data, the city skeleton calls `addFeature` for each).

Both the regional pipeline and the city skeleton reduce to:
1. Build their connection list (different logic per scale)
2. Call `buildRoadNetwork()`
3. Handle the output (different per scale)

### The river problem is the same pattern

The spec says (`statement-of-intent.md:114-117`):
> River features are inherited as polylines... subdivided with an extra Chaikin pass, added to the micro map via `addFeature`. No separate "import rivers" code paths.

But `_extractCityRivers` in `setup.js` IS a separate code path — it walks the regional river tree, clips to city bounds, smooths, and converts to a different format. This should be a shared operation: "inherit features from parent map at higher resolution."

Additionally, river stamping at city resolution (10m cellSize) uses `max(halfWidth, cellSize * 0.75)` = 7.5m minimum stamp radius. This was tuned for 50m regional resolution where it prevents gaps. At 10m it bloats headwater streams to 15m diameter, making them blobby with no taper. The stamp minimum should scale with resolution, or rivers at city scale should use a different painting strategy (e.g. direct polyline rasterization instead of circle-stamping).

### Plan to fix

**Phase 1: Extract shared road builder**
- New file: `src/core/buildRoadNetwork.js`
- Function: pathfind connections → stamp grid → merge → simplify → smooth → return
- Refactor `generateRoads.js` to call it (replacing its inline pathfind+merge loop)
- Refactor `skeleton.js` to call it (replacing `importAnchorRoutes` + `connectNuclei` road pathfinding)
- Both callers build their own connection lists, then hand off to the shared function

**Phase 2: Fix river resolution**
- Scale the minimum stamp radius by resolution: `max(halfWidth, cellSize * 0.75)` should use the *source* resolution for the min threshold, not the *target* resolution
- Or better: at city scale, use actual river width without the `cellSize * 0.75` floor, since 10m cells are fine-grained enough that narrow rivers don't need inflation
- Move river inheritance into a shared utility rather than the ad-hoc `_extractCityRivers`

**Phase 3: Shared feature inheritance**
- `FeatureMap.inheritFrom(parentMap, bounds, options)` — clips parent features to bounds, optionally refines geometry (extra Chaikin for rivers, re-pathfind for roads), adds via `addFeature`
- Both rivers and roads use the same inheritance path
- This is the "no separate import code paths" the spec called for

### What the spec should have said

The spec described the data model well but missed the workflow. To prevent this class of error, the spec should have included:

1. **Pseudocode for the shared pipeline**, not just the data model. "Both scales call `buildRoadNetwork(connections, costFn, grid)` which does pathfind → merge → smooth → return" — one sentence that makes the shared abstraction concrete.

2. **An explicit "shared code" section** listing functions that must be reused across scales, not just data structures. The spec listed "Keep unchanged" for systems and "Refactor into map" for data, but didn't say "these functions are called by both scales."

3. **API friction for the wrong pattern.** The spec could have noted: "addFeature for roads should accept a batch of raw cell paths and merge internally, rather than accepting pre-smoothed polylines one at a time." This would have made the merge step mandatory rather than optional.

4. **A concrete test:** "After skeleton tick, no two road features should have polylines within 20m of each other for more than 50m of length" — this directly tests for the diamond/parallel bug and would have caught the missing merge immediately.

## The Growth Problem: Filling Cities with Organic Streets

**Date:** Step 2 design exploration

### The core problem

The skeleton gives us arterial roads connecting nuclei across the city. Plots can be placed along these arterials. But the arterials are sparse — they create large empty regions between them. The problem is: **how do we fill those regions with a network of smaller streets that looks organic and creates usable blocks?**

### What we've tried and why it failed

**V4: Parallel roads without cross streets.** Arterial roads had layers of smaller roads running parallel to them, but there were no cross streets connecting them. The result was strips of frontage along each road with dead space between strips. No enclosed blocks.

**V4: A* growth roads.** Individual roads pathfound from "somewhere" to "somewhere else" using cost functions. The roads were terrain-responsive (good) but had no awareness of the block structure they were creating (bad). The result was spaghetti — a tangle of crossing paths with no enclosed spaces.

**V5 skeleton: Clusters connected by MST.** Place nuclei, connect them. The intention was to create polygons (enclosed by roads) that could then be subdivided into rows of streets. This is architecturally right — enclosed polygons are the precursor to blocks. But two concerns remain:

1. **Connections are too straight.** A* on a grid produces grid-locked paths. If there are contour gradients or rivers, we want roads to follow them, not cut across. A* with terrain cost helps but the grid artifact dominates at city scale.

2. **Balance of connections.** Too many connections and roads eat into the building budget. Too few and there aren't enough enclosed faces to subdivide. The MST gives the minimum spanning tree — exactly N-1 edges for N nuclei — which may be too few. But adding random extra edges risks spaghetti again.

### The key insight

**The problem isn't "how to draw roads" — it's "how to create enclosed regions and subdivide them."**

Cross streets tried as standalone A* paths produce spaghetti because they have no structural context — they don't know they're supposed to be closing a block. But if you start with enclosed polygonal faces (from the PlanarGraph) and subdivide them, every new road by definition spans two sides of an existing face, creating two smaller enclosed faces. Spaghetti is structurally impossible because every road has a clear purpose: splitting a face.

The PlanarGraph already has `faces()` and `facesWithEdges()` for extracting enclosed polygons. This is the key primitive.

### Options for growth

---

#### Option A: Recursive face subdivision (top-down)

**How it works:** After skeleton, extract faces from the PlanarGraph. Each face is a polygon enclosed by roads. For faces larger than a target block size:
1. Find the two longest edges of the face
2. Pick points on each (midpoints, or nearby high-buildability points)
3. Connect them with a new road (pathfound via A* so it follows terrain)
4. This splits the face into two smaller faces
5. Recurse until faces are block-sized (e.g. 40-80m across)

Each subdivision adds exactly one road connecting two points on existing roads. The road is guaranteed to be useful (it splits an oversized block). Density gradient emerges naturally: center faces are subdivided first (they're closest to the skeleton), fringe faces last.

**Terrain response:** The connecting road is A* pathfound, so it follows contours on slopes and avoids water. On flat land it goes roughly straight; on slopes it curves. The endpoints are on existing roads so connectivity is guaranteed.

**Strengths:** Structurally guarantees blocks (no spaghetti possible). Every new road has clear purpose. Natural density gradient. Uses existing PlanarGraph infrastructure. Simple to implement.

**Weaknesses:** Tends toward rectangular grid patterns (always connecting opposite edges). May look too regular on flat terrain. The "find two longest edges" heuristic might not produce the most natural-looking splits. Doesn't account for plot dimensions — just splits geometry.

**Variant — asymmetric subdivision:** Instead of always splitting the longest dimension, use land value to decide: high-value faces get smaller target sizes (denser subdivision). Low-value faces get larger targets or aren't subdivided at all (leaving open space at the fringe). Different nucleus types could influence the subdivision pattern — waterfront districts get narrow lots perpendicular to shore, hilltop areas get curved streets following contours.

---

#### Option B: Offset curves + perpendicular connectors

**How it works:** From each skeleton road, generate parallel offset curves at plot-depth intervals (e.g. 30-50m). These are "back lanes" that follow the geometry of the parent road. Where two offset curves from different parent roads approach each other (within 1.5x plot depth), connect them with a perpendicular cross street. Where an offset curve reaches a face boundary (water, map edge, another road), terminate it.

**Terrain response:** Offset curves inherit the curvature of their parent road. If the arterial follows a contour, so do the back lanes. Cross streets are short connectors between nearly-parallel lanes, naturally perpendicular to the flow.

**Strengths:** Produces very natural-looking street patterns. Block dimensions are controlled by the offset distance. Roads naturally follow terrain because they follow existing roads that already follow terrain. Avoids the rectangular-grid look of pure face subdivision.

**Weaknesses:** Offset curves from curved roads can self-intersect (inner side of a curve). Need careful handling at intersections and T-junctions. Doesn't work well for long straight arterials (produces a boring grid). Hard to handle the "gaps" where offset curves from different roads don't quite meet. Complex geometry (offset of a polyline is non-trivial).

---

#### Option C: Frontage pressure (bottom-up, organic)

**How it works:** Place plots along existing road frontage. Each plot has a front (on the road) and a back. When enough plots fill up on one side of a road:
- **Depth pressure:** A back lane appears behind the filled plots, creating new frontage
- **Block length pressure:** When a row of plots exceeds a target length without a cross street, insert a cross street perpendicular to the road

New roads create new frontage → new plots → new pressure → new roads. The cycle is self-organizing.

**Terrain response:** Plot placement skips unbuildable cells. Back lanes are pathfound through buildable terrain behind plots. Cross streets are short connectors between parallel roads.

**Strengths:** Most organic-looking result. Mimics how real towns grow. Density gradient emerges from growth order (center fills first → first to generate pressure → first to get back lanes). Different neighborhood types can have different pressure thresholds.

**Weaknesses:** Complex to implement correctly. "Pressure" is hard to define precisely. Back lanes on non-flat terrain can be tricky (the "back" of plots on a hillside might be at a very different elevation). Can degenerate into spaghetti if pressure thresholds are wrong. Harder to guarantee connectivity (a back lane might dead-end). Most sensitive to parameter tuning.

---

#### Option D: Medial axis subdivision

**How it works:** For each large face from the PlanarGraph, compute the medial axis (the skeleton/centerline equidistant from all edges). Use the medial axis as the spine for an internal road. Connect the spine to the face edges with perpendicular stubs at regular intervals (block-length spacing).

**Terrain response:** The medial axis naturally follows the shape of the face. If the face is elongated along a contour, the spine runs along the contour. Stubs connect spine to edges, creating blocks.

**Strengths:** Produces a natural "main street + side streets" pattern within each neighborhood. The spine feels like a natural collector road. Stubs create regular blocks. Works well for elongated faces.

**Weaknesses:** Medial axis computation is non-trivial for arbitrary polygons (Voronoi of edges). For convex faces the medial axis may degenerate to a point. The result might look too symmetric. Stubs from both sides of the spine might not align, creating offset intersections.

---

#### Option E: Hybrid — face subdivision + offset infill

**How it works:** Two phases:

**Phase 1 (structure):** Recursive face subdivision using the PlanarGraph. This creates the coarse block structure — splits large faces into medium-sized blocks. Stop subdivision when faces reach "neighborhood" size (~150-200m across), not individual block size.

**Phase 2 (infill):** Within each neighborhood-sized face, use offset curves from the face edges to create the fine street grid. The offset pattern is influenced by the nucleus type for that area:
- **Market/town center:** Dense grid, small offsets (25-30m), cross streets every 50m
- **Waterfront:** Offset curves parallel to water edge, cross streets perpendicular to shore
- **Hilltop:** Contour-following curves, wider spacing
- **Suburban:** Single offset with cul-de-sacs, wide lots

**Terrain response:** Phase 1 roads are A* pathfound (terrain-responsive). Phase 2 offsets follow Phase 1 geometry (inherit terrain response). Nucleus type adapts the pattern to the character of the area.

**Strengths:** Combines the structural guarantees of face subdivision with the organic character of offset curves. Different neighborhoods can have different street patterns. Avoids both pure-grid monotony and spaghetti chaos. Natural density gradient (center neighborhoods get dense infill, fringe neighborhoods get sparse).

**Weaknesses:** Most complex to implement. Two distinct phases means more code and more parameters. Phase 1/Phase 2 boundary is somewhat arbitrary. Risk of the two phases producing inconsistent results.

---

#### Option F: Constrained Voronoi

**How it works:** Within each large face, scatter seed points on buildable land (more seeds in high-value areas, fewer at the fringe). Compute a constrained Voronoi diagram where the face edges are boundaries. Use Voronoi edges as candidate streets. Filter edges that are too short or redundant. Connect remaining edges to existing roads at face boundaries.

**Strengths:** Produces organic, irregular patterns. Natural density variation from seed density. Mathematically clean.

**Weaknesses:** Voronoi edges don't align with terrain. Hard to control block dimensions. Tends to produce T-junctions rather than 4-way intersections (actually realistic for organic towns). Connecting to existing roads at face boundaries is fiddly. Voronoi diagrams don't naturally produce through-routes.

---

### Recommendation

**Option E (hybrid face subdivision + offset infill)** is the most promising because it separates the structural problem (creating enclosed regions) from the character problem (filling them with appropriate streets). But it's also the most complex.

**Option A (recursive face subdivision)** is the simplest to implement and test. It would validate whether the PlanarGraph face infrastructure works correctly and whether face subdivision produces usable blocks. Even if the final result is too grid-like, it's a necessary stepping stone — Options D, E, and F all depend on having correct face extraction.

**Suggested exploration order:**
1. Start with Option A (recursive face subdivision) — simplest, validates infrastructure
2. If too grid-like, try Option E Phase 2 (offset infill within faces) on top of it
3. If that works but feels mechanical, try Option C (frontage pressure) as an alternative growth driver

The key question to answer first: **do the PlanarGraph faces extract correctly after the skeleton?** If we can get clean enclosed polygons, all of Options A/D/E/F become viable. If face extraction is broken, we need to fix it before any of these approaches can work.

## Skeleton Strategy Comparison: Sparse vs Dense Polylines

**Date:** Step 2, skeleton exploration

**Context:** Implemented three skeleton strategies to compare road network generation approaches. The current A* skeleton produces 353 roads with 12,220 polyline points (avg ~35 pts/road) and 144 graph nodes (93 of which are degree-2 pass-throughs). Two alternative strategies were built to test whether simpler geometry produces cleaner networks.

**Three strategies compared:**

1. **Current A* skeleton** — pathfind on grid, simplify (RDP), smooth (4x Chaikin). Produces smooth curves but massive point counts and degree-2 node bloat. The 93 degree-2 nodes are purely smoothing artifacts — they add no topological information.

2. **Straight-line connections** — import regional anchor roads as sparse waypoints (no A*, no smoothing), connect nuclei via MST with direct point-to-point lines. Water crossings avoided by perpendicular waypoint insertion. Produces ~481 polyline points total — 25x reduction from current.

3. **Topology-first** — build an abstract graph (nuclei + anchor entry/exit points as nodes, MST + extras as edges), then assign geometry. Anchor roads keep regional waypoints; MST edges get straight lines with water avoidance. Produces ~789 points — 15x reduction from current.

**Key finding:** The 25x point reduction in straight-line strategy vs current A* confirms that the vast majority of polyline complexity is smoothing artifacts, not meaningful geometry. The road *topology* (which nuclei connect to which) is the same across all three — only the geometry differs.

**Implications for growth:** If growth algorithms (face subdivision, offset curves, etc.) operate on the road graph topology rather than polyline geometry, the choice of skeleton strategy doesn't affect them. The sparse strategies are better foundations because:
- Graph nodes are meaningful (junctions and endpoints, not smoothing artifacts)
- Face extraction from the graph is cleaner (fewer degenerate near-zero-area faces)
- Geometry can be refined later (add curves, smooth, etc.) without changing topology

**Open question:** The sparse strategies produce roads that cross water (straight lines don't know about rivers). This needs a bridge placement system rather than trying to route around water. See bridge design observation below.

## Bridge Placement Design

**Date:** Step 2, skeleton exploration

**Context:** The sparse skeleton strategies (straight-line and topology-first) produce road connections that cross rivers. Rather than routing roads around water (which the A* approach does, often producing long detours), bridges should be placed explicitly as a separate phase.

### Design principles

1. **Bridges are perpendicular to river flow.** A bridge should cross the river at roughly 90° to the river's tangent direction at the crossing point. Diagonal crossings look wrong and waste span length.

2. **Two landing points per bridge.** Each bank gets a landing point that connects to the nearest point on the road network. The bridge itself is a short, straight segment between the two landing points. Landing connections are short spur roads.

3. **Minimum spacing between bridges.** On the same river branch, bridges should be at least N meters apart (perhaps 200-400m). This prevents bridge clustering. Different branches of the same river, or different rivers entirely, are exempt from this constraint.

4. **Demand-driven placement.** Not every water crossing needs a bridge. Bridge priority should be scored by demand — how much traffic pressure exists to cross at this point.

### Pressure scoring

For each MST edge that crosses water, compute a bridge pressure score:

```
pressure = tierWeight(nucleusA) * tierWeight(nucleusB) / riverWidth
```

Where:
- `tierWeight` maps nucleus tier to importance (tier 1 = 1.0, tier 5 = 0.1)
- `riverWidth` at the crossing point penalizes wide crossings (more expensive bridges)
- Higher-hierarchy MST edges (arterial > collector > local) get implicit priority since they connect higher-tier nuclei

This means: a connection between two important nuclei across a narrow stream scores highest. A connection between two minor nuclei across a wide river scores lowest.

### Placement algorithm

1. **Identify crossing edges.** After the land-based skeleton is built, find all MST/extra edges whose straight-line paths cross water (walk the line, check waterMask).

2. **Score each crossing.** Compute pressure score per crossing edge.

3. **Sort by pressure** (descending — most important bridges first).

4. **For each crossing (in priority order):**
   a. Find the crossing point (where the line enters water)
   b. Get the river tangent at that point (from the river polyline's local direction)
   c. Compute perpendicular direction
   d. Walk perpendicular in both directions to find the two bank positions (first non-water cells)
   e. Check minimum spacing against already-placed bridges on the same river branch
   f. If spacing OK: place bridge segment + landing spur roads
   g. If too close to existing bridge: skip (the nearby bridge serves this crossing)

5. **Connect landing points.** Each landing point gets a short spur road to the nearest existing road cell (or the nucleus it was connecting to). These spurs are added via `addFeature('road', ...)`.

### Phase order

```
setup (tick 0) → skeleton on land (tick 1) → bridge placement (tick 2) → growth (tick 3+)
```

Bridges come after the land skeleton because they need to know which connections cross water. They come before growth because growth roads need to know about bridge locations (bridges are high-value locations for nearby development).

### River branch identification

To enforce minimum spacing *per branch*, we need to know which river branch a crossing is on. Options:
- Use the river polyline tree structure (if available from regional data) — each branch is a separate polyline
- Assign branch IDs during river import based on connected components of the river graph
- Simpler: just use Euclidean distance between crossing points. If two crossings are >N meters apart on the same river, they're probably on different branches or far enough apart to both warrant bridges

The simple distance approach is probably sufficient for v5. Branch identification can be added if spacing looks wrong in practice.

### Integration with land value

Bridges should be high-value locations. After bridge placement, stamp bridge cells into the `landValue` bitmap as value sources. This naturally makes bridge approaches attractive for development — real towns cluster around bridge crossings.

### Open questions

- What's the right minimum spacing? Real towns often have bridges every 500-1000m on major rivers, closer (200-300m) on small streams. Could scale with river width.
- Should bridges be straight or can they curve? For v5, straight is fine. Real bridges curve on long spans but our rivers are narrow enough that straight works.
- How to handle very wide rivers (>100m)? These might need a different approach — perhaps no bridge at all for minor connections, only arterial crossings.
- Landing spur length limit? If the nearest road is very far from the bank, the spur becomes a road in its own right. Cap at ~50m and skip if no road is close enough?
