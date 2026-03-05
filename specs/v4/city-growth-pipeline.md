# V5 City Generation: Iterative Growth Pipeline

## Why Rewrite Again

V3 was a linear pipeline that imposed density from above and hoped the geometry would follow. V4 introduced neighborhoods as the unit of urban fabric, which was a real improvement — but the pipeline stayed linear. Each stage still runs exactly once, in order, with no feedback.

The result is a system that feels like a city assembled from parts rather than one that grew. Roads are placed, then plots fill the gaps, then buildings fill the plots. But real cities don't work that way. A road creates frontage, frontage attracts buildings, buildings create demand for more roads. The process is iterative.

We've also accumulated mechanical debt:
- The occupancy grid was bolted on after the fact to prevent overlapping roads — it works, but it's duct tape over a deeper issue (stages can't see each other's work)
- `closeLoops` creates redundant connections because it runs after the network is "done" rather than during growth
- Institutional plots are placed before frontage plots, on a different code path, with different geometry
- The density field is computed once from neighborhood nuclei, then never updated — it doesn't reflect what actually got built

### What V4 Got Right (Keep)

- **Neighborhoods as growth units.** A city is a collection of neighborhoods, each with character.
- **PlanarGraph.** The road graph abstraction is solid.
- **Frontage-first plots.** Generating plots from road edges (not graph faces) was the right call.
- **Occupancy grid.** A shared spatial grid that all stages can read/write is the right coordination primitive.
- **Terrain as constraint.** Water, slopes, and elevation correctly limit where things can go.
- **Regional roads as seed.** Inheriting roads from the regional scale gives the city its initial skeleton.

### What V4 Gets Wrong (Replace)

- **Linear pipeline.** Each stage runs once. No iteration, no feedback.
- **Density as input.** Density is computed from neighborhood nuclei, then used to decide what to build. It should be the other way around — density emerges from what was built.
- **Road stages fragmented.** Anchor routes, closeLoops, and (disabled) back-lanes/cross-streets are separate stages with different abstractions. They should be one system: "add a road."
- **Population budget imposed top-down.** The building generator skips plots based on a density field. Population should emerge from filled plots.
- **No growth order.** Everything happens at once. In a real city, the center is denser and older, the periphery is newer and sparser. The growth order creates this gradient naturally.

## Core Idea: The Growth Loop

Instead of a linear pipeline, the city grows through repeated iterations of a simple loop. Growth follows roads, not circles. Roads come first (from the regional layer), plots fill their frontage, and when the land behind the plots fills up, pressure builds for new parallel roads.

### How Real Towns Grow

A medieval high street attracts plots along its frontage. Each plot is narrow at the front (valuable road frontage) and deep at the back (cheap garden/yard). Eventually the back yards fill with sheds, workshops, extensions. A back lane appears to service the rear — suddenly there's new frontage. Plots fill that lane too. Cross passages connect the layers. The block thickens from one road into a dense mesh.

This is the growth unit: not a circle radiating outward, but a road thickening into a block.

```
Tick 1:    ═══════════════════  arterial road (bare)

Tick 10:   ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓  plots fill frontage (gaps reserved)
           ═══════════════════
           ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓

Tick 30:   ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓
           ───────────────────  back lane (depth pressure)
           ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓
           ═══════════════════
           ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓
           ───────────────────
           ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓

Tick 50:   ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓
           ─────┼─────┼─────  cross streets through reserved gaps
           ▓▓▓▓▓│▓▓▓▓▓│▓▓▓▓
           ═════╪═════╪═════
           ▓▓▓▓▓│▓▓▓▓▓│▓▓▓▓
           ─────┼─────┼─────
           ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓
```

### The Loop

```
while population < target:
    1. Fill existing road frontage with plots
    2. Check for depth pressure → add parallel roads where needed
    3. Check for block length pressure → add cross streets where needed
    4. Fill plots with buildings, update population
```

This is simpler than the previous "score candidates and pick the best" model. There are no candidates to score. Growth happens everywhere there's unfilled frontage, and new roads appear when geometric pressure demands them.

### Road-Following Growth

Growth doesn't radiate from nucleus centers. It follows roads:

1. **Arterials exist from tick 0** — inherited from the regional layer. They connect nuclei immediately.
2. **Frontage fills first.** Each tick, unfilled frontage along existing roads gets plots. The arterials fill first because they're there from the start.
3. **Depth pressure creates parallel roads.** When both sides of a road are fully plotted, the land behind the plots has no road access. If there's demand (the nucleus hasn't hit its population target) and the terrain allows it, a back lane appears at a fixed offset behind the plot rear boundaries.
4. **Block length pressure creates cross streets.** When a continuous run of plots exceeds the neighborhood's cross-street spacing threshold (50–85m depending on type), a cross street is inserted connecting the arterial to the back lane.
5. **The pattern repeats.** The back lane now has frontage. Plots fill it. If demand continues, another parallel road appears behind those plots. The block thickens.

### Depth Pressure

The key mechanism for creating new roads. For each plotted road edge:

```
depth_pressure(edge) =
    plots_filled_on_both_sides(edge)
    AND buildable_land_behind_plots(edge)  — check occupancy grid
    AND nucleus_has_remaining_demand(edge)
    AND depth_since_last_parallel < max_depth  — neighborhood config
```

