# Open World Generator — Architecture Summary

## What This System Is

An open world generator that produces coherent, explorable landscapes and cities by working from geological first principles upward through human settlement logic. Every visible feature — the shape of a coastline, the curve of a road, the height of a building, the presence of a forest — has a cause rooted in the layers beneath it. Nothing is placed arbitrarily.

The system generates worlds that feel real not because they copy real places, but because they follow the same cause-and-effect chains that shaped real places. A city exists at a river crossing because that's where the terrain made crossing viable. The city's main street curves because it follows a ridge above the floodplain. The buildings are brick because the city sits on clay lowlands. The forest starts where the farmland ends because the slope got too steep to plough.

---

## Core Design Principles

### 1. Causation Flows Downward Through Layers

The system is a stack of generation layers, and information flows strictly downward. Each layer reads from the layers above it and contributes constraints and context to the layers below.

```
Geology (rock types, structure)
  ↓ determines
Terrain (elevation, slopes, valleys, ridges)
  ↓ determines
Hydrology (rivers, drainage basins, water table)
  ↓ determines
Coastline (cliffs, bays, beaches, estuaries)
  ↓ determines
Land Cover (forest, farmland, marsh, moorland)
  ↓ determines
Settlement Placement (scored site selection)
  ↓ determines
Regional Infrastructure (roads, bridges, resource sites)
  ↓ determines
City Layout (roads, blocks, plots, buildings)
  ↓ determines
Building Detail (footprints, heights, materials, facades)
```

No layer should reference a layer below it during generation. Geology doesn't know about cities. Terrain doesn't know about roads. This one-way flow is what keeps the world coherent — every feature is a consequence of something more fundamental, never a coincidence.

### 2. The Same Data at Different Resolutions

The system operates at two scales — regional (roughly 100km², coarse resolution) and local (a few km², fine resolution) — but they are views of the same underlying world, not independent generations.

When zooming from region to city, every piece of data is inherited and refined, not regenerated:
- The regional heightmap becomes the local heightmap with added high-frequency detail
- The regional river path becomes the local river with its exact banks, meanders, and floodplain
- The regional road entering from the north becomes the city's northern arterial, arriving from the same direction at the same point
- The regional geology determines the local building material
- The regional land cover determines what the city was built on top of, and what surrounds it

This means no city is an island. Every city knows what's beyond its boundary and why it exists.

### 3. Human Logic Follows Natural Logic

The natural layers (geology → terrain → water → land cover) are generated first and follow physical rules. The human layers (settlements → roads → buildings) are generated second and follow economic and practical logic responding to the natural landscape.

The key human logic principles are:

**Settlements form where advantages concentrate.** The site scoring function finds places where multiple geographic advantages overlap — a river crossing on flat ground near good farmland with a sheltered harbor. The more advantages, the larger the settlement. This is central place theory made procedural.

**Roads follow the path of least resistance between places that need connecting.** They seek valleys, avoid steep ground, cross rivers at narrow points, and follow ridgelines where the ground is firm. Road importance follows from the importance of what they connect.

**Land use is driven by access and suitability.** The most accessible, most central land becomes commercial. The best farmland gets farmed. The steepest slopes stay wild. Land near water and transport serves industry. Everything else becomes residential, with density decreasing outward from centers of activity.

**Buildings fill the space that roads and plots define.** The road network creates blocks. Blocks subdivide into plots. Plots constrain building footprints. Building form follows from plot shape, density requirements, and cultural style. This means building variety emerges from plot variety, which emerges from road network geometry, which emerges from terrain — the chain of causation runs all the way back to geology.

### 4. Style Is Parameterized, Not Hard-Coded

The system generates structurally correct cities regardless of style. Style is a set of parameters applied to the structural skeleton:

- **Plot proportions** — narrow deep plots produce London terraces, wider plots produce German townhouses, wide shallow plots produce American suburbs
- **Building-plot relationship** — zero setback with party walls produces terraces, setback with gaps produces detached houses, perimeter fill produces European courtyard blocks
- **Materials** — driven partly by geology (stone vs brick vs timber) and partly by cultural style parameter
- **Roof forms, window rhythms, facade articulation** — pure style parameters applied during building detail generation
- **Road character** — organic curves vs planned grid, influenced by both terrain and style parameter

