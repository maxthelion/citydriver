# City Plan Generation Pipeline

## Inputs from Regional Map

The city generator receives these from the regional layer:

- **Terrain heightmap** (local area, high resolution refinement of regional data)
- **Water features** — river path(s), coastline, floodplain extents
- **Regional road entry points** — directions and importance of roads arriving from other settlements
- **City importance tier** — drives target population/area, which scales everything else
- **Style parameters** — era, cultural style, grid vs organic bias

---

## Phase 1: Terrain Preparation & Water Infrastructure

**Goal:** Establish the physical constraints everything else must respect.

### Operations

1. **Refine the regional heightmap** to local resolution. Add high-frequency noise to the regional elevation data so broad landforms are preserved but local texture appears (small ridges, dips, natural terraces).

2. **Define water edges.** Buffer rivers and coastlines to create hard constraints:
   - River corridor: channel width + floodplain margin (parameterized). Nothing permanent builds in the floodplain.
   - Coastline: define the shore edge and a narrow coastal buffer.

3. **Classify terrain zones** based on slope and elevation relative to water:
   - **Flat low-lying** (floodplain, coastal flat) → future industrial, docks, warehouses
   - **Flat elevated** → prime buildable land, high density potential
   - **Gentle slopes** → good residential
   - **Steep slopes** → low density or parkland, roads must switchback or contour
   - **Hilltops** → landmark sites (civic, religious)

4. **Identify key terrain features** that will anchor the city:
   - Lowest viable river crossing point(s)
   - Natural harbor indentations (if coastal)
   - Prominent hilltops
   - Confluences (if multiple waterways)

### Output

Terrain grid with slope classification, water exclusion zones, and a set of anchor points (crossing, harbor, hilltops) that seed Phase 2.

---

## Phase 2: Primary Network — Anchor Routes & Arterials

**Goal:** Lay down the bones of the city — the major routes that everything else hangs off.

### Operations

1. **Place the city seed.** The historic center goes at the highest-value anchor point — typically the river crossing or harbor. This becomes the origin node of the road network.

2. **Connect regional entry roads to the seed.** For each regional road arriving at the map edge, pathfind toward the city seed using terrain-weighted A*:
   - Penalize steep gradients heavily
   - Penalize crossing water (require bridge placement)
   - Slight preference for following contour lines and valley floors
   - These become the **primary arterials** — the oldest, most important roads

3. **Add waterfront routes.** Run a road parallel to the river and/or coastline, set back from the water buffer. This follows the shore/bank organically. Connect it to the arterials where they approach the water.

4. **Connect arterials to each other.** Where two arterials are within reasonable distance but not connected, add cross-links. Prefer routes along ridgelines or across gentle terrain. These form ring roads or cross-town routes.

5. **Assign road hierarchy and width:**
   - Primary arterials (regional connections): 20–30m right of way
   - Secondary arterials (cross-links, waterfront road): 15–20m
   - Width can narrow in the historic core to reflect pre-modern constraints

### Design notes

- The organic vs grid parameter influences this phase. For organic cities, the arterials curve freely following terrain. For grid-biased cities, arterials are straightened where terrain permits, establishing the grid axes early.
- Bridge locations are critical — record them as high-importance nodes. Streets will radiate from bridges.

### Output

A graph of arterial road segments with assigned widths, plus bridge locations and the city seed point.

---

## Phase 3: Density Field Generation

**Goal:** Before laying out local streets, establish a population density heatmap that will drive everything from street density to building height.

### Operations

1. **Compute a density field** across the city area by summing weighted attractors:
   - **Distance from city seed** — strongest attractor, inverse falloff. The center is densest.
   - **Proximity to arterial roads** — density is higher near major routes, with a falloff perpendicular to the road.
   - **Proximity to waterfront** — adds density for desirable waterfront (not industrial docks), subtracts for industrial waterfront.
   - **Terrain suitability** — flat elevated land gets a density bonus. Steep slopes and floodplain get penalties.
   - **Bridge nodes** — local density spikes at bridge approaches (these become commercial nodes).

2. **Identify density peaks** as district centers. Besides the main city center, any secondary peaks (a bridge on the far bank, a hilltop, a crossroads of arterials) become neighborhood centers that will get their own commercial clusters.

3. **Normalize the density field** to the city's target population. The integral of density over area should approximate the target population, which sets the absolute scale (building heights, plot sizes).