When depth pressure is true, a parallel road is placed at `plot_depth + road_width/2` behind the existing plots. The road follows the same polyline as the parent edge, offset perpendicular. This is exactly the back-lane logic from `generateStreetsAndPlots` — but triggered by growth pressure rather than placed all at once.

The `max_depth` value comes from the neighborhood type. Old town: shallow depth (30m), many parallel lanes. Suburban: deep depth (45m), fewer parallels. Industrial: very deep (50m), minimal parallels.

### Reserved Gaps for Cross Streets

When filling frontage, we don't fill it contiguously. Every `cross_street_spacing` metres (50–85m depending on neighborhood type), a gap is left — one plot-width of unfilled frontage. This gap is reserved for a future cross street.

The gap is stamped onto the occupancy grid as a special value (or simply left empty). In early ticks when only the arterial frontage exists, these are just unfilled slots in the plot row. They look natural — not every plot along a road gets built immediately.

When a back lane appears behind the plots (from depth pressure), the reserved gap becomes the site for a cross street connecting the arterial to the back lane. The cross street is placed through the gap, perpendicular to both roads.

```
At frontage fill time:
    along = 0
    while along < edge_length:
        if along - last_gap > cross_street_spacing:
            skip one plot width (reserve for cross street)
            last_gap = along
        else:
            place plot

Later, when back lane exists:
    for each reserved gap with a back lane behind it:
        place cross street through the gap
```

This means cross streets don't need to demolish existing plots — the space was reserved from the start. The pattern mirrors real medieval towns where property boundaries at regular intervals were left as public passages (wynds, ginnels, snickets) that later became proper streets.

### Block Length Pressure

Cross streets get built when a back lane exists behind the reserved gap:

```
block_pressure(gap) =
    back_lane_exists_behind(gap)
    AND gap_is_still_empty  — check occupancy grid
```

Cross streets are short perpendicular connections from the arterial to the back lane. They break long blocks into walkable chunks and complete the block structure.

### Growth Epochs

The growth order creates temporal layers naturally:

- **Early ticks:** Only arterial frontage exists. Plots are narrow, deep, high coverage. This creates the dense core along main roads — the "high street" character.
- **Middle ticks:** Back lanes appear behind arterial plots. Frontage fills at moderate density. Cross streets create a grid-like block pattern.
- **Late ticks:** Growth pushes outward. New roads extend from existing dead ends toward peripheral nuclei. Frontage is wider, depth is greater, coverage is lower. Suburban character.

No density field needed — the growth order IS the density gradient.

## Filling Irregular Blocks

The road network creates blocks — closed polygons bounded by roads. In a perfect grid these would be rectangles, but real road networks produce irregular shapes: trapezoids, triangles, curved wedges, five-sided polygons where two roads meet at an angle. The challenge is filling these shapes with plots that look natural.

### The Block as Container

Once an arterial, a back lane, and two cross streets exist, they enclose a block. The block polygon can be extracted from the road graph (face extraction via PlanarGraph). This polygon is the container that plots must fill.

Key insight: **the plots absorb the irregularity, not the buildings.** A building is always a simple rectangle (or L-shape, or T-shape). The plot boundary — the property line — is what conforms to the block shape. The gap between the building and the irregular plot edge becomes garden, yard, or parking.

### Filling Strategy

For each block polygon:

1. **Identify frontage edges.** Each edge of the block polygon lies along a road. Plots face the road they front onto.

2. **Walk the frontage.** Place plots at the neighborhood's frontage width, perpendicular to the road edge. Each plot extends inward toward the block center. The plot depth is limited by the block's internal geometry — it can't extend past the midline or into another plot's territory.

3. **Handle irregular depth.** Where the block is wide, plots reach their full configured depth. Where the block narrows (acute corner, tapering wedge), plots are shallower. The building footprint shrinks proportionally, but the frontage width stays constant. The result: a normal-width house with a short garden.

4. **Corner plots.** Where two roads meet at a block corner, the corner plot is a triangle or irregular quadrilateral. The building sits at the road-facing edge (the normal setback from both roads). The rest of the plot is garden. Corner plots are larger and more valuable — in real towns they often get pubs, shops, or larger houses.

5. **Interior remainder.** After all frontage plots are placed, there may be a leftover polygon in the block center (especially in large or irregular blocks). This becomes:
   - **Garden/yard** for adjacent plots (merged into their rear)
   - **A courtyard** in dense neighborhoods
   - **A small park or green** in larger blocks
   - Left empty (future development site)

### Plot Shapes in Practice

```
Regular block (4 roads, roughly rectangular):

    ┌──┬──┬──┬──┬──┬──┐
    │  │  │  │  │  │  │  ← frontage plots (regular rectangles)
    │  │  │  │  │  │  │
    ├──┴──┴──┴──┴──┴──┤
    │   rear gardens   │  ← interior remainder
    ├──┬──┬──┬──┬──┬──┤
    │  │  │  │  │  │  │  ← frontage plots facing opposite road
    │  │  │  │  │  │  │
    └──┴──┴──┴──┴──┴──┘

Irregular block (roads at angles):

    ┌──┬──┬──┬──┬──┐
    │  │  │  │  │ /    ← plots get shallower toward acute corner
    │  │  │  │ / /
    │  │  │  │/ /      ← corner plot: triangle, building at front,
    ├──┴──┴──┘ /          garden fills the rest
    │  garden  /
    ├──┬──┬──┐/
    │  │  │  │         ← plots on angled road: parallelograms,
    │  │  │  │            but buildings are still rectangles
    └──┴──┴──┘
```