The structural checks (every building has road access, roads connect through, density matches targets) are style-independent. The quality metrics (terrace alignment, frontage continuity) are style-aware.

### 5. Validation Is Continuous, Not Post-Hoc

The system doesn't generate a city and then check if it's good. Quality assurance is woven into the generation process at three levels:

**Prevention (during generation):** Hard constraints are enforced in real time. The road generator never places a road in water. The building placer never creates an overlap. Invalid states are prevented, not detected.

**Scoring (after generation):** Structural and quality metrics are computed over the finished output. These produce a diagnostic score card showing what proportion of the city satisfies each rule, with spatial heatmaps highlighting problem areas.

**Repair (targeted fixes):** Low-scoring areas trigger specific repair operations — extending a road to eliminate a dead end, merging awkward plots, adding a missing amenity. Repairs are surgical, not regeneration.

This three-level approach means generation can be fast and somewhat rough, with scoring identifying problems and repair fixing the worst of them, rather than the generator needing to be perfect on every pass.

---

## Generation Pipeline — Complete Sequence

### Phase A: Regional Generation

**A1. Geology**
Generate the rock type map — sedimentary bands with igneous intrusions. Each rock type carries erosion resistance, permeability, cliff tendency, soil fertility, and building material properties.

**A2. Terrain**
Generate the heightmap as a function of geology. Hard rock produces highlands, soft rock produces lowlands. Geological boundaries create escarpments. The terrain shape is explained by what's underneath it.

**A3. Hydrology**
Derive the river network from flow accumulation on the heightmap. Rivers emerge in valleys, gather tributaries, widen downstream, and terminate at the coast or in lakes. River character (gorge vs broad valley vs meandering floodplain) follows from the geology the river crosses.

**A4. Coastline**
Refine the land-sea boundary through differential erosion. Hard rock resists and forms headlands. Soft rock erodes into bays. River mouths become smooth estuaries. The coastline gains fractal detail at multiple scales.

**A5. Land Cover**
Assign vegetation and ground cover based on elevation, slope, geology, drainage, and proximity to human activity. Farmland on fertile lowlands near settlements. Forest on moderate slopes with adequate soil. Moorland on high acidic ground. Marsh in waterlogged lowlands.

**A6. Settlement Placement**
Score every location for settlement potential using a weighted function of: river access, crossing viability, harbor quality, flat buildable land, fertile hinterland, defensive terrain, route convergence. Place cities, towns, and villages at the highest-scoring sites with minimum spacing constraints.

**A7. Regional Infrastructure**
Route roads between settlements using terrain-weighted pathfinding. Roads follow valleys, cross rivers at narrow points, and pass through highland passes. Assign road hierarchy based on the settlements connected. Identify resource locations (quarries, mines, fisheries) from geology and land cover.

### Phase B: City Generation (per settlement)

**B1. Local Terrain Refinement**
Inherit and refine the regional heightmap, river geometry, coastline, geology, and land cover for the local area around the chosen settlement. Add high-frequency terrain detail.

**B2. Anchor Routes**
Place the first roads — waterfront routes, roads following natural features, connections to regional road entry points. These are the ancient routes that predate planned development.

**B3. Density Field**
Compute a population density heatmap driven by distance from the city seed, proximity to arterials, terrain suitability, and waterfront desirability. Identify district centers at density peaks.

**B4. Arterial Network**
Connect regional entry roads to the city seed and to each other. These become the main streets — widest roads, most traffic, commercial character. Bridge locations become critical nodes.

**B5. District Division**
Arterials and natural features carve the city into districts. Assign district character (commercial core, dense residential, suburban, industrial, parkland) based on the density field, terrain, and proximity to water and transport.

**B6. Collector Roads**
Subdivide districts with medium-width roads. Organic curves in historic/hilly areas, grid patterns in planned/flat areas, hybrid where appropriate. Place district squares and plazas at district centers.

**B7. Local Streets and Blocks**
Fill blocks with narrow access streets. Street spacing driven by density — tighter in dense areas, wider in suburbs. Create back lanes in dense areas. The result is a complete road network defining closed block polygons.

**B8. Loop Closure Pass**
Scan for dead ends (degree-1 nodes). For each, find the nearest reachable road and connect. Urban streets form loops and through-routes, not stubs.

