# V4 City Generation Spec

## Why a Rewrite

The v3 city pipeline builds from an abstract density field outward: paint a
radial density gradient, then try to place roads through the dense areas, then
assign districts by density thresholds, then subdivide with more roads, then
fill with buildings. The result is a narrow band of buildings along inherited
roads, surrounded by empty terrain. It doesn't feel like a city.

The fundamental problem is that density drives everything, and density is just
a smooth mathematical falloff from the center. It doesn't represent actual
demand — where people would live, why they'd live there, what the character of
the place would be. Every downstream step inherits this abstraction.

Real cities aren't density gradients. They're **collections of neighborhoods**
that grew, merged, and became enmeshed in a shared road network. Each
neighborhood has a reason for existing, a character, a center, and edges. The
road network connects them. The city emerges from their accumulation.

V4 rebuilds the city pipeline around this idea.

## Core Principle

**A city is an accumulation of neighborhoods connected by roads.** This
mirrors the regional pipeline, where the landscape is an accumulation of
settlements connected by roads. The same pattern works at both scales because
it models how real places actually form.

At the regional scale:
1. Geography → settlement placement
2. Settlements → road connections
3. Road traffic → settlement growth
4. The network is the settlement pattern

At the city scale:
1. Terrain + inherited roads → neighborhood placement
2. Neighborhoods → arterial connections
3. Internal growth → street networks
4. Boundary merging → the city fabric

## What V3 Gets Right (Keep)

These phases work well and don't need fundamental changes:

- **C1 Extract Context** (= B1a): Cropping regional grids to city bounds.
  Solid. Keep as-is.

- **C2 Refine Terrain** (= B1b): High-frequency noise detail, slope
  recomputation, river channel carving. Works well. Keep as-is.

- **C3 Anchor Routes** (= B2): Corridor-constrained pathfinding of inherited
  regional roads, waterfront structural roads, road-sharing grid. Recently
  improved. Keep as-is.

- **PlanarGraph**: The graph data structure is sound — nodes at intersections,
  edges with polylines and hierarchy. All the operations (splitEdge, faces,
  nearestNode) work. Keep.

- **Plot subdivision** (B9 concept): Dividing blocks into building plots along
  road frontage. The concept is right, though the implementation will need
  adjustment for neighborhood-aware block shapes.

- **Buildings, amenities, land cover** (B10-B12 concepts): Placing buildings
  on plots, amenities by catchment, land cover by zone. These are downstream
  of the road network and will work better when fed a better network.

## What V3 Gets Wrong (Replace)

- **B3 Density Field**: A radial falloff from center + road proximity. Abstract,
  doesn't represent actual demand. Produces a circular blob of "city" centered
  on the seed. **Replace with neighborhood influence fields.**

- **B4 Arterials**: Reactive gap-filling that produces short overlapping spurs.
  Cross-link code is dead. Doesn't consider terrain, tier, or city shape.
  **Replace with neighborhood-to-neighborhood connections.**

- **B5 Districts**: Density thresholds. No spatial coherence, no neighborhood
  identity. A cell with density > 0.7 is "commercial" regardless of whether
  it's waterfront, hilltop, or suburban. **Replace with neighborhood character
  assignment.**

- **B6 Collectors**: Connects arbitrary density peaks to arterial midpoints.
  No relationship to neighborhoods or urban grain. **Replace with
  inter-neighborhood connectors and internal neighborhood streets.**

- **B7 Streets**: Mechanical face-splitting by longest edge. No sense of urban
  grain, no response to terrain or neighborhood character. A medieval core and
  a suburban estate get the same subdivision logic. **Replace with
  character-driven street patterns per neighborhood.**

- **B8 Loop Closure**: Bandaid for a disconnected network. If the upstream
  phases produce a properly connected network, most of this becomes
  unnecessary. **Keep a lightweight version as a safety net.**

## V4 Pipeline

```
C1.  Extract context             (= B1a, unchanged)
C2.  Refine terrain              (= B1b, unchanged)
C3.  Anchor routes               (= B2, unchanged)
C3b. River crossings             (NEW — identify bridge points)
C4.  Place neighborhood nuclei   (NEW)                          ✓ implemented
C5.  Connect neighborhoods       (NEW — direct cross-streets)   ✓ implemented
C6.  Neighborhood influence      (NEW — density + districts)    ✓ implemented
C7.  Neighborhood street grids   (NEW — replaces B6 + B7)
C8.  Boundary stitching          (NEW — replaces B8 loop closure)
C9.  Plots                       (evolved B9)
C10. Buildings                   (evolved B10)
C11. Amenities                   (evolved B11)
C12. Land cover                  (evolved B12)
```