### Building Within the Plot

The building footprint is always a rectangle (axis-aligned to the road it faces). It sits at the front of the plot with the configured setback. The building's width is `frontage_width - 2 * side_gap`. Its depth is `min(building_depth, plot_depth - setback - rear_garden)`.

On a regular plot, this leaves a rear garden. On a shallow or irregular plot, the rear garden shrinks — but the building stays rectangular. On a very shallow plot (acute corner), the building might not fit at all — the plot becomes garden-only.

The plot boundary (the polygon registered in the occupancy grid) can be any shape. The building within it is always regular. The visual effect: a town that looks organic at street level (varied plot shapes, gardens filling odd corners) but where every house is a normal building.

### Why This Matters for the Growth Loop

Frontage-first plot generation (the current V4 approach) works well for the initial layer of plots along arterials. But once back lanes and cross streets create enclosed blocks, we need to switch from "walk along a road placing plots" to "fill a block polygon with plots from all its frontage edges."

This is a two-phase approach within the growth loop:
- **Open frontage** (no block enclosed yet): place plots by walking the road edge, extending perpendicular to a fixed depth. This is the current algorithm.
- **Enclosed blocks** (roads on all sides): extract the block polygon, then fill from all frontage edges inward. Plots meet in the middle. Interior remainder becomes garden/courtyard.

The transition happens naturally. Early ticks only have arterials — all frontage is open. As back lanes and cross streets appear, blocks close and the fill algorithm switches.

## Polycentric Growth: Satellites That Merge

The v4 model treats the city as a single organism growing outward from a seed. Real cities don't work that way. A town starts as a cluster of hamlets, a market, a church, a ford. These nuclei grow independently until their edges meet, roads connect them, and the gaps fill in. The resulting city has multiple centers with distinct character — the market quarter, the waterfront, the hill district — because each started as a separate settlement.

### Seeding the Constellation

At setup time, we don't just place neighborhood nuclei — we seed a constellation of proto-settlements across the city extent. The regional pipeline already produces exactly the data we need:

1. **The primary settlement** (tier 1-2 from the regional layer). This is the city seed — it gets the first roads and the densest growth.
2. **Satellite hamlets, farms, and market towns** (tier 3-5 from the regional layer) that fall within the city bounds. The A6b/A6c/A6d pipeline already placed these at geographically sensible locations with roads connecting them. These are real places that exist independently.
3. **Generated nuclei** to fill geographic niches that the regional pipeline missed at its coarser resolution — a waterfront cluster, a hilltop hamlet, a ford crossing. These are the V4 neighborhoods, but conceived as independent settlements rather than zones of a single city.

Source 2 is the big win. The regional layer already did the hard work of finding good farm sites, placing hamlets near fertile land, promoting settlements at road junctions. We inherit all of that. The city pipeline just grows them.

Each nucleus has:
- `center` — world position
- `type` — oldTown, waterfront, market, hilltop, etc.
- `tier` — initial size (hamlet, village, town quarter)
- `population` — starts at a small number based on tier
- `targetPopulation` — how big this nucleus wants to grow (proportional to site quality)
- `connected` — whether it has a road to any other nucleus

### All Nuclei Grow Simultaneously

Nuclei are connected by roads from tick 0 (regional arterials). Every tick, every nucleus with remaining demand grows — but growth means "fill frontage along my roads, and add parallel roads when depth pressure triggers." Larger nuclei have more road frontage, so they naturally grow faster.

```
for each tick:
    for each nucleus with remaining demand:
        // 1. Fill existing frontage
        for each road edge owned by this nucleus:
            place plots on unfilled frontage sections

        // 2. Depth pressure → parallel roads
        for each fully-plotted edge:
            if buildable land behind plots:
                add back lane, stamp onto occupancy

        // 3. Block length pressure → cross streets
        for each long unbroken frontage run:
            if back lane exists behind:
                add cross street connecting them

    // 4. Fill new plots with buildings, update population
```

The result:

- **Tick 10:** Arterials between nuclei have plots along their frontage. Each nucleus has a single street of buildings.
- **Tick 30:** Back lanes appear behind the earliest-plotted arterial frontage. The primary nucleus has two or three layers of streets. Satellites still have one.
- **Tick 60:** The primary nucleus has thickened into dense blocks with cross streets. Its growth front approaches nearby satellites. Satellite nuclei are developing their first back lanes.
- **Tick 100:** Inner satellites have been absorbed — their arterial frontage is now continuous with the primary. Plots from different nuclei share the same blocks. Outer satellites are still distinct villages.
- **Tick 200:** Most of the constellation is continuous urban fabric. Peripheral nuclei remain as separate villages connected by plotted arterials with open land between them.

### Enmeshment

Two nuclei "enmesh" when their built areas grow close enough that the gap between them fills naturally. This happens through the normal growth loop:

1. Nucleus A grows eastward. Nucleus B grows westward. Their plot frontages approach each other.
2. A road connecting A and B is built (either by the connection phase, or because the scoring function identifies the gap as high-value frontage).
3. Plots fill the road frontage between them.
4. What were two separate hamlets is now one continuous neighborhood.