**B9. Plot Subdivision**
Divide blocks into building plots. Plot dimensions follow from district type and cultural style — narrow frontage for terraces, wide for detached, large for industrial. Slight random variation prevents mechanical regularity.

**B10. Building Placement**
Place building footprints on plots. Footprint shape follows from plot shape and building type. Height follows from density field. Setback follows from era and style. Party walls, continuous building lines, and landmark buildings applied as appropriate.

**B11. Amenity Placement**
Place schools, clinics, parks, places of worship, and other amenities using population catchment rules. Consolidate plots where needed for larger sites. Place commercial frontages on high-betweenness streets identified by network analysis.

**B12. Land Cover and Green Space**
Assign urban green space — parks on remnant natural features or designated open land, gardens proportional to density, street trees on wider roads, woodland on undevelopable slopes, riparian buffers along rivers. Cemeteries, allotments, and wasteland fill appropriate sites.

### Phase C: City Feedback Loops

Generation is not purely linear. Several passes require going back and adjusting earlier results:

**Loop A: Road ↔ Density.** After generating the density field, check if any district centers lack adequate arterial access. Add or upgrade roads to reach them. Conversely, downgrade arterials that pass through areas that turned out low density.

**Loop B: Plot ↔ Building Fit.** When placing buildings, some plots are awkward shapes that don't fit any building type. Merge with a neighbor, split differently, or flag as open space.

**Loop C: Amenity ↔ Road Access.** If a school or hospital placement requires better access than the local street provides, upgrade the access street or add a connecting road.

**Loop D: Street Centrality ↔ Zoning.** After computing betweenness centrality on the road network, some streets zoned residential turn out to be high-traffic through-routes. Rezone their frontage as commercial or mixed-use. This is how real high streets and corner shops emerge — from traffic patterns, not top-down planning.

---

## Settlement Character Typology

The geology and hydrology at each settlement site determines its character archetype, which shapes the entire city generation:

- **Estuary site:** Major port city. Wide flat area for docks. River provides inland trade route. City develops on the better-drained bank first. Industrial waterfront downstream, prestige waterfront upstream.
- **Harbor site:** Coastal town. Development wraps around the harbor. Fishing and maritime economy. Growth constrained by flat land availability behind the harbor.
- **River crossing site:** Inland market town. Roads converge at the bridge. Commercial center near the crossing, spreading along approach roads.
- **Confluence site:** Inland city. The wedge of land between rivers becomes the old town. Bridges in multiple directions create multiple commercial axes.
- **Spring line site:** Agricultural town. Located where water emerges at a geological boundary (permeable rock above impermeable rock). Farming hinterland on the fertile lowland side.
- **Defensive hilltop site:** Fortified town. Castle or citadel on the high point, town growing downhill from it. Often on an igneous plug or hard rock outcrop.

Each archetype implies specific constraints for the city generator — where the seed point goes, where industry develops, which bank develops first, where the commercial core forms.

---

## Building Material System

Building material is not a free style choice — it's determined by local geology, following how real pre-industrial cities sourced construction materials from their immediate surroundings:

| Local geology | Building material | Visual character |
|---|---|---|
| Limestone | Pale stone (cream, honey, grey) | Cotswolds, Bath, Paris |
| Sandstone | Warm-toned stone (red, brown, yellow) | Edinburgh, northern English towns |
| Granite | Dark grey stone, rough-hewn | Aberdeen, Breton towns |
| Clay lowlands | Brick (red or yellow depending on clay type) | London, Dutch cities, northern German cities |
| Chalk | Flint with brick or stone dressings | Sussex, Norfolk villages |
| Alluvial plain | Brick or timber-frame (where stone is scarce) | East Anglian towns, river delta cities |

This means a city's visual identity partially emerges from the geology it sits on. Combined with the style parameter (which controls plot proportions, roof forms, window rhythms, and facade articulation), this produces cities that are both geologically grounded and culturally distinct.

---

## Rendering and Performance Architecture

The system targets web deployment using Three.js and glTF/.glb assets.

### Level of Detail

Three LOD tiers manage performance at city scale:
- **Close (within ~50m):** Full 3D component assembly — window modules, door surrounds, cornice details as instanced geometry from a glTF component library.
- **Medium (~50–200m):** Simplified geometry with procedural facade textures generated on canvas — window rectangles, door shapes, brick patterns baked onto flat surfaces.
- **Far (beyond ~200m):** Colored boxes with roof shapes. Minimal geometry.