### C3b. River Crossings

Rivers that run through a city split the road network. Without explicit
bridge points, neighborhoods on opposite banks can't connect. This step
identifies where bridges should go, before neighborhoods are placed so that
both neighborhood placement and connection routing can use them.

**Why before C4:** Neighborhood nuclei should be aware of crossing points.
A market neighborhood might form at a bridge. Connections in C5 need
passable crossing cells to route through.

**Algorithm:**

1. **Identify river segments** within city bounds. Use the water mask and
   elevation to find continuous bands of water that span a significant
   portion of the city (not just coastal edges or ponds).

2. **Score candidate crossing points** along each river segment. For each
   water cell, measure:
   - **River width** at that point (narrower = cheaper bridge = preferred)
   - **Proximity to existing roads** — crossings near anchor routes or
     inherited regional roads are preferred (existing demand)
   - **Bank buildability** — both banks should have flat, buildable land
     (a bridge into a cliff is useless)
   - **Spacing from other crossings** — bridges should be spread out, not
     clustered. Minimum spacing scales with city tier (tier 1: ~80 cells,
     tier 2: ~120 cells, tier 3: ~150 cells — larger cities need more
     crossings, closer together)

3. **Place bridge markers** at the best-scoring points. Number of bridges
   scales with river length and city tier:
   - Tier 1: 3-5 bridges per major river segment
   - Tier 2: 2-3 bridges
   - Tier 3: 1-2 bridges

4. **Mark crossing cells** as passable in a bridge grid. The A* pathfinding
   in C5 (and later C7) uses this grid to allow routes across water at
   bridge points only. Bridge cells have normal terrain cost (not the
   water penalty), but only at the marked locations.

**Bridge properties:**

```js
{
  gx, gz,          // grid position (center of crossing)
  x, z,            // world position
  width,           // river width at this point (cells)
  heading,         // perpendicular to river flow (crossing direction)
  importance,      // 0-1, higher near roads and city center
}
```

**Demand-responsive placement:** After C4 places neighborhoods, a second
pass can add bridges where neighborhood pairs on opposite banks lack a
nearby crossing. This handles the case where neighborhoods cluster in an
area the initial scoring missed. The bridge count is capped to prevent
excessive crossings.

**Downstream effects:**
- C4 scores waterfront cells near bridges higher (access to both banks)
- C5 routes connections through bridge cells instead of around the river
- C7 street grids can extend across bridges naturally
- C10 buildings: bridge-adjacent plots could get taller/denser buildings
- Bridge markers could eventually become 3D bridge geometry in rendering

### C4. Place Neighborhood Nuclei

Like regional settlement placement: score every buildable cell for
neighborhood suitability, place nuclei at the best locations with spacing
constraints.

**Scoring factors:**

| Factor | Weight | Rationale |
|--------|--------|-----------|
| Flat terrain | High | Buildings need level ground |
| Near inherited road | High | Frontage, access, trade |
| Near city center | Medium | Central areas develop first |
| Near waterfront | Medium | Desirable, commercial potential |
| Near river/stream | Low-medium | Amenity, water supply |
| Elevated with views | Low | Attractive for residential |
| Away from flood risk | Negative | Floodplains are risky |
| Away from steep slopes | Negative | Can't build easily |

**Nucleus count scales with tier:**

| Tier | Population | Nuclei | Character |
|------|-----------|--------|-----------|
| 1 | 50k | 10-15 | Major city with distinct quarters |
| 2 | 10k | 5-8 | Town with several neighborhoods |
| 3 | 2k | 2-4 | Village with a couple of clusters |

**The first nucleus is always the "old town"** — placed at the city seed (the
regional settlement site). This is the historic core, the densest and most
important neighborhood. Subsequent nuclei are placed outward from it.

**Nucleus properties:**

```js
{
  gx, gz,              // grid position
  x, z,                // world position
  type,                // character type (see below)
  importance,          // 0-1, drives density and street investment
  radius,              // influence radius in world units
  streetPattern,       // 'irregular', 'grid', 'linear', 'organic', 'radial'
}
```

