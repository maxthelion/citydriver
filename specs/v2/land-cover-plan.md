# Land Cover & Vegetation Generation Plan

## Overview

Land cover — what actually grows on or covers the ground — is the visual skin of the landscape. It's what makes a region feel like a specific place: dark pine forests on northern hillsides, golden wheat fields on lowland plains, heathland on windswept uplands, marshes in river floodplains. Like everything else in this generation pipeline, land cover isn't random. It's determined by geology, elevation, slope, drainage, climate, and human activity, in roughly that order.

This plan covers generation at both regional and city scales, because the two are connected — a city surrounded by farmland looks and functions differently from one carved out of forest, and the land cover within a city (parks, gardens, allotments, urban trees) is influenced by what the landscape was before the city was built.

---

## Part 1: Regional Land Cover

### The Determining Factors

Land cover at any point is driven by a stack of factors. Think of it as a suitability calculation — each land cover type has conditions it thrives in, and the type with the highest suitability wins.

**Elevation** is the broadest control. Lowlands support agriculture and dense forest. Mid-elevations support mixed woodland and pasture. High elevations transition through moorland/heathland to bare rock and alpine conditions. This mirrors real altitudinal zonation.

**Slope** determines whether land is usable. Flat to gentle slopes can be farmed. Moderate slopes support grazing and woodland. Steep slopes are too difficult to work and remain as wild vegetation or bare rock. Very steep slopes (cliff faces) have no vegetation at all.

**Geology and soil** determine fertility. Alluvial deposits and soft sedimentary lowlands produce rich soils that get farmed. Thin soils over hard rock support rough grazing or heath. Limestone produces distinctive grassland (thin soil but high pH). Acidic igneous rock produces heather moorland and bog. Chalk supports specific downland grass and wildflower communities.

**Drainage and water** are critical. Poorly drained flat land (low-lying clay, floodplains, coastal flats) becomes marsh or bog. Well-drained slopes support woodland. River corridors have their own riparian vegetation — willows, alders, water meadows.

**Human activity** overrides natural vegetation within a distance of settlements. Near towns and cities, forest is cleared for farmland. Farmland is most productive on the best soils, so the best land gets farmed first. Remaining forest survives on land too steep, too wet, too rocky, or too remote to farm economically.

**Proximity to coast** creates its own conditions — salt-tolerant vegetation on coastal margins, sand dunes, salt marshes in sheltered estuaries.

### Land Cover Types

The following types form a practical set for generation. Each has clear visual character and clear generation rules.

#### Dense Forest

**What it looks like:** Continuous tree canopy. Deciduous (oak, beech) in lowlands with good soil. Coniferous (pine, spruce) on higher ground, thinner soils, and north-facing slopes. Mixed in transition zones.

**Where it occurs:**
- Mid-elevation (100–500m depending on climate parameter)
- Moderate slopes (5–25°) — too steep to farm, not too steep for trees
- Adequate rainfall (not arid)
- Distance from settlements — forest is cleared near habitation, so forest density increases with distance from towns
- Not on waterlogged ground (that becomes marsh)

**Generation rule:** High suitability where elevation is moderate, slope is moderate, soil is adequate, drainage is good, and distance from settlement exceeds a threshold (5–15km for major clearing, 2–5km for partial clearing). Suitability drops in the immediate hinterland of towns (cleared for farmland) and at high elevations (above treeline).

#### Open Woodland / Scattered Trees

**What it looks like:** Trees present but not continuous canopy. Grassland or heath visible between trees. Parkland character.

**Where it occurs:**
- Transition zones between forest and farmland
- Areas partially cleared by human activity but not fully converted to agriculture
- Drier or thinner-soiled areas where forest can't fully close canopy
- Common on the margins of settlements — the zone between farmed land and wild forest

**Generation rule:** Moderate forest suitability combined with moderate human activity proximity. Also occurs on land that's marginal for both farming (too steep or thin-soiled) and dense forest (too dry or exposed).

#### Farmland — Arable