### Instancing and Batching

Architectural components (windows, doors, railings) are rendered as `InstancedMesh` — one draw call for all instances of "Victorian sash window" across the entire visible city. Materials are consolidated into texture atlases per architectural style to minimize draw calls further.

### Spatial Streaming

The city is divided into spatial tiles. Only tiles near the camera are loaded and have their geometry generated. Tiles generate on demand from the precomputed road network and density field, running Phases B7–B12 at load time. Tiles behind the camera are disposed. This keeps memory bounded regardless of city size.

### Texture Compression

KTX2 with Basis Universal compression for all building textures. City scenes are extremely texture-heavy (brick, stone, stucco, slate, timber) and compressed GPU textures reduce VRAM usage dramatically compared to raw formats.

---

## Offshore and Coastal Detail

For coastal settlements, the system generates offshore bathymetry:
- Off hard rock coasts: deep water close to shore (steep submarine slope matching the cliff above). Ships can approach.
- Off soft rock/beach coasts: shallow water extending well offshore. May need dredged channels for navigation.
- In estuaries: shallow tidal flats with deeper navigable channels maintained by river current.

Offshore depth determines where docks and shipyards can operate, which feeds back into the industrial waterfront placement in city generation.

---

## Implementation Notes

- **Data structures:** The road network is a proper planar graph (nodes at intersections, edges as road segments with width and hierarchy attributes). Blocks are the faces of this graph. Plots are sub-polygons of blocks.
- **Coordinate system:** Work in meters from an origin at the city seed. This makes catchment distances and plot sizes straightforward.
- **Randomness:** Seeded random throughout so worlds are reproducible from a single seed value. Small perturbations (±10–15%) applied to most dimensions to break visual regularity.
- **Performance profile:** Regional generation (Phases A1–A7) operates on grids and is computationally light. City generation (Phases B1–B12) is heavier — road subdivision and centrality calculation are the most expensive steps, but both are tractable for city-scale networks (thousands of edges).

---

## Physical World Assumptions

These are properties of the real world that seem obvious but are easy to get wrong in a generator. When violated, the result feels immediately artificial even if the viewer can't articulate why. They should be treated as bedrock assumptions that the entire generation system respects.

### Roads

**Roads are mostly flat.** Even on hilly terrain, a road's surface is graded to be locally level across its width. Roads don't tilt sideways. The cross-section is flat or very gently cambered for drainage. When a road runs along a slope, the hillside is cut on one side and filled on the other to create a flat platform.

**Roads curve gently.** Straight roads are common on flat terrain, but when roads do curve, the curves are gentle and gradual — long-radius arcs, not sharp kinks. Sharp turns only occur at junctions, hairpin bends on very steep terrain (switchbacks), or in medieval cores where the road follows an ancient footpath. A road that zigzags without terrain reason looks wrong. Even "winding country roads" have individually gentle curves — the winding comes from many gentle curves in sequence, not from sharp angles.

**Roads are smooth in profile.** A road doesn't go up and down over every small bump in the terrain. Road builders cut through small ridges and fill small dips to maintain a smooth gradient. The road's elevation profile should be a smoothed version of the underlying terrain, not a direct copy of it. Undulations in the road surface should have a wavelength of hundreds of meters at minimum, not tens.

**Roads have consistent width.** A given road maintains roughly the same width along its length. Width changes happen at transitions between road types (an arterial narrowing as it enters a historic center) or at specific features (widening at a junction or roundabout), not randomly.

**Junctions are deliberate.** Roads meet at junctions, and junctions have specific geometry — T-junctions, crossroads, Y-forks, roundabouts. Roads don't just brush past each other or merge at arbitrary angles. Junction angles matter: most are near 90° in planned areas, and even in organic layouts, very acute angles (below 30°) are rare because they create impractical building plots and awkward turning movements.

### Rivers

**Rivers don't branch going downstream.** Rivers converge — tributaries join the main channel. The only time a river splits is in a delta at its mouth, or briefly around a river island. Two channels diverging from a single river mid-course and staying separate is physically wrong (water seeks the lowest path, so one channel would capture all the flow).