### Output

A continuous density field over the city area, plus a list of district center points extracted from density peaks.

---

## Phase 4: District Division & Collector Roads

**Goal:** Subdivide the areas between arterials into districts, each with a collector road network.

### Operations

1. **Define district boundaries.** The arterials and water features naturally carve the city into large irregular polygons. Each of these is a district. Very large districts can be further split — use Voronoi subdivision seeded from district center points identified in Phase 3.

2. **Assign district character** based on the density field and terrain:
   - High density + central → **commercial core** (dense street grid, small blocks)
   - High density + waterfront (downstream/industrial side) → **industrial/docks**
   - Medium-high density → **mixed use** (shops at ground level, residential above)
   - Medium density → **dense residential** (terraces, apartments)
   - Low-medium density → **suburban residential**
   - Steep slopes / hilltops → **parkland or low-density prestige residential**

3. **Generate collector roads within each district.** This is where the organic-vs-grid parameter matters most:
   - **Organic mode:** Use a recursive growth algorithm. Start from where an arterial enters the district, extend a road, branch at intervals, and let branches curve to follow terrain contours. Connect dead ends to nearby roads when they get close enough (creating loops, not just trees).
   - **Grid mode:** Project a regular grid aligned to the dominant arterial direction. Clip to district boundaries and water features. Allow the grid to deform near terrain obstacles.
   - **Hybrid:** Grid in flat areas, organic in hilly areas within the same district.

4. **Collector road width:** 10–15m. Narrower than arterials but still substantial enough for through-traffic within the district.

> **Implementation lesson — collector density control:** Collector spacing must be wide: **120–250m** (lerped by density). Without caps, grid collectors generate N×N roads per district which compounds with local streets in Phase 5. Cap grid lines to **3 per direction** (max ~6 collectors per grid district). For organic mode, cap at **1–4 roads per district** (scaled by district size / 120). Roads compound multiplicatively across phases, so restraint here is critical.

5. **Place district squares/plazas.** At each district center point, widen an intersection or create a small open space. In the commercial core, this becomes the main market square or civic plaza. In residential districts, smaller neighborhood squares.

### Output

Complete road network down to collector level. District polygons with assigned character types. Plaza/square locations.

---

## Phase 5: Local Streets & Block Subdivision

**Goal:** Fill in the fine-grained street network and create individual city blocks.

### Operations

1. **Subdivide each block** (polygon bounded by collector roads and arterials) with local access streets:
   - Street spacing is driven by the density field: denser areas get tighter street spacing (80–100m block depth), lower density areas get wider spacing (150–250m).
   - Streets are narrow: 8–12m right of way.
   - Orientation follows the collectors — perpendicular to the main frontage road where possible.

2. **Handle block shapes.** Real blocks are irregular. When a block polygon is very elongated, run a street down its length. When it's wide and deep, run parallel streets across it. Triangular blocks (common at arterial junctions) get special treatment — they often become small parks or landmark building sites.

3. **Create back lanes/alleys** only in very dense commercial/mixed-use areas (density > 0.85). Run a narrow service lane (3–5m) through the center of blocks, parallel to the main street. This gives rear access to plots and is characteristic of many historic city patterns (mews in London, alleys in American cities).

4. **Identify corner plots and special sites.** Corner plots where two roads meet are larger and more prominent. Plots facing a plaza or square are premium. Flag these — they'll get different building treatment in Phase 7.

> **Implementation lesson — local street density control:** Local streets are emitted perpendicular to parent edges (collectors and arterials). Because each district may have multiple parent edges, this compounds quickly. Key controls:
> - Use only the **3 longest parent edges** per district (not all)
> - Cap at **12 local streets per district** maximum
> - Emit streets on **alternating sides** of the parent edge (not both directions at every point)
> - Start accumulation offset at `spacing * 0.5` to avoid clustering at edge endpoints
> - Original spec said 30–50m spacing for dense areas — this was far too tight when combined with multiple parent edges. 80m minimum works in practice.

### Output

Complete street network. City blocks as closed polygons. Each block tagged with its district character type and local density value.

---

## Phase 6: Plot Subdivision

**Goal:** Divide each block into individual building plots.

### Operations

