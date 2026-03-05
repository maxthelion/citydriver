# Generation Pipeline

## Regional Pipeline (`src/regional/pipeline.js`)

| # | Phase | File | Output |
|---|-------|------|--------|
| A1 | Geology | `generateGeology.js` | rockType, erosionResistance, permeability, soilFertility, springLine grids |
| A2 | Terrain | `generateTerrain.js` | elevation, slope grids (rock-driven noise + edge falloff) |
| A4 | Coastline | `generateCoastline.js` | Differential erosion (bays/headlands), bathymetry, coastlineFeatures |
| A3 | Hydrology | `generateHydrology.js` | rivers, confluences, waterMask, flow accumulation |
| A6 | Settlements | `generateSettlements.js` | Tiered settlements (scored by river/coast/flat/fertility) |
| A5 | Land Cover | `generateLandCover.js` | landCover grid (water/farmland/forest/moorland/marsh/etc) |
| A7 | Roads | `generateRoads.js` | roads array (A* between settlements, arterial/collector hierarchy, rawPath + simplified path) |

## City Pipeline (`src/city/pipeline.js`)

| # | Phase | File | Output |
|---|-------|------|--------|
| B1a | Extract Context | `extractCityContext.js` | Crop regional layers to city bounds |
| B1b | Refine Terrain | `refineTerrain.js` | High-freq noise detail on heightmap |
| B2 | Anchor Routes | `generateAnchorRoutes.js` | PlanarGraph: regional roads re-pathfound at city resolution within corridor, + waterfront structural road |
| B3 | Density Field | `generateDensityField.js` | density grid (0-1) |
| B4 | Arterials | `generateArterials.js` | Wide main roads, bridges |
| — | Feedback A | — | Recompute density after arterials |
| B5 | Districts | `generateDistricts.js` | districts grid (commercial/residential/suburban/industrial/parkland) |
| B6 | Collectors | `generateCollectors.js` | Medium roads subdividing districts |
| B7 | Local Streets | `generateStreets.js` | Block subdivision into local streets |
| B8 | Loop Closure | `closeLoops.js` | Eliminate dead ends, connect components |
| — | Feedback D | — | Rezone high-centrality streets to commercial |
| B9 | Plots | `generatePlots.js` | Building lots along road frontage |
| B10 | Buildings | `generateBuildings.js` | Building array (footprint, height, material, type) |
| — | Feedback B | — | Flag low-coverage plots as open space |
| B11 | Amenities | `generateAmenities.js` | Schools, parks, commercial frontages |
| B12 | Urban Land Cover | `generateLandCover.js` | Urban cover grid (garden/park/woodland/paved) |

Road hierarchy builds up: anchor → arterials → collectors → local streets → loop closure.
Everything after (plots, buildings, amenities) builds on completed road network.