**Rivers get wider and slower downstream.** As tributaries join and the river accumulates more water, it widens. As the terrain flattens toward the coast, the gradient decreases and the river slows, which increases meandering. A river that's the same width and speed from source to mouth looks artificial.

**Rivers have banks.** The land immediately beside a river is not at the same elevation as the water. There are banks — raised edges formed by sediment deposition during floods. The bank height varies with river size and terrain, but the river should always sit in a channel below the surrounding land, not flush with it.

**Floodplains are flat.** The area beside a river that floods periodically is conspicuously flat — flatter than the surrounding terrain. This flatness is itself a visual signal that says "river floodplain" and should be distinct from the gently rolling terrain nearby.

### Terrain

**Hills are smooth.** Real terrain has gentle, rounded forms at most scales. Noise-generated terrain often has too much high-frequency detail, making the landscape look spiky or crinkled. Outside of cliff faces and rocky outcrops, terrain should be dominated by low-frequency, large-scale forms with only subtle local variation. Think of how real hills look from a distance — smooth, flowing curves, not jagged profiles.

**Valleys have a consistent downhill direction.** A valley is a linear low area between higher ground on either side, and it slopes consistently in one direction (the direction water flows out of it). A valley that goes up and down along its length, or that has no clear drainage direction, is geologically implausible.

**Flat areas are actually flat.** Lowland plains, floodplains, coastal flats, and plateaus should have very little elevation variation. A "flat" area with noticeable bumps everywhere doesn't read as flat. The noise amplitude in these areas should be very low.

### Coastline

**The sea is flat.** The water surface is at a uniform elevation (sea level). The coastline is where the terrain heightmap intersects this flat plane. Any rendering that shows the sea at different heights in different places is wrong.

**Beaches slope gently into the water.** There is no vertical step at the waterline on a beach. The land grade transitions smoothly from dry sand to wet sand to shallow water. Cliff coasts do have a sharp drop, but that's a different coastal type — the cliff face is near-vertical and meets the water abruptly, often with a rocky shelf at the base.

### Buildings

**Buildings are level.** A building's floor is horizontal regardless of the terrain it sits on. On sloped ground, this means the building is cut into the hillside on the uphill side and elevated or terraced on the downhill side. The building footprint adapts to the terrain; the building itself does not tilt.

**Buildings face the street.** The front facade, the entrance, and the architectural detail face the road the building is accessed from. The rear is utilitarian — service areas, back gardens, outbuildings. The sides are typically blank party walls (in terraced construction) or plain secondary facades. A building turned at an arbitrary angle to its street looks wrong.

**Terraces are level with each other.** A row of terraced houses shares a continuous roofline, cornice line, and floor level. On sloping streets, the terrace steps — each house (or group of 2–3 houses) steps up or down by one course of bricks or stone to follow the street gradient, but within each step the houses are level. The stepping creates a characteristic saw-tooth roofline visible in profile.

**Buildings have appropriate proportions.** A house is taller than it is deep, and deeper than it is wide (in a terraced context). A warehouse is wider than it is tall. A church tower is much taller than it is wide. These proportions are so ingrained that a building with wrong proportions reads as alien even if all other details are correct.

### General

**Everything avoids water except where it's designed not to.** Roads, buildings, and all human infrastructure are placed above the flood level and away from the water's edge, except for specific water-interfacing structures — bridges, docks, quays, waterfront promenades, mills. A building whose footprint extends into a river, or a road that runs through a marsh, is wrong.

**Gravity applies everywhere.** Water flows downhill. Sediment accumulates at the bottom of slopes. Roads avoid going uphill when a flatter route exists. Buildings are built on the flattest available ground. People build cities in valleys and lowlands, not on mountaintops (unless defending against attack). Every placement decision should be consistent with the principle that going uphill costs effort and going downhill is easy.

**Human activity concentrates and fades.** The densest human activity is at the city center and it fades outward — dense commercial core, dense residential, suburban, rural fringe, farmland, wilderness. This gradient should be smooth and continuous, not patchy. The same principle applies at smaller scales: a commercial high street has the most activity, side streets less, back lanes least.

---

## City Extent and Growth Limits

The generator needs to know when to stop. A city doesn't fill all available land — it grows until its population is housed, its commerce is served, and its industry is accommodated. Everything beyond that is countryside. Getting this wrong in either direction is immediately visible: a city that stops abruptly with empty buildable land inside its boundary feels truncated, and a city that sprawls uniformly across the entire map regardless of population feels like wallpaper.