**Neighborhood types** (assigned based on geography at the nucleus):

- **Old town** — at city center. Dense, irregular medieval streets. Commercial
  core. Highest importance. Assigned to the first nucleus.
- **Waterfront** — adjacent to coast/river. Linear along the water with
  perpendicular access streets. Mixed commercial/residential. Docks, quays.
- **Roadside** — along an inherited arterial. Linear strip development
  branching off the main road. Commercial frontage on the arterial.
- **Hilltop** — elevated position with views. Winding streets following
  contours. Residential, possibly with a church/landmark at the summit.
- **Valley** — along a stream or in a dip. Linear, following the valley floor.
  Garden character, lower density.
- **Suburban** — flat open area away from center. Grid or cul-de-sac pattern.
  Lower density, larger plots.
- **Industrial** — near water + flat + away from prevailing wind direction
  from center. Large blocks, wide roads for goods transport.
- **Market** — at a road junction (where two inherited roads cross or meet).
  Commercial character, higher density. Converging streets.

Type assignment uses the same geographic analysis as regional settlement
classification: waterfront proximity, elevation relative to neighbors, slope,
road proximity, junction proximity.

### C5. Connect Neighborhoods

A* pathfinding between neighborhood nuclei to form **direct cross-streets**.
Unlike the regional road generator (which merges onto existing routes), city
neighborhood connections are independent — they cut straight across the
terrain as the crow flies, only detouring for water and steep slopes. This
produces the web of cross-connections that knits neighborhoods together.

**Algorithm:**

1. The old-town nucleus (index 0) connects to **all** other nuclei.
2. Each other nucleus connects to its K=2 nearest neighbors.
3. Union-Find ensures full connectivity — bridge any disconnected components.
4. Connections sorted by importance (highest first), then distance.

**Road hierarchy from connection importance:**

- Old town to any nucleus, or max importance > 0.7: `arterial`
- Max importance > 0.4: `collector`
- Otherwise: `collector`

**Cost function:**

```js
const costFn = terrainCostFunction(elevation, {
  slopePenalty: 3,       // low — prefer directness over flatness
  waterPenalty: 100,     // high — route around water (unless bridge)
  seaLevel,
});
```

No road-sharing discount. Paths are independent and direct. The low slope
penalty means connections stay close to the straight line between nuclei,
bending only for significant terrain obstacles. This creates a natural web
of cross-streets rather than a tree that follows existing roads.

**Bridge-aware routing:** Where a river separates two neighborhoods, the
cost function allows passage through bridge cells identified in C3b
(normal cost instead of water penalty). This means connections naturally
route through the nearest bridge point rather than taking a long detour
around the river.

### C6. Neighborhood Influence Fields

Each nucleus radiates an **influence field** — a density gradient that falls
off with distance from the nucleus, shaped by terrain barriers. This replaces
the abstract radial density field.

**Per-nucleus field:**
- Starts at the nucleus with density = `importance`
- Falls off with distance, faster perpendicular to roads than along them
- Blocked by water, steep slopes, and map edges
- The falloff rate varies by neighborhood type: old town is compact and dense,
  suburban is spread and thin