**What it looks like:** Open fields in regular or semi-regular patterns. Crops visible seasonally (golden in late summer, green in spring, brown/bare in winter). Field boundaries (hedgerows, stone walls, fences) divide the landscape.

**Where it occurs:**
- Flat to gently sloping land (below 8° slope)
- Fertile soil (alluvial deposits, soft sedimentary lowlands, river terraces)
- Within economic reach of settlements (historically within a day's travel, roughly 15–20km)
- Well-drained but not arid
- Below the elevation limit for viable crops (varies by climate — 200–400m in cool climates, higher in warm)

**Generation rule:** Highest suitability on flat, fertile, well-drained lowlands near settlements. This is the primary land use around most towns and cities on good land. Field patterns can be generated as Voronoi subdivision of the farmland area with some regularity bias.

#### Farmland — Pasture

**What it looks like:** Green grass fields, sometimes with visible livestock. Less regular than arable fields. Can include rough grazing that blends into moorland.

**Where it occurs:**
- Gently to moderately sloping land (5–15°) — too steep for ploughing but fine for grazing
- Wetter areas where arable farming is impractical
- Higher elevations than arable but below moorland
- On less fertile soils that can still support grass
- Also on good lowland soils in wetter climates where grass grows better than crops

**Generation rule:** Moderate suitability where arable suitability drops off — slopes too steep for ploughing, soils too thin or wet for crops, elevations above arable limits. Pasture is the transition between arable farmland and wild upland.

#### Moorland / Heathland

**What it looks like:** Open, treeless upland covered in heather, rough grass, and bracken. Purplish-brown in most seasons. Exposed and windswept character. May include scattered boulders.

**Where it occurs:**
- Higher elevations (above 250–400m depending on climate)
- Acidic soils, typically over igneous or sandstone geology
- Exposed, windy positions — ridge tops, plateaus
- Too high or thin-soiled for trees, too elevated for farming
- Well-drained slopes (wet equivalents become bog)

**Generation rule:** High suitability on elevated terrain with acidic geology (igneous, sandstone), above the treeline threshold but below bare rock. Slope doesn't matter much — moorland occurs on both slopes and plateaus at the right elevation.

#### Bog / Wetland / Marsh

**What it looks like:** Flat, waterlogged ground with reeds, sedges, moss. Dark water visible between vegetation. Difficult to cross. May have standing water pools.

**Where it occurs:**
- Flat, low-lying, poorly drained ground — floodplains, coastal flats, low basins
- Behind coastal barriers (salt marsh)
- On impermeable rock (clay, some igneous) where water can't drain away
- In high-rainfall areas on flat plateaus (blanket bog)
- Along river margins and in old oxbow meander scars

**Generation rule:** High suitability where terrain is flat (below 3° slope), elevation is low relative to the water table (near rivers, coast, or in basins), and geology is impermeable. Also at river confluences and in floodplains during wet conditions. Suitability increases with proximity to rivers and coast on flat ground.

#### Bare Rock / Scree

**What it looks like:** Exposed rock faces, boulder fields, gravel slopes. No significant vegetation. Grey, brown, or reddish depending on rock type.

**Where it occurs:**
- Very steep slopes (above 35–40°) — cliff faces, quarry-like exposures
- Very high elevations above the vegetation line
- Recent erosion features — landslip scars, active coastal cliffs
- Rocky outcrops where igneous intrusions breach the surface

**Generation rule:** High suitability on very steep slopes regardless of other factors (vegetation can't hold), and on the highest terrain above the vegetation limit. Also forced at cliff faces identified in the coastline generation and at geological intrusion outcrops.

#### Coastal — Beach / Dunes

**What it looks like:** Sand or shingle beaches at the waterline. Behind the beach, sand dunes with marram grass. Gradual transition to grassland or scrub behind the dunes.

**Where it occurs:**
- Gentle coastline (not cliffs) — the soft-rock bays identified in the coastline generation
- Beaches are narrow strips at the water's edge
- Dunes form where prevailing wind blows sand inland from the beach
- Width depends on sand supply (more rivers depositing sediment = wider beaches)

**Generation rule:** Applied to coastline sections classified as gentle/beach in the coastal generation. Width proportional to local sediment supply. Dune zone extends 50–500m inland from the beach, transitioning to grassland.

#### Coastal — Salt Marsh / Tidal Flat

**What it looks like:** Low, flat, muddy areas intersected by tidal channels. Sparse salt-tolerant vegetation (samphire, sea lavender). Exposed mud at low tide.

**Where it occurs:**
- Sheltered estuaries and bays
- River mouths
- Behind barrier beaches or spits
- Where tidal range allows periodic flooding

**Generation rule:** Applied to sheltered coastline sections at river mouths and in enclosed bays, particularly where the coastline was classified as estuary in the coastal generation. Extends from the waterline inland across the floodplain.

#### Scrubland / Rough Ground

**What it looks like:** Dense, low bushes and shrubs — gorse, bramble, hawthorn. Not managed or farmed. Often thorny and impenetrable.

**Where it occurs:**
- Abandoned farmland reverting to wild state
- Transition zones between farmed and wild land
- Steep slopes that aren't forested
- Rocky ground with thin soil in lowlands
- Disturbed land — quarry edges, roadside verges, railway cuttings

**Generation rule:** A "default" cover for land that doesn't strongly suit any other type. Moderate elevation, moderate slope, marginal soil, or locations between settlements and wilderness. Also useful as a filler for awkward terrain.

---

### Generation Pipeline

#### Step 1: Compute Suitability Maps

For each land cover type, compute a suitability value (0.0–1.0) at every cell in the regional map, based on the rules above. Each suitability function reads from the existing terrain, geology, drainage, and settlement data.

```
suitability_forest(cell) = f(elevation, slope, soil_fertility, drainage, distance_to_settlement)
suitability_arable(cell) = f(elevation, slope, soil_fertility, drainage, distance_to_settlement)
suitability_marsh(cell) = f(elevation, slope, impermeability, distance_to_river, flood_risk)
... etc for each type
```

#### Step 2: Assign Dominant Type

At each cell, the land cover type with the highest suitability wins. Apply in priority order for ties:
1. Water (already determined — sea, rivers, lakes)
2. Bare rock (forced by extreme slope or elevation)
3. Bog/marsh (forced by waterlogging)
4. Arable farmland (human preference — if land can be farmed, it will be)
5. Pasture
6. Forest
7. Moorland/heath
8. Scrubland (default fallback)

The priority order reflects human land use pressure — people farm the best land first, then graze what they can't plough, and leave the rest wild. This is a simplification but produces realistic results.

#### Step 3: Smooth and Cluster

Raw cell-by-cell assignment produces a noisy salt-and-pepper pattern. Real land cover occurs in coherent patches — a forest is a continuous area, not a scattering of individual tree cells. Apply spatial smoothing:

1. Run a mode filter (replace each cell with the most common type in its neighborhood, radius 3–5 cells). This eliminates isolated cells and creates coherent patches.
2. Remove patches below a minimum size (e.g., a forest patch smaller than 500m across isn't a meaningful forest at regional scale).
3. Smooth boundaries between types — they should be gradual and organic, not jagged.

#### Step 4: Add Transition Zones

Real land cover doesn't switch abruptly between types. Add transition strips:
- Forest edge → open woodland → scrub → farmland (over 200–500m)
- Farmland → rough pasture → moorland (over 300–800m)
- Dry land → marsh (over 100–300m, following drainage gradient)
- Farmland → settlement outskirts (increasingly fragmented fields, then gardens and orchards)

Generate these by blending adjacent types in a buffer zone along their shared boundary.

#### Step 5: Add Detail Features

Within each land cover zone, add smaller features that break up uniformity:
- **Farmland:** Field boundaries (hedgerows on lowlands, stone walls on uplands), farm tracks, isolated trees, small ponds
- **Forest:** Clearings (natural or logging), streams visible through the canopy, rides (straight firebreak paths)
- **Moorland:** Scattered boulders, exposed rock outcrops, sheep tracks, small tarns (upland pools)
- **Marsh:** Open water pools, meandering channels, slightly raised dry islands
- **Coastal:** Wrack lines, tidal channels, pools

---

### Interaction with Settlement Scoring

Land cover feeds back into settlement logic:
- Settlements surrounded by arable farmland have a strong agricultural economic base — market towns
- Settlements at the forest edge have a timber and charcoal economy
- Settlements near marsh may have fishing, wildfowl, or peat-cutting economies
- Settlements on moorland are typically small — sheep farming, mining, or defensive outposts
- The amount of farmland in a settlement's catchment limits its potential population

---

## Part 2: City-Scale Land Cover

When zooming into a city, land cover transforms from a regional classification into urban landscape features. The key principle: the city was built on top of a pre-existing landscape, and traces of that landscape persist.

### What Gets Inherited from Regional Scale

When the city generator takes over from the regional map, it should know what land cover the city is replacing:

- **City built on farmland** (most common): The pre-existing field pattern can influence street layout — field boundaries often become streets, hedgerows become property lines. Soil is good, so gardens are productive. Flat terrain from agricultural lowland means grid-like street patterns are easy.
- **City built in/near forest:** Parks and green spaces may preserve remnant woodland. Street names reference trees and woods. The city edge transitions through suburban gardens with mature trees into woodland. Building material may include more timber.
- **City built on marshland:** Lower areas flood. The city may be raised on artificial mounds. Canals and drainage channels intersect the street plan (Amsterdam, Venice). Basements are impractical. Parks in low-lying areas may be deliberately designed as flood basins.
- **City on moorland/upland:** Exposed, windy character. Less tree cover in parks and gardens. Stone-built from local material. Compact form to reduce wind exposure.

### Urban Land Cover Types

Within the city itself, land cover takes on urban forms:

#### Parks and Public Gardens

**Placement logic:**
- The city generation plan already places parks by catchment (every 400m). Land cover context refines their character.
- Parks on former farmland: formal, rectangular, lawns and planted beds
- Parks preserving remnant woodland: informal, winding paths, mature trees
- Parks on former marsh or floodplain: may include lakes, ponds, or water features. Often in river valleys within the city
- Hilltop parks: viewpoints, more exposed, less tree cover, possibly with a historic monument

**Size scaling:**
- Neighborhood pocket parks: 0.5–2 hectares, within residential blocks
- District parks: 5–20 hectares, one per district
- City parks: 20–100+ hectares, one or two per city, often on terrain unsuitable for building (steep valley sides, floodplain, former estates)

#### Private Gardens

**Driven by density and era:**
- Dense historic core: minimal gardens. Courtyards in perimeter blocks. Window boxes.
- Georgian/Victorian terraces: long, narrow rear gardens. No front gardens or very small ones in dense areas. Front areas may have railings and a small setback.
- Suburban: front and rear gardens. Larger plots mean more green space per dwelling.
- Rural fringe: large gardens blending into farmland.

**Vegetation in gardens follows regional context:**
- Cities in fertile lowlands: productive gardens, fruit trees, possibly allotments
- Cities on thin upland soil: smaller, less lush gardens. More stone, less green.
- Coastal cities: salt-tolerant planting, wind-shaped trees

#### Street Trees and Urban Planting

**Placement logic:**
- Boulevards and avenues: regular tree planting at 8–12m intervals along wider streets
- Residential streets: trees in front gardens or tree pits, less regular
- Commercial streets: tree planting where pavement width allows, often absent in the historic core (streets too narrow)
- Waterfront promenades: tree-lined where space permits

**Species follows regional context:** Plane trees in warmer climates, linden/lime in northern European contexts, oaks and elms in English towns. This is a visual detail but contributes strongly to the feel of a place.

#### Allotments and Urban Agriculture

**Placement logic:**
- On marginal urban land — alongside railways, on steep slopes, on land awaiting development
- Typically 1–5 hectares, divided into small individual plots (200–300m² each)
- More common in cities with a working-class residential character
- Usually on the city fringe or in transition zones between residential and industrial areas

#### Cemeteries and Churchyards

**Placement logic:**
- Churchyards: attached to churches, placed in Phase 7 of the city generation plan. Small (0.1–0.5 hectares), often the oldest green space in a neighborhood
- Municipal cemeteries: larger (2–20 hectares), placed in the 19th century expansion ring, typically on higher ground (good drainage) at what was then the city edge
- Both function as green spaces with mature trees, and should be included in the park/green space catchment calculation

#### Wasteland and Brownfield

**What it looks like:** Abandoned or derelict land. Rubble, weeds, self-seeded trees. Scrubby, unkempt character.

**Where it occurs:**
- Former industrial sites near water or rail that have lost their original use
- Awkward plots that don't fit the building grammar — very irregular shapes, steep slopes within the urban area, land between infrastructure elements
- Transition zones where different land uses meet uncomfortably (the back of an industrial zone facing a residential area)

**Generation rule:** Assign to plots that the building generator couldn't successfully fill, or to industrial-zoned land at low density. This gives the city a realistic slightly rough texture rather than every plot being perfectly developed.

#### River Corridors and Riparian Zones

**Within the city:**
- Rivers through urban areas have a strip of distinct vegetation along their banks
- In undeveloped sections: willows, alders, reeds, wild bankside vegetation
- In developed sections: formalized embankments, but still with planting where possible
- Floodplain zones within the city should be parks or playing fields (real cities often use floodplains as green space because building there is risky)

**Generation rule:** Define a riparian buffer zone along urban rivers (10–30m either side). Within this zone, override building placement with green space, embankment path, or waterfront promenade depending on the adjacent land use. Dense commercial waterfront gets a promenade. Residential areas get a green buffer. Industrial areas get utilitarian bankside.

#### Urban Woodland / Tree Canopy

**Where it occurs:**
- Steep slopes within the city that were never developed — too difficult to build on, so they retained tree cover
- Railway cuttings and embankments — self-seeded woodland on inaccessible infrastructure margins
- Very large gardens of historic estates that were absorbed into the city
- Gorge or valley sides within the city (if the river runs through a steep-sided valley)

**Generation rule:** On slopes above 20° within the city boundary that weren't developed, apply woodland cover. This creates natural green corridors on valley sides and escarpments that break up the built form and contribute to the city's green network.

---

## Part 3: Land Cover Validation Checks

### Regional Checks

**LC1. Elevation-Cover Correlation (threshold: 0.80)**
Land cover should follow altitudinal zonation. Farmland should be concentrated in lowlands, forest at mid-elevation, moorland at high elevation, bare rock at the highest points. Measure the correlation between cover type and elevation band.

**Score:** Proportion of cells where the land cover type is consistent with its elevation band.

**LC2. Slope-Cover Agreement (threshold: 0.85)**
Arable farmland should not appear on steep slopes (above 8°). Bare rock should not appear on flat ground (below 5°) unless it's a coastal platform. Forest should not appear on cliffs (above 40°).

**Score:** Proportion of cells where slope is within the plausible range for the assigned land cover.

**LC3. Settlement Clearing Radius (threshold: 0.75)**
Land near settlements should show human modification — farmland, pasture, or managed woodland, not dense wild forest or untouched moorland. The clearing radius should scale with settlement size (larger towns clear more land).

**Score:** Proportion of settlements where the surrounding land (within an appropriate radius) is predominantly agricultural or managed, rather than wild.

**LC4. Marsh-Drainage Consistency (threshold: 0.85)**
Marsh and bog should only appear on poorly drained land — flat terrain near rivers, on impermeable geology, in basins. Marsh on well-drained hillsides or on permeable limestone is wrong.

**Score:** Proportion of marsh/bog cells that satisfy drainage conditions (flat + impermeable + low-lying or near water).

**LC5. Patch Coherence (threshold: 0.80)**
Land cover should form coherent patches, not salt-and-pepper noise. Measure the average patch size for each cover type. Below a minimum patch size indicates insufficient spatial smoothing.

**Score:** Proportion of land cover patches above the minimum plausible size for their type (forest patches > 500m across, farmland fields > 100m, etc.).

**LC6. Transition Naturalness (threshold: 0.70)**
Boundaries between land cover types should be gradual, not abrupt. Check that transition zones exist between incompatible neighbors (forest should not directly abut arable without a scrub/woodland edge buffer). Water margins should have riparian vegetation, not bare ground.

**Score:** Proportion of land cover boundaries that include an appropriate transition zone.

### City Checks

**LC7. Green Space Catchment (threshold: 0.80)**
Every residential building should be within 400m of usable green space (park, garden, playing field, urban woodland). This combines with the amenity coverage check (S7) in the city validation spec.

**Score:** Proportion of residential buildings within 400m of green space of at least 0.2 hectares.

**LC8. Waterfront Vegetation (threshold: 0.75)**
Rivers and streams within the city should have a vegetation buffer, even in developed areas. Check that at least 50% of the river frontage has some form of green treatment (trees, planting, grass bank) rather than hard edges directly against buildings.

**Score:** Proportion of urban river frontage with vegetation or green treatment within 15m of the bank.

**LC9. Slope Greening (threshold: 0.80)**
Steep slopes within the city (above 20°) that aren't developed should have vegetation cover (urban woodland, rough scrub), not bare ground. Bare steep slopes within a city indicate incomplete land cover assignment.

**Score:** Proportion of undeveloped steep-slope cells within the city boundary that have vegetation assigned.

**LC10. Garden Provision (threshold: 0.75)**
Residential plots in medium and low density zones should have associated garden space proportional to their density. This check complements Q5 from the city validation spec but focuses on the vegetation content of those gardens.

**Score:** Proportion of residential plots in appropriate density zones that have garden area assigned, weighted by whether the garden area is reasonable for the plot size and density.

---

## Parameter Summary

| Parameter | Effect |
|---|---|
| `climate_temperature` | Shifts elevation bands up/down — warmer climates have higher treeline, higher farming limits |
| `climate_rainfall` | Affects forest density, marsh prevalence, farming viability |
| `farming_intensity` | How aggressively land is converted to agriculture near settlements — higher values mean more farmland, less forest |
| `forest_clearance_radius` | How far from settlements forest is cleared — scales with settlement size |
| `treeline_elevation` | Elevation above which trees don't grow — sets the moorland/forest boundary |
| `marsh_threshold` | How waterlogged land needs to be before it's classified as marsh |
| `coastal_vegetation_width` | How far inland coastal vegetation types extend |
| `urban_green_ratio` | Target proportion of city area as green space — drives park sizing and garden provision |
| `field_size` | Average field dimensions for farmland generation — varies by era and farming style |
| `garden_lushness` | Visual richness of urban gardens — affected by climate and soil fertility |

---

## Integration Points

### With Regional Generation

Land cover is generated after terrain, geology, rivers, coastline, and settlement placement — it reads from all of these. It runs before or alongside regional road routing, because roads through forest have different character from roads through farmland (forest roads are enclosed, sunken; farmland roads are open, often on raised causeways in wet areas).

### With City Generation

When zooming into a city, the regional land cover tells the city generator:
- What the pre-existing landscape was (farmland, forest, marsh) — this influences street patterns and building character
- What the surrounding landscape is — this determines what you see at the city edge and what resources are available
- Where remnant natural features might persist within the city (steep wooded slopes, river corridors, marsh areas too wet to build on)

### With Building Material

Land cover reinforces the geology-driven building material system. Cities surrounded by forest use more timber. Cities on open farmland rely on local stone or brick. Cities near marsh may use reeds for thatching or wattle-and-daub construction.