1. **Determine plot dimensions from district character and style:**

   | District type | Frontage width | Plot depth | Style example |
   |---|---|---|---|
   | Commercial core | 6–10m | 20–40m | Deep narrow shop plots |
   | Dense residential (UK style) | 5–7m | 20–30m | Terraced houses |
   | Dense residential (European) | 8–12m | 15–25m | Perimeter block apartments |
   | Suburban residential | 12–20m | 20–30m | Detached/semi-detached |
   | Industrial | 20–50m | 30–80m | Warehouses, factories |

2. **Subdivide block frontage** into plots. Walk along each street-facing edge of the block and stamp out plots at the appropriate width, with slight random variation (±10–15%) to avoid mechanical regularity. Plots are rectangular, extending from the street frontage inward.

3. **Handle block interiors.** In dense areas, plots from opposite sides of a block might meet in the middle (back-to-back). In less dense areas, the block interior becomes garden/yard space or a shared courtyard.

4. **Merge plots for special uses.** Some plots need to be larger: corner buildings, civic buildings (church, school, pub). Flag plots at key locations for merging in Phase 7.

### Output

Array of plot polygons, each tagged with: street frontage direction, plot dimensions, district type, density value, and any special flags (corner, plaza-facing, landmark site).

---

## Phase 7: Building Footprint & Massing

**Goal:** Place building footprints on plots and determine heights.

### Operations

1. **Determine building footprint from plot and district type:**
   - **Terraced/row housing:** Footprint fills plot width, extends back 8–12m from frontage. Zero setback from street. Party walls shared with neighbors.
   - **Perimeter block:** Footprint wraps the block edge with a continuous facade. Interior courtyard left open.
   - **Detached residential:** Footprint centered in plot with setbacks on all sides.
   - **Commercial:** Footprint fills most of plot. In historic cores, narrow deep buildings. In modern areas, larger consolidated footprints.
   - **Industrial:** Large rectangular footprints, high plot coverage.

2. **Set building height from density field:**
   - Convert density value to floor count. Low density: 1–2 floors. Medium: 2–4. High: 4–6. Very high (commercial core): 6+.
   - Enforce consistency along a street — adjacent buildings within a terrace should match height. Allow variation between streets.

3. **Place landmark buildings** on flagged special sites:
   - **Hilltop plots** → church, cathedral, or civic building (taller than surroundings)
   - **Plaza-facing plots** → town hall, market hall, or prominent commercial building
   - **Bridge approach** → gate building, inn, or commercial landmark
   - **Corner plots** → pub, bank, or slightly grander residential (bay windows, extra story)

4. **Apply setback and alignment rules:**
   - Historic areas: zero front setback, continuous building line along street
   - Suburban areas: uniform front setback (3–6m), creating front gardens
   - Commercial streets: ground floor may project slightly (shopfront, awning zone)

### Output

Building footprint polygons with: height (floor count), building type, setback, and party wall flags.

---

## Phase 8: Amenity & Service Placement

**Goal:** Place schools, healthcare, parks, and other amenities based on population catchments.

### Operations

1. **Calculate population per area** from the density field.

2. **Place amenities using catchment rules:**

   | Amenity | Catchment population | Placement preference |
   |---|---|---|
   | Neighborhood park | Every 400m of residential | Interior of blocks, or unused irregular plots |
   | Primary school | 5,000–10,000 people | On collector roads, near residential centers |
   | Secondary school | 15,000–30,000 | On arterials, larger site |
   | Local clinic | 5,000–10,000 | On collector or arterial roads |
   | Hospital | 50,000–250,000 | On arterial, near city center |
   | Fire station | 10,000–30,000 | On arterial for quick access |
   | Place of worship | 3,000–8,000 | Prominent site: hilltop, square, junction |

3. **Placement algorithm:** For each amenity type, tile the residential area with catchment circles. Find the best available plot within each catchment zone — prefer plots on appropriate road types, consolidate adjacent plots if a larger site is needed.

4. **Place commercial clusters** at density peaks and high-betweenness road segments. Run a simple betweenness centrality calculation on the road graph — segments in the top 15–20% become commercial frontages (ground floor retail, signage, shopfronts).

### Output

Amenity locations assigned to specific plots, with remaining plots confirmed as their default type (residential, commercial, industrial).

---

## Feedback Loops

Several passes require going back and adjusting earlier results:

### Loop A: Road ↔ Density (between Phases 2–3 and 4)

After generating the density field, check if any district centers lack adequate arterial access. If a density peak is far from any arterial, add or upgrade a collector road to connect it. Conversely, if an arterial passes through an area that turned out very low density, it might be downgraded to a collector.