**Combined density field:**
- For each cell, take the **maximum** of all neighborhood influence values
  (neighborhoods don't stack — the strongest influence wins)
- This naturally produces the right density pattern: high at nuclei, corridors
  of medium density along connecting roads, low between neighborhoods

**District assignment:**
- Each cell belongs to the neighborhood whose influence is strongest at that
  point (Voronoi-like, but weighted by importance and shaped by terrain)
- The district type comes from the neighborhood type:
  - Old town → commercial core
  - Waterfront → mixed/industrial
  - Roadside → commercial strip + residential
  - Hilltop → residential
  - Valley → residential/garden
  - Suburban → suburban residential
  - Industrial → industrial
  - Market → commercial

This means districts have spatial coherence — they're contiguous areas defined
by a neighborhood, not scattered cells that happen to cross a density threshold.

### C7. Neighborhood Street Grids

Each neighborhood generates its own internal street network, driven by its
type and character. This is the biggest change from v3.

**Each neighborhood type has a street generation strategy:**

#### Irregular (old town, market)
- Start with the connecting arterials as a skeleton
- Add streets that branch off at varied angles
- Short blocks, narrow streets, occasional small squares/plazas
- Slight randomness in angles (±15-30°) and block sizes
- Winding streets that follow terrain contours on slopes

#### Grid (suburban, some roadside)
- Align the grid to the dominant road direction through the neighborhood
- Regular block sizes (larger blocks = lower density)
- Some blocks subdivided further in denser areas
- Grid deformed slightly by terrain — streets bend to follow contour lines
  on slopes rather than running straight uphill

#### Linear (waterfront, valley)
- One or two main streets parallel to the waterfront/valley
- Short perpendicular access streets branching off
- Block depth determined by terrain (to the water on one side, to the slope
  on the other)
- Irregular spacing of cross streets, responding to terrain features

#### Organic (hilltop)
- Streets follow contour lines, curving around the hill
- Switchbacks where the slope is steep
- Cul-de-sacs branching off contour-following roads
- Lower density, larger plots, views valued over access

#### Radial (around a landmark or junction)
- Streets radiate from a central point (church, market square, junction)
- 4-8 spokes depending on importance
- Concentric connecting streets between spokes (partial rings)
- Produces the classic "market town center" pattern

**Street generation within a neighborhood:**

1. Start with the arterial edges that pass through or connect to this
   neighborhood (from C5).
2. Determine the neighborhood's **buildable footprint** — cells where the
   influence field > threshold AND terrain is buildable.
3. Apply the type-specific street pattern within this footprint.
4. Streets are added to the shared PlanarGraph.
5. All internal streets are `local` hierarchy.

**Block size targets by density:**

| Density | Target block area | Character |
|---------|------------------|-----------|
| > 0.7 | 400-800 m² | Dense urban core |
| 0.4-0.7 | 800-2000 m² | Terraced residential |
| 0.2-0.4 | 2000-5000 m² | Semi-detached/suburban |
| < 0.2 | 5000+ m² | Rural fringe, large plots |

### C8. Boundary Stitching

Where two neighborhoods meet, their street grids need to connect. This is
the urban equivalent of "boundary merging" — the moment two villages become
one town.

**Algorithm:**

1. Identify **boundary zones**: cells where two neighborhoods' influence
   fields are both above a threshold (the overlap zone).
2. Find dead-end streets in each neighborhood that point toward the other.
3. Connect matching dead ends with short linking streets.
4. Where two grids approach each other with different orientations, add
   T-junctions or angled connections (not forced alignment — real cities have
   visible seams where neighborhoods joined).

The connecting streets use `local` hierarchy. The result is a road network
where neighborhoods are internally coherent but connect at natural seam points
— exactly like real cities where you can see the boundary between a planned
Victorian grid and an older organic core.

**Lightweight loop closure** runs after stitching: any remaining dead ends
within the buildable area (not at the city edge) are connected to the nearest
reachable street. This is a safety net, not a primary generator.

### C9-C12. Downstream Phases (Evolved)

**C9. Plots** — same concept as B9, but now blocks have consistent character
because they belong to neighborhoods. Plot sizes and proportions follow from
the neighborhood type:
- Old town: narrow deep plots (terraced)
- Waterfront: mixed — narrow on residential side, large on industrial/dock side
- Suburban: wide plots, front gardens
- Industrial: large plots, minimal subdivision

**C10. Buildings** — same concept as B10, but building typology follows from
neighborhood character:
- Old town: 3-4 storey terraces, shopfronts at ground floor, continuous
  building line, party walls
- Waterfront: warehouses, harbour offices, maritime terraces
- Hilltop: detached houses, varied heights following slope
- Suburban: semi-detached pairs, small front gardens
- Industrial: single-storey sheds, large footprint, corrugated materials

**C11. Amenities** — same concept. Neighborhood nuclei are natural sites for
amenities: a church at the old town center, a school in the suburban area,
a market square at the market neighborhood. The nucleus positions provide
better placement seeds than density peaks.

**C12. Land cover** — same concept. The neighborhood influence field provides
better context than abstract density: gardens in suburban areas, paved yards
in industrial, small parks at neighborhood boundaries (the leftover green
space where two neighborhoods didn't quite merge).

## Worked Example: Coastal Town (Tier 2)

Consider a tier-2 town at a river mouth on the east coast, with a regional
road coming from the west and another from the south.

**C4 places 6 nuclei:**

1. **Old town** (importance 1.0) — at the seed, where the river meets the
   coast. Irregular streets.
2. **Harbour** (importance 0.7) — along the waterfront south of the river
   mouth. Linear, docks and warehouses.
3. **Roadside strip** (importance 0.6) — along the western road. Linear,
   commercial frontage.
4. **Hill quarter** (importance 0.4) — on elevated ground north of the river.
   Organic contour-following streets.
5. **Suburban** (importance 0.3) — flat area inland, between the two roads.
   Grid pattern.
6. **Valley** (importance 0.3) — along the river upstream. Linear, garden
   character.

**C5 connects them:**

- Old town connects to harbour (arterial along waterfront)
- Old town connects to roadside (arterial along inherited west road)
- Old town connects to hill quarter (collector, up the hill)
- Roadside connects to suburban (collector, branching south)
- Harbour connects to valley (collector along river)
- Suburban connects to hill quarter (local, bridging the gap)

**C6 influence fields** produce density:

- High at old town, medium at harbour and roadside, lower at others
- Corridors of medium density along connecting arterials
- Low density between neighborhoods (future green space)

**C7 street grids:**

- Old town fills with irregular narrow streets and a market square
- Harbour gets a quay road with perpendicular warehouse access streets
- Roadside gets a grid aligned to the main road
- Hill quarter gets curving contour streets with cul-de-sacs
- Suburban gets a regular grid with larger blocks
- Valley gets two parallel streets along the river with cross connections

**C8 stitches them together:**

- Old town's east edge connects to harbour's north edge (a few linking streets)
- Roadside's south streets connect to suburban's west streets
- The seams are visible — different street grains meeting — which feels natural

The result: a town with distinct quarters, each with its own character,
connected by a legible road hierarchy, with the kind of varied urban fabric
that makes a place feel real.

## Population Budget

The neighborhood approach makes population accounting more natural:

- Each neighborhood has a target population based on its area × density
- The total across all neighborhoods should approximate the tier target
- If the total is too high, reduce the number/size of nuclei
- If too low, add nuclei or expand existing ones

The **buildable area** per neighborhood is computed from the influence field:
cells where influence > threshold AND terrain is suitable. This area × the
density profile for that neighborhood type gives the expected population
contribution.

Adjusting nucleus count during C4 to hit the population target:
1. Place nuclei greedily (best score first)
2. After each placement, estimate cumulative population
3. Stop when the target is reached
4. If the terrain is constraining (not enough flat buildable land), place
   fewer nuclei but make them denser

## Street Pattern Algorithms

### Irregular Streets (Old Town)

```
1. Start with arterial skeleton through the neighborhood
2. For each arterial edge, place cross-streets at irregular intervals
   (every 20-40m, randomized)
3. Cross-streets extend 30-80m perpendicular (±20° jitter) to arterial
4. Connect parallel cross-streets with back lanes
5. Add a plaza/square at the nucleus position by leaving a block unsubdivided
6. Trim any streets that extend into unbuildable terrain
```

### Grid Streets (Suburban)

```
1. Determine primary axis from the arterial direction through neighborhood
2. Place primary streets parallel to this axis, spaced by target block width
3. Place secondary streets perpendicular, spaced by target block depth
4. Deform grid slightly: on slopes, bend streets to reduce gradient
   (rotate grid 5-15° toward contour direction)
5. Remove grid cells that fall outside the buildable footprint
6. Connect grid edges to existing arterials/collectors
```

### Linear Streets (Waterfront / Valley)

```
1. Identify the linear feature (coastline, river)
2. Place a primary street parallel to the feature at a suitable setback
3. Place a secondary street further from the feature (if neighborhood is
   wide enough)
4. Connect primary and secondary with short cross streets at intervals
5. Depths vary with terrain: wider blocks where terrain allows, narrower
   where constrained by slope
```

### Organic Streets (Hilltop)

```
1. Generate contour lines on the terrain at the neighborhood
2. Pick the nucleus as the hilltop summit
3. Place a "summit road" as a partial ring around the top
4. Place downhill approach roads from the summit to the connecting arterials
5. Between approach roads, add contour-following lanes
6. Where slope exceeds threshold, add switchbacks
7. Cul-de-sacs branch off where further extension is blocked by terrain
```

## Migration Path

The v4 pipeline reuses the same core infrastructure:

| Component | Status |
|-----------|--------|
| LayerStack, Grid2D, PlanarGraph | Keep unchanged |
| A* pathfinding, terrain cost functions | Keep unchanged |
| UnionFind | Keep unchanged |
| extractCityContext | Keep unchanged |
| refineTerrain | Keep unchanged |
| generateAnchorRoutes | Keep unchanged |
| generateDensityField | **Delete** — replaced by neighborhood influence |
| generateArterials | **Delete** — replaced by neighborhood connections |
| generateDistricts | **Delete** — replaced by neighborhood type assignment |
| generateCollectors | **Delete** — merged into neighborhood street gen |
| generateStreets | **Delete** — merged into neighborhood street gen |
| closeLoops | **Simplify** — lightweight safety net only |
| generatePlots | **Evolve** — add neighborhood-aware plot sizing |
| generateBuildings | **Evolve** — add neighborhood-aware typology |
| generateAmenities | **Evolve** — use nuclei as placement seeds |
| generateLandCover | **Evolve** — use neighborhood influence for context |
| debugTiles, regionPreview3D | **Updated** — neighborhood map, ownership overlay, nucleus markers |

## New Files

| File | Purpose | Status |
|------|---------|--------|
| `src/city/placeNeighborhoods.js` | C4: Score terrain, place nuclei | Done |
| `src/city/connectNeighborhoods.js` | C5: Direct cross-connections between nuclei | Done |
| `src/city/neighborhoodInfluence.js` | C6: Influence fields, district assignment | Done |
| `src/city/riverCrossings.js` | C3b: Identify bridge points along rivers | Planned |
| `src/city/generateNeighborhoodStreets.js` | C7: Per-type street generation | Planned |
| `src/city/stitchBoundaries.js` | C8: Cross-neighborhood connections | Planned |

## Implementation Order

1. ~~**C4 placeNeighborhoods**~~ — **Done.** Scores terrain, places nuclei
   with spacing constraints. Types: oldTown, waterfront, market, roadside,
   hilltop, valley, suburban.

2. ~~**C5 connectNeighborhoods**~~ — **Done.** Direct A* cross-connections
   between nuclei. Low slope penalty for straight-line paths. Old town
   connects to all; others connect to K=2 nearest. Union-Find connectivity.

3. ~~**C6 neighborhoodInfluence**~~ — **Done.** Per-nucleus density falloff
   with type-specific rates. Max-of-all for combined density. Dominant
   nucleus determines district type.

4. **C3b riverCrossings** — Identify bridge points along rivers before
   neighborhoods are placed. Score by width, road proximity, bank
   buildability. Make bridge cells passable for C5 routing.

5. **C7 generateNeighborhoodStreets** — the biggest piece. Start with one
   pattern (grid) and get it working end-to-end, then add irregular, linear,
   organic. Each pattern is a function that adds edges to the PlanarGraph
   within a neighborhood's footprint.

6. **C8 stitchBoundaries** — depends on C7. Connect the neighborhood grids.

7. **Update C9-C12** — evolve plots, buildings, amenities, land cover to
   use neighborhood context. This can be incremental — the existing code
   will produce *something* on the new road network, even if not optimized
   for neighborhood awareness.

8. **Update debug rendering** — neighborhood debug views already added
   (neighborhood map with ownership overlay, nucleus markers with type
   labels). Debug viewer rewritten to auto-discover pipeline output files.

Steps 1-3 are complete and producing good results. Step 4 (bridges) is
needed before C5 can work properly on river cities. Step 5 is the bulk of
the remaining work.

## Risks

- **Over-engineering neighborhoods**: The system should be simple. A
  neighborhood is a point with a type, importance, and radius. Don't make
  it a complex object with dozens of properties.

- **Street pattern complexity**: Each pattern (irregular, grid, linear,
  organic, radial) is its own algorithm. Start with one or two and iterate.
  A simple grid that works is better than five patterns that don't.

- **Performance**: More neighborhoods = more A* calls + more street
  subdivision iterations. For tier 1 (15 nuclei, each generating ~50
  street edges), total is ~750 edges. The v3 pipeline already handles
  this scale.

- **Regression in downstream phases**: Plots and buildings currently expect
  the v3 density/district fields. They'll need adaptation to use
  neighborhood influence instead. This can be done incrementally — the
  influence field has the same data shape (density grid + district grid),
  just better values.