The occupancy grid makes this seamless — there's no special "merge" operation. Plots from different nuclei simply fill adjacent space on the same grid.

### Connection Timing

Nuclei are connected by roads from the start — the regional arterials already link them. What changes over time is not whether roads exist but how thickly developed the roads are:

- **Tick 0:** Arterials between nuclei exist but are bare — no plots, no buildings. Just roads through open land.
- **Early ticks:** Plots develop near the nuclei, working outward along the arterials. The road between two nuclei fills from both ends inward.
- **Mid ticks:** The frontage between two nearby nuclei is fully plotted. What was open countryside is now a continuous street of buildings. The nuclei have enmeshed.
- **Late ticks:** Peripheral nuclei may never fully enmesh — they remain as separate villages connected by a plotted arterial with gaps of open land.

Dead-end roads (nuclei at the end of a single arterial) naturally extend during the growth loop. When a nucleus's existing frontage is full and it has remaining demand, the loop extends its road onward (same `extendRoad()` function), creating new frontage to develop.

### No Scoring Function Needed

The road-following model doesn't need a scoring function to pick growth sites. Growth is deterministic:

1. **Frontage fills outward from each nucleus.** Each tick, each nucleus extends its plotted frontage by one increment along its roads, working outward from the center. The growth front is simply "the next unfilled section of road nearest to the nucleus center."
2. **Depth pressure triggers parallel roads.** No scoring — it's a geometric check (plots full on both sides + buildable land behind).
3. **Cross streets fill reserved gaps.** No scoring — they appear when the back lane behind the gap exists.
4. **Road extensions happen when frontage is exhausted.** When a nucleus has filled all its existing frontage and has remaining demand, it extends its dead-end roads onward.

The growth order — center fills first, periphery fills last — falls out of the "work outward from nucleus center" rule. No explicit distance-from-center scoring needed.

### Per-Nucleus Population Targets

The city's total population target (from the settlement tier) is distributed across nuclei:

- The **primary settlement** gets ~50-60% of the target.
- **Satellite hamlets/villages** get allocations based on their site quality and tier.
- The sum of all nucleus targets equals the city-wide target.

As growth proceeds, nuclei that fill up stop growing. Nuclei with remaining capacity continue. If a nucleus can't reach its target (blocked by water, terrain), its remaining allocation redistributes to neighbors.

## Proposed Architecture

### Data Model

The city state is a single `CityState` object that the growth loop mutates:

```
CityState:
  params          — dimensions, cellSize, seaLevel, etc.
  terrain         — elevation, slope, waterMask (read-only after setup)
  waterPolygons   — smooth coastline (read-only after setup)
  graph           — PlanarGraph of roads
  occupancy       — 3m grid: empty / road / plot / junction / water
  neighborhoods   — array of { center, type, radius }
  plots           — array of plot objects
  buildings       — array of building objects
  population      — current count
  accessibility   — grid: distance to nearest road (updated each iteration)
```