### Loop B: Plot ↔ Building Fit (between Phases 6 and 7)

When placing buildings, some plots may be awkward shapes that don't fit any building type well. Feed these back to plot subdivision — merge with a neighbor, split differently, or flag as open space (garden, parking, small park).

### Loop C: Amenity ↔ Road Access (Phase 8 back to Phase 5)

If a school or hospital placement requires better access than the local street provides, upgrade the access street to collector width, or add a short connecting road to the nearest collector.

### Loop D: Street Centrality ↔ Zoning (Phase 8 back to Phase 6)

After computing betweenness centrality, some streets that were zoned residential may turn out to be high-traffic through-routes. Rezone their frontage plots as commercial/mixed-use. This is how real cities work — corner shops and high streets emerge from traffic patterns, not top-down planning.

---

## Parameter Summary

These are the dials that control the character of the generated city:

| Parameter | Effect |
|---|---|
| `city_tier` | Target population/area, scales everything |
| `organic_vs_grid` | 0.0 = fully organic, 1.0 = rigid grid |
| `era` | Affects plot sizes, building types, road widths |
| `style` | Cultural style (British, German, American, etc.) — drives plot proportions, building grammar |
| `hilliness` | From terrain — affects road curvature, density distribution |
| `has_river` / `has_coast` | From regional map — determines anchor points and industrial placement |
| `density_falloff` | How quickly density drops from center — compact vs sprawling |
| `landmark_frequency` | How many special buildings per district |
| `max_building_height` | Caps floor count — keeps the city to a consistent era feel |

---

## Implementation Notes

- **Data structure:** The road network should be a proper graph (nodes at intersections, edges as road segments with width and hierarchy attributes). Blocks are the faces of this planar graph. Plots are sub-polygons of blocks.
- **Coordinate system:** Work in meters from an origin at the city seed. This makes catchment distances and plot sizes straightforward.
- **Randomness:** Use seeded random throughout so cities are reproducible. Add small random perturbations (±10–15%) to most dimensions to break visual regularity.
- **Performance:** Phases 1–3 operate on grids/fields. Phase 4–5 is graph-based. Phase 6–7 is per-block geometry. Most expensive step is likely the street subdivision (Phase 5) and centrality calculation (Phase 8). Both are tractable for city-scale networks (thousands of edges).

---

## Implementation Lessons

Hard-won lessons from implementation that should inform any future rewrite or tuning:

### Road density compounds multiplicatively

Each phase adds roads that the next phase uses as parent edges for more roads. Phase 2 arterials → Phase 4 collectors per district → Phase 5 local streets per collector. Without caps, a city with 5 arterials and 8 districts can generate hundreds of roads. **Every phase needs per-district caps**, not just spacing controls.

### Spacing values from urban planning don't translate directly

Real-world street spacing (30-50m for dense areas) assumes a single grid of streets. In this pipeline, roads are emitted perpendicular to every parent edge, not laid in a single coordinated grid. The effective spacing needs to be **2-3× wider** than real-world values because:
- Multiple parent edges through a district each emit their own set of cross-streets
- No deduplication or overlap detection between streets from different parent edges
- A* pathfinding can curve roads, making them longer and covering more area than straight segments

### Practical tuned values (gridSize=256, city scale)

| Parameter | Spec value | Tuned value | Reason |
|---|---|---|---|
| Collector grid spacing | 60–120m | 120–250m | Too many grid lines at 60m; compounds with local streets |
| Grid lines per direction | Unlimited | Max 3 | Prevents N² collector explosion in large districts |
| Organic collectors per district | 2–6 | 1–4 | Scaled by `distSize / 120` not `/ 80` |
| Local street spacing | 30–150m | 80–250m | 30m was far too tight with multiple parent edges |
| Parent edges per district | All | Max 3 (longest) | Prevents same area getting cross-streets from every road |
| Local streets per district | Unlimited | Max 12 | Hard cap prevents runaway in large/dense districts |
| Alley threshold | density > 0.7 | density > 0.85, commercial/mixed only | Alleys added too many edges for little visual benefit |

### Progress display is essential

City generation takes 500-2500ms depending on complexity. Without progress display, the UI appears frozen. Use `requestAnimationFrame` yield between phases and show phase name + elapsed time per completed phase. This also helps identify which phase is slow during tuning.