### What Determines City Size

The primary input is the **target population**, derived from the settlement's tier in the regional hierarchy. A regional capital might target 100,000–500,000. A market town might target 5,000–20,000. A village might target 200–1,000. This number, combined with density parameters, determines how much land the city needs.

The relationship between population and area depends on density, which varies by zone:

| Zone type | Typical density | People per hectare |
|---|---|---|
| Dense historic core | High | 150–300 |
| Terraced residential | Medium-high | 80–150 |
| Semi-detached suburban | Medium | 40–80 |
| Detached suburban | Low | 15–40 |
| Industrial | N/A (employment, not residential) | 20–50 workers/ha |
| Commercial core | N/A (daytime population) | 200–500 workers/ha |

The generator computes the total area needed by dividing the target population by the average residential density (weighted by the mix of zone types for this city's era and style), then adds area for non-residential uses (commercial, industrial, infrastructure, green space — typically 30–50% on top of residential area).

### The Growth Boundary

The city doesn't have a hard wall. It has a growth boundary that emerges from the interaction of population demand and terrain constraints:

**The density field defines where building is worthwhile.** The density field (Phase B3) already falls off with distance from the center. At some radius, the density drops below a minimum viable threshold — below which it's not worth subdividing land into plots and building on it. This natural falloff creates the city edge.

**Terrain constrains where growth can go.** The city expands preferentially along flat corridors (river valleys, coastal plains, road routes through easy terrain) and avoids steep slopes, marshland, and floodplain. This means the city boundary is irregular — fingers of development extending along valleys and roads, with countryside pushing in on the steep or wet sides.

**The generator should stop adding roads and plots when either:**
1. The accumulated population (sum of density × area across all residential plots) reaches the target population, OR
2. All remaining unbuilt land within reasonable distance of the center is unsuitable (too steep, too wet, too far from road access)

Whichever condition is met first determines the city's extent. A city on a flat plain hits condition 1 — it stops growing because everyone is housed, leaving buildable land beyond the boundary. A city in a narrow valley might hit condition 2 — terrain limits growth before the target population is fully accommodated, resulting in a denser, more compact city.

### The Generation Sequence for Extent Control

In practice, this means the city generation phases (B4 through B10) should work outward from the center in concentric waves rather than trying to fill a predetermined area:

1. **Start at the city seed.** Generate the first arterials, the central commercial district, the densest residential blocks.
2. **Expand outward.** Each expansion wave adds the next ring of collector roads, blocks, plots, and buildings. After each wave, compute the running population total.
3. **Check the population budget.** If the target is reached, stop expanding. The current edge of development becomes the city boundary. Any remaining density field values beyond this point are unused — that's the countryside.
4. **Check the terrain budget.** If the next expansion wave would only cover unsuitable land (steep, wet, disconnected), stop expanding even if the population target isn't met. The city is terrain-constrained and will be denser than the default parameters would suggest.

This outward-wave approach naturally produces the density gradient that real cities have — dense at the center, thinning toward the edges, with the outermost ring being the most recent and lowest-density development.

### What Happens at the City Edge

The boundary between city and countryside is not a line — it's a transition zone. The generator should produce:

- **A suburban fringe** where plot sizes increase, building density drops, and gardens get larger. The outermost residential development should feel spacious and incomplete compared to the center.
- **Fragmented development** at the very edge — isolated houses along roads leading out of town, a farm that's been partially surrounded by development, a pub at a road junction just beyond the last row of houses.
- **Infrastructure that continues beyond the boundary** — the regional roads don't stop at the city edge, they continue into the countryside. This is already handled by the regional road network, but the local representation should show these roads transitioning from urban streets (with pavements, buildings on both sides) to rural roads (with hedgerows, fields on both sides) over a few hundred meters.
- **Land use transition** — the city's market gardens and allotments tend to be at the fringe. Beyond that, organized farmland. The land cover system (Phase B12 and the regional land cover) should produce this gradient naturally when the settlement clearing radius interacts with the city boundary.

### Population Accounting

The generator should maintain a running population count as it places buildings:

- Each residential building houses a number of people based on its type and size (a terraced house might hold 4–6 people, an apartment block might hold 20–100).
- Each commercial and industrial plot employs a number of people based on its area and type.
- The total residential population should approximately match the target.
- The total employment should be a realistic fraction of the residential population (typically 40–60% of population in employment, not all within the city — some commute, some work from home).

This accounting ensures the city is the right size for its population. It also provides a useful diagnostic: if the generator places far more buildings than the population requires, the density parameters are too low. If it runs out of suitable land before housing the population, the density parameters are too high for the terrain, and the city needs to grow taller or denser.

### Size Benchmarks

For calibration, some real-world rough benchmarks:

| Population | Approximate built-up area | Character |
|---|---|---|
| 500 | 5–10 hectares | Village — a handful of streets |
| 2,000 | 20–40 hectares | Large village or hamlet |
| 10,000 | 100–200 hectares | Small town |
| 50,000 | 500–1,200 hectares | Market town or small city |
| 200,000 | 2,000–5,000 hectares | Regional city |
| 500,000 | 5,000–15,000 hectares | Major city |

These vary enormously by era and density — a medieval town of 10,000 is much more compact than a modern town of 10,000 — but they provide order-of-magnitude sanity checks for the generator's output.

---

## Validation Framework

### Three-Tier Structure

Both regional and city generation are validated using the same framework:

**Tier 1 — Validity (boolean, must pass):** Physical impossibilities and logical contradictions. Roads in water, buildings overlapping, rivers flowing uphill, disconnected road networks. Any failure means the generation is broken.

**Tier 2 — Structure (scored 0.0–1.0, thresholds):** Proportional measures of how well the output satisfies structural rules. Every building has road access, roads respect terrain gradients, rivers have appropriate sinuosity, settlements are in geographically sensible locations. Below-threshold scores indicate systematic generation problems.

**Tier 3 — Quality (scored 0.0–1.0, soft):** Holistic measures of how natural the output feels. Land use efficiency, frontage continuity, coastline fractal dimension, road network hierarchy ratios, block shape quality. Used for tuning and comparison.

### Key Checks by Domain

**Terrain and geology:** Rock type correlates with elevation. Terrain transitions are smooth except at geological boundaries. Valleys exist where rivers flow.

**Water:** Rivers flow downhill, converge into dendritic networks, widen downstream, meander on flat ground, and terminate at the coast. Coastlines reflect geology — headlands on hard rock, bays on soft rock, smooth shores at river mouths. No axis-aligned noise artifacts.

**Land cover:** Elevation zonation is respected. Farmland is on flat fertile ground near settlements. Marsh is on waterlogged impermeable ground. Forest survives on slopes too steep to farm. Transitions between cover types are gradual.

**Settlements and roads:** Settlements are at geographically advantaged sites. Ports have sheltered harbors. Roads follow terrain, use valleys and passes, cross rivers at narrow points. Road hierarchy matches settlement hierarchy. No dead ends except at map edges.

**City structure:** Every building has road access. Streets form through-connected loops. Density matches the density field. Zoning is coherent. Amenities cover their catchments. Building heights respect the street hierarchy. Waterfront is actively used.

**City quality:** Land is used efficiently relative to density targets. Terraces align on flat ground. Frontages are continuous on commercial streets. Block shapes are compact. Gardens and green space are proportional to density.

**Land cover (regional):** Elevation zonation is followed — farmland in lowlands, forest at mid-elevation, moorland on high ground. Slope limits are respected (no arable on steep slopes). Marsh only on waterlogged impermeable ground. Settlement clearing radii scale with settlement size. Land cover patches are coherent (not salt-and-pepper noise). Transitions between cover types are gradual with appropriate buffer zones.

**Land cover (city):** Every residential area within 400m of green space. Rivers have vegetation buffers. Steep undeveloped slopes have woodland cover. Garden provision matches density zone expectations.

### Composite Score

```
valid = all Tier 1 checks pass (both regional and city)
structural = weighted mean of Tier 2 scores (0.6 weight in overall)
quality = weighted mean of Tier 3 scores (0.4 weight in overall)
overall = structural * 0.6 + quality * 0.4 (gated by validity)
```

---

## Parameter Reference

All generation parameters consolidated. A single world is defined by these values plus a random seed.

### Regional Parameters

| Parameter | Effect |
|---|---|
| `geology_band_direction` | Angle of sedimentary banding — gives geological "grain" to the landscape |
| `geology_complexity` | Number of rock type transitions across the map |
| `igneous_intrusion_count` | Volcanic/plutonic intrusions cutting through sedimentary bands |
| `erosion_resistance_contrast` | Difference between hard and soft rock — high contrast gives dramatic coastlines |
| `sea_level` | Where the coast falls — raising floods lowlands, lowering exposes more land |
| `river_density_multiplier` | Scales flow accumulation threshold — more or fewer visible streams |
| `meander_intensity` | How much rivers wander on soft ground |
| `coastal_erosion_intensity` | How far soft rock coasts are pushed inland relative to hard rock |
| `climate_temperature` | Shifts elevation bands — warmer climates have higher treeline and farming limits |
| `climate_rainfall` | Affects forest density, marsh prevalence, farming viability |
| `farming_intensity` | How aggressively land is converted to agriculture near settlements |
| `treeline_elevation` | Elevation above which trees don't grow |

### City Parameters

| Parameter | Effect |
|---|---|
| `city_tier` | Target population/area — scales everything |
| `organic_vs_grid` | 0.0 = fully organic, 1.0 = rigid grid |
| `era` | Affects plot sizes, building types, road widths |
| `style` | Cultural style (British, German, American, etc.) — drives plot proportions and building grammar |
| `density_falloff` | How quickly density drops from center — compact vs sprawling |
| `landmark_frequency` | How many special buildings per district |
| `max_building_height` | Caps floor count — keeps the city to a consistent era feel |
| `urban_green_ratio` | Target proportion of city area as green space |

Note: Many city properties are not free parameters — they're inherited from the regional data. Building material comes from geology. Terrain character comes from the heightmap. Road entry points come from regional infrastructure. Settlement character type comes from site scoring. These inherited properties are what makes each city feel connected to its landscape rather than independently generated.

---

## What Makes This System Different

Most procedural city generators work top-down — they impose a street grid, place buildings, add decoration. This system works bottom-up — geology creates terrain, terrain creates rivers, rivers create crossing points, crossing points create settlements, settlements create roads, roads create blocks, blocks create plots, plots create buildings. The result is a world where every feature can answer the question "why is this here?" and the answer always traces back to the physical landscape.

The validation framework means the system can measure its own output quality, identify specific failures, and either repair them or flag them for parameter tuning. This closes the loop between generation and quality, making it possible to systematically improve the generators rather than relying on visual inspection.

The two-scale architecture (region → city) means cities don't exist in isolation. They have hinterlands, trade routes, neighboring settlements, and a reason for being where they are. Zooming into a city reveals detail that's consistent with the regional context, and zooming out from a city shows the landscape that explains it.

---

## Open Questions and Future Directions

**Temporal layering.** Real cities have historic cores with medieval streets, surrounded by later expansions with different street patterns. Generating the city in historical phases (small core → expansion rings) would add convincing layered character. The density field and road hierarchy already support this conceptually — the question is whether to generate phases sequentially or approximate the effect in a single pass.

**Economic simulation.** The current system places settlements based on geographic advantage but doesn't simulate trade, growth, or competition between settlements. A lightweight economic model could make the settlement hierarchy more dynamic — ports grow when trade increases, mining towns boom and bust, market towns compete for hinterland.

**Interior and street-level detail.** The current pipeline goes down to building footprints and massing. The next level of detail — shopfronts, street furniture, signage, paving materials, interior layouts — follows the same layered logic but at a finer scale. Street furniture style follows from era and cultural parameters. Paving material follows from local geology. Shopfront character follows from the commercial zoning.

**Defensive structures.** Walls, castles, and fortifications are absent from the current plan but historically critical to city form. A walled city has a fundamentally different layout from an unwalled one — constrained growth, dense packing, gates that become traffic bottlenecks and commercial nodes. Adding a fortification layer between settlement placement and city road generation would capture this.

**Water infrastructure.** Wells, aqueducts, reservoirs, and sewers shaped real cities profoundly. The spring line concept from the geology plan (water emerging at rock type boundaries) could drive well placement. Water supply constraints could limit city growth in areas far from reliable sources.

**Climate and weather.** The current system has minimal climate parameters (temperature and rainfall affecting land cover). Expanding this to include prevailing wind direction would influence building orientation (sheltered facades), industrial placement (downwind of residential), and coastal erosion patterns.