The occupancy grid is the coordination layer. Every mutation (add road, add plot) stamps onto it. Every query (can I build here? what's nearby?) reads from it.

### Pipeline: Setup, then Loop

```
Phase 0: Setup (runs once)
  C0a. Extract city context from region
  C0b. Refine terrain
  C0c. Extract water polygons
  C0d. Import anchor routes from regional roads
  C0e. Seed nuclei (primary + regional satellites + generated)
  C0f. Initialize occupancy grid (stamp water, roads, junctions)
  C0g. Place institutional plots (parks, churches, markets)
  C0h. Distribute population targets across nuclei

Phase 1: Growth loop (runs N ticks)
  C1a. For each nucleus: score its growth frontier, pick best site
  C1b. Extend road to growth site (if needed)
  C1c. Generate frontage plots along road
  C1d. Fill plots with buildings
  C1e. Check for inter-nucleus connections (enmeshment roads)
  C1f. Update population and accessibility

Phase 2: Finishing (runs once)
  C2a. Land cover (gardens, paving, woodland)
  C2b. Amenity placement (uses final building layout)
  C2c. Validation
```

### Phase 0: Setup

This is largely what we have now, but cleaner:

**C0a–C0c** are unchanged (extractCityContext, refineTerrain, extractWaterPolygons).

**C0d: Import anchor routes.** The current `generateAnchorRoutes` Phase 1–4 (shared-grid pathfinding, junction detection, segment extraction) works well. Keep it. But Phase 5 (waterfront road, seed connection) moves into the growth loop — these are just "extend a road" operations that should use the same abstraction as everything else.

**C0e: Seed nuclei.** Filter the regional `settlements` array to find all settlements within the city bounds — the primary (tier 1-2), plus farms (tier 5), hamlets (tier 4), villages and market towns (tier 3) that the A6b/A6c/A6d pipeline already placed. Assign each a neighborhood type based on its geography (waterfront, hilltop, valley, etc. — reuse the current `placeNeighborhoods` classifier). Optionally generate a few more nuclei to fill geographic niches missed at regional resolution. Drop `computeNeighborhoodInfluence` — density emerges from what gets built.

**C0h: Distribute population.** The city-wide population target (from settlement tier) is split across nuclei proportional to site quality and tier. The primary gets the lion's share. Satellites get smaller allocations. The sum equals the target.

**C0f: Initialize occupancy.** Create the 3m grid. Stamp water cells, anchor route roads, junctions. This is what we already do in the pipeline, but formalized as a first-class step.

**C0g: Institutional plots.** Large plots (parks, churches, markets, schools) are placed early because they need the best sites and they constrain everything else. Current `generateInstitutionalPlots` works. Stamp them onto occupancy.

### Phase 1: The Growth Loop

This is the new part. Each iteration:

#### C1a: Fill Frontage (Per-Nucleus)

Each nucleus tracks its growth front — the distance along each of its road edges up to which plots have been placed. Each tick, each nucleus with remaining demand advances its growth front by one increment (one plot-width of frontage, ~8-18m depending on neighborhood type).

Growth fronts advance outward from the nucleus center. Edges closer to the center fill first. For each edge, the front advances away from the nearest nucleus node.

Reserved gaps are left at cross-street spacing intervals (every 50-85m). These are not plotted — they remain empty on the occupancy grid, waiting for a future cross street.

Plots are placed, stamped on the occupancy grid, and filled with buildings immediately.

#### C1b: Depth Pressure — Add Parallel Roads

For each road edge where both sides are fully plotted:
- Check if there's buildable land behind the plots (occupancy grid scan)
- If yes and the nucleus has remaining demand: place a back lane at `plot_depth + road_width/2` offset, following the parent edge's polyline
- Stamp the new road onto occupancy

The back lane is a lower-hierarchy road (local or backLane width) parallel to its parent. It immediately becomes available for frontage filling in the next tick.

#### C1c: Block Pressure — Add Cross Streets

For each reserved gap along a road edge:
- Check if a back lane exists behind the gap
- If yes: place a short perpendicular road connecting the arterial to the back lane through the gap
- Stamp onto occupancy

Cross streets are very short (one plot depth). They complete the block structure.

#### C1d: Extend Dead Ends

When a nucleus has filled all its existing frontage and still has demand:
- Find its road dead ends
- Extend each dead end onward using `extendRoad()` (A* pathfinding with occupancy-wrapped cost, snap-to-existing-node, BFS reachability check)
- New road creates new frontage for the next tick

This is the only place where A* pathfinding runs. Parallel roads and cross streets are placed geometrically (offset from parent edge), not pathfound. This keeps the loop fast.

```js
function extendRoad(state, fromNode, toWorldPos, hierarchy) {
  const cost = wrapCostWithOccupancy(terrainCost, state.occupancy, cs);
  const path = findPath(from, to, cost);
  const endNode = snapOrCreateNode(graph, toWorldPos, threshold);
  if (bfsReachable(graph, fromNode, endNode, 6)) return null;
  const edgeId = graph.addEdge(fromNode, endNode, { ... });
  stampEdge(graph, edgeId, state.occupancy);
  return edgeId;
}
```

#### C1e: Update State

- Increment population from new buildings
- Update per-nucleus population tallies
- Check termination: total population >= city target

### Phase 2: Finishing

After the growth loop, apply finishing passes that need the complete city:

**C2a: Land cover.** Fill empty cells with appropriate ground cover (gardens near plots, woodland on slopes, paving near roads).

**C2b: Amenities.** Place parks and schools using catchment rules. These work better with the final building layout than with a predicted density field.

**C2c: Validation.** Run validators against the completed city.

## Key Abstractions

### 1. The Occupancy Grid Is the Source of Truth

Every spatial query goes through the occupancy grid. "Can I build here?" checks the grid. "Where are the roads?" checks the grid. No separate road-scanning, no rebuilding availability arrays from the graph.

The grid values:
- `0` — empty (buildable)
- `1` — road corridor
- `2` — plot (building or garden)
- `3` — junction clearing
- `4` — water / unbuildable
- `5` — institutional (park, church, etc.)

### 2. One Road-Extension Function

All road creation goes through a single `extendRoad()` function that:
- Pathfinds with occupancy awareness
- Snaps to existing nodes
- Checks graph reachability (no redundant connections)
- Stamps onto occupancy
- Returns the new edge (or null if skipped)

No more separate code paths for anchor connectors, waterfront roads, loop closure, back-lanes, and cross-streets.

### 3. Neighborhoods Own Character, Not Density

A neighborhood defines:
- `type` — oldTown, waterfront, market, roadside, hilltop, valley, suburban, industrial
- `center` — world position
- `radius` — influence extent
- Plot config — frontage width, depth, setback, coverage

Density is not stored or precomputed. It emerges from the growth order: neighborhoods near the center get filled first (by the scoring function), so they end up denser. Neighborhoods at the periphery get filled last, so they end up sparser.

### 4. Growth Order Replaces Density Fields

The scoring function in C1a determines which areas fill first. This implicitly creates a density gradient:
- High-scoring sites (central, accessible, flat) fill early → dense
- Low-scoring sites (peripheral, hilly, far from roads) fill late → sparse
- Some sites never fill (too steep, too wet, too far) → empty

This replaces `computeNeighborhoodInfluence`, the density grid, and the district grid. The growth order IS the urban plan.

## What Changes from V4

| V4 | V5 |
|---|---|
| Linear pipeline (C1–C12) | Setup → growth loop → finishing |
| Density computed from nuclei | Density emerges from growth order |
| Roads added in 3 separate stages | One `extendRoad()` function |
| Plots generated all at once | Plots generated incrementally per growth site |
| Buildings skip by density field | Buildings placed as growth proceeds |
| Occupancy grid bolted on | Occupancy grid is core data structure |
| `closeLoops` as post-hoc fix | Dead ends resolved by growth loop naturally |
| Population budget imposed | Population counted from buildings |

## What Stays from V4

- `PlanarGraph` for road network
- `LayerStack` for city state (or evolve to `CityState`)
- Terrain pipeline (extract, refine, water polygons)
- Anchor route import (Phase 1–4 grid extraction)
- Neighborhood nuclei placement
- Institutional plot placement
- Frontage-first plot generation algorithm
- Building footprint generation
- Occupancy grid stamp/query helpers
- A* pathfinding with terrain cost

## Performance Considerations

The growth loop runs many iterations (potentially hundreds). Each iteration must be fast:

- **Occupancy grid lookups are O(1).** No spatial index needed.
- **Growth candidate scoring** can use the accessibility grid (precomputed flood-fill) rather than per-candidate BFS.
- **Plot generation** operates on one edge at a time, not all edges.
- **Building placement** operates on new plots only.
- **Accessibility update** is incremental — only re-flood from new road cells.

Target: 1000 iterations should complete in <500ms. The current pipeline runs in ~200ms, so the budget is reasonable if each iteration is simple.

## Migration Path

1. **Extract `extendRoad()`.** Unify the road-creation code from `generateAnchorRoutes` Phase 5, `closeLoops`, and the disabled back-lanes into one function in `roadOccupancy.js`.

2. **Build the growth loop.** New file `growCity.js` that implements C1a–C1e. Initially, the scoring function can be simple (distance from center + road proximity).

3. **Remove density precomputation.** Delete `computeNeighborhoodInfluence`. Neighborhoods still exist; the density/district grids don't.

4. **Move waterfront road + seed connection into the growth loop.** These become the first 1–2 iterations (connecting the seed to the anchor network).

5. **Move `closeLoops` into the growth loop.** Dead-end resolution becomes "the growth loop picked a dead end as its next growth site and extended a road from it."

6. **Remove `generateStreetsAndPlots` as a bulk operation.** Plot generation is now per-growth-site inside the loop.

7. **Tune the scoring function.** This is where the design lives. Different scoring weights produce different city shapes (compact vs. sprawling, linear vs. radial).

8. **Rebuild the debug pipeline.** `pipelineDebug.js` should snapshot every N iterations of the growth loop, not every pipeline stage.

## Open Questions

- **Frontage increment per tick.** One plot-width (~8-18m) per edge per nucleus per tick. Larger nuclei have more edges, so they grow faster. This might need tuning — too small = too many ticks, too large = visible banding.
- **Gap sizing for cross streets.** One plot-width gap seems right (matches the cross street width). But should the gap be a full road width + clearance? Need to prototype to see what looks natural.
- **Back lane placement geometry.** Offsetting a polyline by `plot_depth` is straightforward for straight roads but tricky for curves. On the inside of a curve the offset is shorter, on the outside it's longer. Need to handle plot depth scaling or accept some irregularity (which might look more organic).
- **How to handle the district grid.** Downstream systems (land cover, building materials) need district info. Derive from nucleus ownership + growth tick. Early-tick plots near nucleus center = commercial/mixed. Late-tick plots at periphery = residential. The tick number IS the district signal.
- **Debug output for the growth loop.** Snapshotting at tick 10, 30, 60, 100, 200 would beautifully illustrate the growth process — arterial frontage filling, back lanes appearing, blocks thickening, nuclei enmeshing.
- **Ring roads.** These don't emerge naturally from the depth-pressure model (which creates parallel roads, not perpendicular ones). For tier-1 cities, ring roads could be a post-loop pass connecting the outer ends of parallel roads. Or they could be a special "lateral connection" pressure: when two adjacent back lanes from different arterials get close, a connecting road appears.
- **Regional satellite data.** Already built (A6a→A6b→A7a→A6c→A7b→A6d). City setup imports all regional settlements within bounds as nuclei.
- **Nucleus independence after enmeshment.** Keep nuclei as separate objects — preserves distinct character per quarter. An old-town nucleus keeps its narrow frontage and high coverage even after it's surrounded by suburban nuclei. The "neighborhood" concept = nucleus.
- **Edge ownership.** Which nucleus "owns" a road edge? The nucleus whose center is closest to the edge midpoint. Matters for determining plot config (frontage width, depth, coverage). Edges between two nuclei may have different plot configs on each side — the left side uses nucleus A's config, the right side uses nucleus B's. This creates natural character transitions at neighborhood boundaries.

## Testing and Incremental Correctness

### The Lesson from V4

V4 was built as a linear pipeline and the output was terrible for a long time. Mistakes in early stages (overlapping anchor routes, bad density fields) cascaded into chaos downstream. We patched symptoms for weeks before finding root causes. The growth loop makes this worse — errors compound across hundreds of ticks instead of 12 stages.

The fix: **test invariants aggressively after each stage, and fail fast.** Don't discover at tick 200 that roads have been overlapping since tick 3.

### What We Have

The validator framework exists and is solid (3-tier: validity/structure/quality, 15 validators). But:
- Validator results are computed at the end of the pipeline and stored as data. Nothing asserts on them.
- The test suite is almost entirely existence checks ("has plots", "has buildings"). It doesn't test correctness.
- The overlap detection we built today (sampling polyline proximity) isn't in the validator suite.
- There's no per-stage validation. If anchor routes produce overlapping roads, we don't find out until the schematic renders look wrong.

### What We Need

#### 1. Invariants That Run Every Tick

Inside the growth loop, check invariants after every mutation. These are cheap checks on the occupancy grid — not the expensive polygon-overlap validators.

```js
function assertInvariants(state) {
  // No road cell overlaps a plot cell
  // (the occupancy grid makes this O(1) — just check the cell value before stamping)

  // No plot extends into water
  // (check during plot placement, reject the plot)

  // No two road edges physically overlap
  // (check during extendRoad — the occupancy grid already prevents this)

  // Every new road node snaps to existing if close enough
  // (enforced by snapOrCreateNode)
}
```

These aren't post-hoc validators — they're **preconditions enforced at mutation time**. The occupancy grid is the enforcement mechanism. If you try to stamp a road cell on a plot cell, that's a bug, not a quality issue.

#### 2. Per-Stage Gate Tests

The test suite should run the pipeline up to each stage and assert invariants:

```js
describe('after anchor routes', () => {
  it('no two edges have polylines within 5m for >50% of their length', ...);
  it('all road nodes are above sea level', ...);
  it('road graph is connected', ...);
});

describe('after growth loop tick 10', () => {
  it('all plots clear of road corridors (occupancy grid consistent)', ...);
  it('no plot centroid is in water', ...);
  it('all plots have road frontage within 2x plot depth', ...);
});

describe('after growth loop complete', () => {
  it('population is within 20% of target', ...);
  it('no overlapping building footprints', ...);
  it('dead-end fraction < 30%', ...);
});
```

The `--stop-after` flag in the debug pipeline already supports this — we can stop at any stage and validate.

#### 3. Multi-Seed Smoke Tests

Run the full pipeline across 10+ seeds and assert all tier-1 validators pass. This catches seed-specific regressions:

```js
for (const seed of [7, 42, 99, 123, 256, 500, 777, 1000, 2024, 9999]) {
  it(`seed ${seed}: all tier-1 validators pass`, () => {
    const city = makeCity(seed);
    const results = runValidators(city, getCityValidators());
    expect(results.valid).toBe(true);
  });
}
```

This is cheap (~200ms per city) and catches the class of bugs where "it works for seed 42 but overlaps roads for seed 777."

#### 4. New Validators to Add

The current validator suite is missing critical checks:

| Validator | Tier | What it checks |
|---|---|---|
| `V_noOverlappingRoads` | 1 | No two edge polylines run within road-width distance for >50% of their length |
| `V_plotsNotOnRoads` | 1 | No plot polygon overlaps a road corridor (occupancy grid consistency) |
| `V_plotsNotInWater` | 1 | No plot centroid is below sea level or on water mask |
| `V_minBlockWidth` | 2 | Spaces between parallel roads are wide enough for at least one plot row |
| `V_waterBoundary` | 1 | No road node or plot vertex is on a water cell |
| `S_plotCoverage` | 2 | Fraction of buildable land within city core that has plots |
| `S_roadNetworkEfficiency` | 2 | Ratio of road length to area served (penalizes redundant roads) |

#### 5. Success Stories to Preserve

Some things from V4 work well and must not regress:

- **Shared-grid anchor route import** (pathfind → stamp → extract junctions → trace segments). Prevents overlapping regional roads by construction. Test: no two anchor route edges overlap.
- **Smooth water polygons** (marching squares → Douglas-Peucker → Chaikin). Test: water polygon edges are smooth (no 90-degree grid artifacts), all polygon vertices are at or below sea level.
- **Occupancy grid coordination**. Test: after any mutation, the occupancy grid is consistent with the road graph and plot list.
- **BFS reachability check** in road extension. Test: no new edge connects two nodes already reachable within 6 hops.
- **Node snapping**. Test: no two graph nodes are within snap threshold of each other.

### Bitmap-in-the-Loop Testing

The debug pipeline already renders every stage as a raw RGBA pixel buffer (1px/cell for tiles, 2px/m for schematics). These buffers are plain `Uint8Array`s — no image parsing needed. We can assert directly on pixel data in tests.

This closes the feedback loop: render the output, analyse the bitmap, fail the test if something looks wrong. The same images used for visual debugging become machine-readable test fixtures.

#### What Bitmap Tests Can Catch

**Overlapping roads.** Road pixels are a known colour (`[180, 175, 168]` for asphalt). On the schematic renderer, each road is drawn at its actual width. If two roads overlap, the same pixel gets drawn twice — but since they're the same colour, that's invisible. Instead, render each road edge in a unique colour (hue from edge ID) and check for pixels where two colours blended. Or simpler: render a road-ID buffer (one int per pixel, value = edge ID) and check for pixels claimed by more than one edge.

**Plots conflicting with roads.** Render plots and roads into the same buffer with distinct colour channels (e.g., road = red channel, plot = green channel). Any pixel with both red AND green set is a conflict.

**Water boundary violations.** Render water in blue, roads/plots in red. Any pixel with both is a violation. The water polygon renderer and road renderer already exist — just composite them and check.

**Blocks too narrow for plots.** Render roads on the schematic. Flood-fill the gaps between roads. Any filled region narrower than `min_plot_depth * 2` (both sides) in any direction is too narrow for a plot row.

**Visual regression detection.** For a fixed seed, render the schematic and compare pixel-by-pixel against a saved reference image. Any diff beyond a threshold flags a regression. This catches subtle changes (a road shifted by one cell, a plot disappeared) that unit tests miss.

#### How It Works in Practice

```js
describe('schematic bitmap checks (seed 42)', () => {
  let buf;
  before(() => {
    const city = makeCity(42);
    buf = renderSchematic({
      cx: centerX, cz: centerZ,
      cityLayers: city, roadGraph: city.getData('roadGraph'),
      plots: city.getData('plots'), buildings: city.getData('buildings'),
    });
  });

  it('no road pixels overlap plot pixels', () => {
    // Render road mask and plot mask separately, check no intersection
    const roadMask = renderRoadMask(city);
    const plotMask = renderPlotMask(city);
    for (let i = 0; i < roadMask.length; i++) {
      expect(roadMask[i] && plotMask[i]).toBe(false);
    }
  });

  it('no road pixels in water', () => {
    const roadMask = renderRoadMask(city);
    const waterMask = renderWaterMask(city);
    for (let i = 0; i < roadMask.length; i++) {
      expect(roadMask[i] && waterMask[i]).toBe(false);
    }
  });
});
```

The mask renderers are thin wrappers around the existing `debugTiles.js` primitives — same `createBuffer`/`setPixel`/`drawThickLine`, just writing to single-channel boolean masks instead of RGBA.

#### Occupancy Grid as the Faster Alternative

For most invariant checks, the occupancy grid IS a bitmap test — it's a 3m-resolution rasterisation of the city state. Instead of rendering a schematic and analysing pixels, we can check the occupancy grid directly:

```js
// No cell is both road (1) and plot (2)
for (let i = 0; i < occupancy.data.length; i++) {
  // This is enforced by construction — stamping a road on a plot cell is a bug
  // But we can verify it holds after each tick
}

// No road or plot cell is on water
for (let i = 0; i < occupancy.data.length; i++) {
  const isRoadOrPlot = occupancy.data[i] === 1 || occupancy.data[i] === 2;
  const isWater = waterGrid[i]; // pre-rendered water mask at same resolution
  expect(isRoadOrPlot && isWater).toBe(false);
}
```

The occupancy grid gives us per-tick invariant checking at 3m resolution for free. The bitmap tests are for higher-level visual properties (block widths, frontage coverage, visual regressions) that the occupancy grid can't express.

#### The Two-Level Testing Strategy

| Level | What | When | Speed |
|---|---|---|---|
| **Occupancy invariants** | No road/plot conflict, no water violation, occupancy consistent with graph | Every tick of growth loop | <1ms per check |
| **Bitmap analysis** | Overlapping road geometry, block widths, visual regression | Per-stage or end-of-pipeline | ~50ms per render |
| **Validator suite** | Structural and quality metrics (dead-end fraction, frontage coverage, etc.) | End-of-pipeline | ~20ms |
| **Multi-seed smoke** | All tier-1 validators pass across 10+ seeds | CI / pre-commit | ~2s total |

### Agent-Readable Bitmaps

The bitmaps rendered by `debugTiles.js` serve a dual purpose: they're both programmatically testable (pixel analysis in vitest) and visually inspectable by AI agents. When debugging a generation issue or evaluating output quality, **agents should render and look at the debug bitmaps** — the raw RGBA buffers can be read as images, giving immediate visual feedback about what the pipeline produced.

This means:
- When implementing a new pipeline stage, render its debug tile and inspect it visually before moving on.
- When a test fails, render the failing seed's bitmaps and look at them to understand what went wrong.
- When evaluating whether output "looks right," the bitmap is the ground truth — not just the validator scores.

The existing `renderDebugGrid()` composites all stages into a single 4x4 grid image. Individual tiles are also returned separately. Both are plain `Uint8Array` RGBA buffers that can be written to PNG for visual inspection or analysed programmatically in tests.

### Implementation Approach

Build testing incrementally alongside the pipeline, not after:

1. **Before writing the growth loop:** Add multi-seed smoke tests that assert tier-1 validators on the current pipeline. Establish the baseline. Add the missing tier-1 validators (`V_noOverlappingRoads`, `V_plotsNotOnRoads`, `V_plotsNotInWater`). *(Done — see `test/city/multiSeedSmoke.test.js`)*
2. **When building each growth loop step:** Add per-tick occupancy invariant checks. These are trivial — a `for` loop over the occupancy array.
3. **When a bug is found visually:** Render the bitmap, look at it, write a bitmap test or validator that catches the issue, add it to the suite, then fix the bug. Never fix a visual bug without a corresponding test.
4. **Save reference bitmaps for seed 42.** After each milestone, snapshot the schematic renders. Future runs diff against these. Any unexpected change triggers investigation.
5. **CI runs the full suite.** Every commit must pass all seeds. If a change breaks seed 777, we know before merging.
