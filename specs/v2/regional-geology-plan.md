# Regional Geology & Hydrology Generation Plan

## Overview

Geology is the hidden layer that explains why terrain, coastlines, and rivers look the way they do. Rather than generating these features independently and hoping they look coherent, this plan generates geology first and derives the visible landscape from it. The result is a regional map where cliffs, beaches, river gorges, broad valleys, and settlement sites all arise from the same underlying logic.

---

## Phase 1: Geological Substrate

**Goal:** Generate an invisible geology layer that drives all subsequent terrain generation.

### 1.1 Rock Type Map

Generate a geology map covering the full regional area using 4–5 rock types, each with distinct properties:

| Rock type | Erosion resistance | Typical terrain | Real-world examples |
|---|---|---|---|
| Igneous (granite, basalt) | Very high | Rugged highlands, dramatic cliffs, tors | Scottish Highlands, Cornwall |
| Hard sedimentary (limestone, sandstone) | High | Plateaus, escarpments, karst features | Cotswolds, Yorkshire Dales |
| Soft sedimentary (clay, mudstone, shale) | Low | Rolling lowlands, wide valleys, gentle shores | Thames basin, English Midlands |
| Chalk | Medium | Rounded hills, white cliffs, downland | South Downs, Dover |
| Alluvial deposits | Very low | Flat plains, river deltas, flood plains | East Anglia, Netherlands |

**Generation method:** Use large-scale noise with a dominant directional bias to create roughly parallel bands — this mimics real sedimentary layering where rock strata were laid down in sequence and later tilted. The bands don't need to be perfectly parallel; gentle curves and varying width are more natural. Then punch through the banding with one or two irregular igneous intrusions (generated as blob shapes using a separate noise layer), representing volcanic or plutonic events that cut across the sedimentary layers.

Alluvial deposits are not placed in this phase — they're generated later wherever rivers deposit sediment (Phase 3).

### 1.2 Rock Properties

Each rock type carries properties that downstream generation will use:

- **Erosion resistance** (0.0–1.0): Controls how much water and weather reshape the terrain
- **Permeability** (0.0–1.0): How much water soaks through vs runs off. Limestone is highly permeable (water goes underground, fewer surface streams). Clay is impermeable (lots of surface water, boggy ground). This affects river density.
- **Cliff tendency** (0.0–1.0): How likely the rock is to form vertical faces when eroded, vs gentle slopes. Hard rocks fracture and collapse into cliffs. Soft rocks slump into gradual slopes.
- **Soil fertility** (0.0–1.0): Drives land use — fertile lowlands become farmland and attract settlement, thin rocky soils stay as rough grazing or wilderness.

---

## Phase 2: Terrain Generation from Geology

**Goal:** Generate the heightmap as a function of the geology, so that terrain shape reflects the underlying rock.

### 2.1 Base Elevation

Instead of generating terrain noise independently, modulate it by rock type:

- **Igneous zones** get higher base elevation and higher noise amplitude — these are the mountains and highlands. Use steep, high-frequency noise for rugged peaks.
- **Hard sedimentary zones** get moderate elevation with a characteristic plateau-and-escarpment profile. An escarpment forms where hard rock meets soft rock — one side slopes gently (dip slope), the other drops steeply (scarp slope). Generate this by detecting boundaries between hard and soft sedimentary bands and steepening the terrain on one side.
- **Soft sedimentary zones** get lower elevation and smoother, gentler noise — rolling lowland countryside.
- **Chalk zones** get rounded, smooth hills (downs) with moderate elevation. Low noise frequency, moderate amplitude.

### 2.2 Geological Boundaries

Where two rock types meet, the terrain should transition in geologically appropriate ways:

- **Hard meets soft:** An escarpment or ridge forms at the boundary. The hard rock stands higher, creating a natural edge. Many real-world roads and settlements follow the spring line at the base of these escarpments (water percolating through porous upper rock hits impermeable lower rock and emerges as springs).
- **Igneous intrusion meets sedimentary:** Abrupt terrain change. The intrusion may stand as a dramatic hill or ridge above the surrounding lowland (like Edinburgh Castle's volcanic plug).
- **Same-type boundaries:** Subtle or no terrain change, just a variation in surface character.

### 2.3 Elevation Summary

The regional heightmap is now geology-driven. High ground corresponds to resistant rock, lowlands to soft rock, and the transitions between them create natural landscape features (escarpments, ridgelines, plateaus) rather than arbitrary noise patterns.

---

## Phase 3: River System Generation

**Goal:** Generate a hydrologically consistent river network that responds to geology.

### 3.1 Drainage Network from Terrain

Use flow accumulation on the heightmap:

1. For each cell, determine the direction water would flow (steepest downhill neighbor).
2. Accumulate flow — each cell's flow value is 1 + the sum of all upstream cells flowing into it.
3. Where flow accumulation exceeds a threshold, a stream exists. Higher thresholds give fewer, larger rivers; lower thresholds give dense stream networks.

The threshold should vary by geology: impermeable rock (clay, igneous) gets a lower threshold (more surface streams), permeable rock (limestone, chalk) gets a higher threshold (water goes underground, fewer visible streams). This gives you the right density of waterways for each landscape type — dense stream networks on clay lowlands, sparse dry valleys on chalk downs.

### 3.2 River Character from Geology

Once the river network exists as a set of flow paths, the character of each river segment depends on the rock it's flowing through:

**In hard rock (igneous, hard sedimentary):**
- Narrow, deep valleys — the river cuts a gorge or V-shaped valley
- Steepen the terrain on both sides of the river channel
- Minimal floodplain
- Rapids, waterfalls where rock hardness changes abruptly
- River follows structural weaknesses in the rock (faults, joints) — can create angular, less meandering paths

**In soft rock (clay, mudstone):**
- Wide, gentle valleys — the river erodes laterally as well as downward
- Broad floodplain on both sides (widen the low-lying area around the river)
- Meandering course — add sinuosity to the river path using sine-wave displacement or spline curves with randomized control points
- Ox-bow lakes and old meander scars on the floodplain (optional visual detail)

**In chalk/limestone:**
- Rivers may disappear underground (sinking streams) and re-emerge lower down
- Dry valleys — valleys with no river in them, carved during ice ages when the ground was frozen and impermeable
- Where rivers do flow on the surface, they tend to be clear and steady (spring-fed from groundwater)

**Transitioning between rock types:**
- A river flowing from hard rock into soft rock widens and slows — the valley opens out. This transition zone is often where settlements develop (good water supply from upstream, flat buildable land at the transition).
- A river flowing from soft rock into hard rock narrows and speeds up, sometimes creating a gorge. These gorges become natural defensive positions and crossing points (bridges at narrow points).

### 3.3 River Confluence Behavior

Where tributaries join the main river:

- The combined river downstream should be wider (take the sum of upstream flow accumulation).
- Confluences on soft rock create broad flat areas — natural town sites.
- Confluences on hard rock create dramatic meeting points in narrow valleys.
- The angle of confluence is influenced by the terrain — tributaries from steep terrain join at sharper angles, those from gentle terrain join at shallow angles.

### 3.4 Alluvial Deposits

Now generate the alluvial deposit layer that was deferred from Phase 1:

- Along river floodplains in soft rock areas, replace the surface geology with alluvial deposits
- At river mouths (where river meets coast or lake), create delta or estuary deposits spreading outward in a fan shape
- At points where rivers slow down (entering flat terrain, behind natural dams) deposit alluvium
- Alluvial areas are the most fertile land and the flattest ground — they strongly attract settlement and agriculture

---

## Phase 4: Coastline Generation from Geology

**Goal:** Generate coastlines where the shape, character, and features arise from the underlying rock meeting the sea.

### 4.1 Base Coastline

Define sea level and find where the heightmap intersects it. This gives a raw coastline, but it will look too smooth or too noisy depending on the terrain generation. The geology layer now refines it.

### 4.2 Differential Erosion

Walk along the coastline and at each point check the underlying rock type. Modify the coastline position and character:

**Hard rock coast (igneous, hard sedimentary):**
- The coastline holds its position — the land resists being pushed back
- These sections become headlands that jut out into the sea
- Terrain drops steeply to the water — generate cliffs by steepening the last 20–50m of terrain before sea level to near-vertical
- Cliff height equals the land elevation at that point
- Rocky foreshore — irregular rocks at the base of the cliff at sea level
- Optional: sea stacks and small islands just offshore (isolated remnants of eroded headland), generated as small above-sea-level cells detached from the main coastline

**Soft rock coast (clay, mudstone, soft sedimentary):**
- The coastline is pushed further inland — the sea has eroded this section more
- Apply an inward offset (50–300m depending on erosion resistance) relative to where the raw heightmap coastline would be
- Gentle slope to the water — flatten the terrain over the last 100–200m to create a gradual shore
- Sandy or muddy beach develops
- These indented sections become bays between the hard-rock headlands

**Chalk coast:**
- Cliffs form (chalk is hard enough to stand vertically) but the coastline still retreats
- Moderate inward offset — less than clay but more than granite
- Vertical white cliff faces — distinctive visual character
- Wave-cut platform at the base (flat rocky shelf at sea level)

**Alluvial/river mouth coast:**
- Flat, low-lying, with the coastline potentially extending outward (delta formation)
- Wide tidal flats and marshland
- The coastline is irregular and complex — many small channels, islands, and sandbanks
- Generate by adding low-amplitude, high-frequency noise to the coastline boundary in these areas

### 4.3 Coastal Feature Identification

After differential erosion, scan the coastline for emergent features and tag them:

**Bays:** Concave sections of coastline (soft rock between headlands). Measure the enclosure — how much of the bay opening is blocked by flanking headlands. More enclosed bays provide better shelter.

**Headlands:** Convex sections on hard rock. The tips of headlands are exposed to waves from multiple directions — potential lighthouse or fortification sites.

**Natural harbors:** Bays with good enclosure AND adequate water depth (check the offshore heightmap slope — a bay that's too shallow is a tidal flat, not a harbor). Score harbors by: enclosure (shelter from waves), depth, size, and proximity to fresh water (nearby river). The best-scoring harbor is the prime settlement site.

**Estuaries:** Where a river meets the coast. The river mouth widens into a funnel shape. Generate by progressively widening the river channel over the last 1–3km before the coast, with tidal flats on both sides. Estuaries provide both harbor and river navigation — highest settlement value.

**Beach zones:** Gentle-slope sections between headlands. Width proportional to the available sediment (more rivers upstream = wider beaches, as rivers supply sand and gravel to the coast).

**Cliff sections:** Steep-slope sections on hard or chalk rock. Tag with cliff height for visual generation. Cliff-top paths but no waterfront access except at specific points (coves, where a stream valley cuts through the cliff).

### 4.4 Offshore Depth

Generate a simple offshore bathymetry by extending the terrain slope below sea level:

- Off hard rock coasts: deep water close to shore (steep submarine slope matching the cliff above)
- Off soft rock/beach coasts: shallow water extending well offshore (gentle submarine slope)
- In estuaries: shallow channels with deeper navigable channels where the river current maintains depth

This matters for harbor viability — deep water close to shore means ships can approach, shallow water means they can't (or need dredged channels).

---

## Phase 5: Settlement Site Scoring

**Goal:** Use all the geological and hydrological data to identify the best settlement locations.

### 5.1 Site Scoring Function

For each candidate cell in the regional map, compute a settlement potential score as a weighted sum:

| Factor | Score contribution | Rationale |
|---|---|---|
| River crossing viability | High positive at narrow points, where hard rock creates a short bridgeable span | Control of crossing = trade and strategic value |
| River confluence | High positive | Multiple transport routes meet |
| Natural harbor quality | Very high positive (enclosure × depth × size) | Maritime trade access |
| Estuary location | Very high positive | Combined river and sea access |
| Flat buildable land | Moderate positive, scaled by area | Space to grow |
| Soil fertility nearby | Moderate positive, measures agricultural hinterland | Food supply |
| Spring line (hard/soft rock boundary) | Moderate positive | Reliable fresh water supply |
| Defensive terrain | Moderate positive for hilltops, river bends, peninsulas | Historical settlement preference |
| Elevation above flood | Low positive | Safety from flooding |
| Steep terrain | Negative | Difficult to build on |
| Floodplain | Negative for settlement core (positive for industry later) | Flood risk |
| Exposed coast (no shelter) | Negative | Poor harbor, dangerous seas |

### 5.2 Settlement Hierarchy

Sort all candidate locations by score. The top sites become cities, the next tier towns, then villages. Enforce minimum spacing — no two cities within a configurable distance (perhaps 30–50km), no two towns within 10–15km.

### 5.3 Settlement Character from Geology

The geology and hydrology at each settlement site determines its character, which feeds into city generation:

- **Estuary site:** Major port city. Wide flat area for docks. River provides inland trade. City develops on the better-drained bank first.
- **Harbor site:** Coastal town. Development wraps around the harbor. Fishing and maritime economy. Limited by the size of the flat land behind the harbor.
- **River crossing site:** Inland market town. Roads converge at the bridge. Commercial center near the crossing, spreading along approach roads.
- **Confluence site:** Inland city. The wedge of land between rivers becomes the old town. Bridges in multiple directions create multiple commercial axes.
- **Spring line site:** Agricultural town. Located where water emerges at a geological boundary. Farming hinterland on the fertile lowland side.
- **Defensive hilltop site:** Fortified town. Castle or citadel on the high point, town growing downhill from it. Often on an igneous plug or hard rock outcrop.

---

## Phase 6: Regional Infrastructure from Geology

**Goal:** Route roads and identify resource locations based on the geological landscape.

### 6.1 Road Routing

Regional roads connect settlements, but their routes are constrained by geology:

- Roads follow river valleys through hard rock terrain (the valley is the only practical route through highlands)
- Roads cross ridges and escarpments at passes — find the lowest points along hard/soft rock boundaries
- Roads follow the spring line along escarpment bases (flat, well-watered, good ground — many real English roads follow ancient spring line routes)
- Bridges are placed at the narrowest viable river crossing — where hard rock constrains the channel
- Coastal roads follow cliff tops on hard rock coasts, or run behind the beach zone on soft coasts

### 6.2 Resource Locations

Geology determines what resources exist where:

- **Quarrying:** Hard rock outcrops near the surface, especially at escarpments and cliff faces. Determines local building material — limestone areas get limestone buildings, granite areas get granite buildings, clay areas get brick.
- **Mining:** Mineral deposits associated with igneous intrusions or specific sedimentary layers. Place randomly within appropriate rock type zones.
- **Agriculture:** Alluvial plains and soft rock lowlands with fertile soil. Drives the economic hinterland of settlements.
- **Forestry:** Steeper terrain with moderate soil — hillsides that are too steep to farm but not bare rock.
- **Fishing:** Coastal settlements near productive waters (shallow offshore shelves, river estuaries).

### 6.3 Building Material Zones

This feeds directly into city visual generation later. The dominant local rock type determines the default building material for settlements in that area:

| Geology | Building material | Visual character |
|---|---|---|
| Limestone | Pale stone (cream, honey, grey) | Cotswolds, Bath, Paris |
| Sandstone | Warm-toned stone (red, brown, yellow) | Edinburgh New Town, northern English towns |
| Granite | Dark grey stone, rough-hewn | Aberdeen, Breton towns |
| Clay lowlands | Brick (red or yellow depending on clay type) | London, Dutch cities, northern German cities |
| Chalk | Flint with brick or stone dressings | Sussex, Norfolk villages |
| Alluvial plain | Brick (from local clay) or timber-frame (where stone is scarce) | East Anglian towns, river delta cities |

This means a city's visual identity partially emerges from the geology it sits on, which is exactly how real cities work.

---

## Integration with Existing Regional Pipeline

### Generation Order

1. **Geology layer** (this plan, Phase 1) — rock type map
2. **Terrain heightmap** (this plan, Phase 2) — driven by geology
3. **River network** (this plan, Phase 3) — flow accumulation on geology-aware terrain
4. **Coastline refinement** (this plan, Phase 4) — differential erosion from geology
5. **Settlement scoring and placement** (this plan, Phase 5) — using all above
6. **Regional infrastructure** (this plan, Phase 6) — roads, resources
7. **City generation** (existing city plan) — zooming in on a settlement site

### Data Passed to City Generator

When zooming in on a settlement for city-scale generation, pass forward:

- **Local geology** at higher resolution (refine the regional geology map with local detail)
- **Settlement character type** (estuary, harbor, crossing, confluence, etc.)
- **River geometry** at the site (width, floodplain extent, bank heights, crossing points)
- **Coastline geometry** if applicable (cliff sections, beach sections, harbor shape)
- **Regional road entry points** with their approach directions
- **Local building material** derived from geology
- **Terrain heightmap** refined to local resolution
- **Offshore depth** if coastal (determines where docks and shipyards can go)

---

## Parameter Summary

| Parameter | Effect |
|---|---|
| `geology_band_direction` | Angle of sedimentary banding (gives geological "grain" to the landscape) |
| `geology_complexity` | Number of rock type transitions across the map |
| `igneous_intrusion_count` | Number of volcanic/plutonic intrusions cutting through the bands |
| `erosion_resistance_contrast` | How much difference between hard and soft rock — high contrast gives dramatic headland/bay coastlines |
| `sea_level` | Where the coast falls — raising this floods lowlands, lowering it exposes more land |
| `river_density_multiplier` | Scales the flow accumulation threshold — more or fewer visible streams |
| `meander_intensity` | How much rivers wander on soft ground |
| `coastal_erosion_intensity` | How far soft rock coasts are pushed inland relative to hard rock |
| `cliff_height_multiplier` | Scales the steepness of cliff faces |
| `soil_fertility_noise` | Additional variation in soil quality beyond the geology-driven baseline |
