# City Archetypes

## The Key Insight

The generator already handles residential fabric well. What's missing is a **land reservation system** that runs before the house-placement algorithm and ring-fences areas for other uses. The archetypes are essentially different recipes for how to carve up the city area before residential infill runs.

The reservation system works as a set of zones defined relative to existing structure:
- Distance from city centre (rings)
- Proximity to geographical features (waterfront, river, ridge)
- Proximity to infrastructure (main roads, the skeleton connections)
- Relative position within the city (which quadrant, which approach corridor)

Each archetype is a different set of rules for how these zones get allocated.

---

## Parameters Each Archetype Needs

A consistent parameter set that all archetypes use:

```
CityArchetype {

  -- Land budget (proportions of total city area)
  residentialShare:    Float    -- remainder after everything else
  commercialShare:     Float    -- shops, offices, mixed use streets
  industrialShare:     Float    -- warehousing, manufacturing, yards
  civicShare:          Float    -- town hall, church, school, hospital
  openSpaceShare:      Float    -- parks, squares, cemeteries
  infrastructureShare: Float    -- roads, railways, stations

  -- Commercial street rules
  commercialSpine:     SpineType   -- grid, radial, linear, ring
  commercialLocation:  ZoneRule    -- centre, waterfront, main approach

  -- Open space rules
  primaryPark:         ParkType    -- civic, linear, square, none
  parkLocation:        ZoneRule    -- central, edge, waterfront
  squaresCount:        Int         -- number of civic squares/plazas

  -- Industrial rules
  industrialLocation:  ZoneRule    -- downwind, railside, waterfront, edge

  -- Density profile
  centreMaxDensity:    Float
  edgeDensity:         Float
  densityFalloff:      CurveType   -- steep, gradual, stepped

  -- Block character
  typicalBlockDepth:   Float       -- determines plot depth distribution
  plotGrain:           GrainType   -- fine/medium/coarse

}
```

---

## Five Archetypes

### 1. The Organic Market Town

The baseline European historic town. Grew incrementally from a market or river crossing, no strong planning intention, medieval or early modern founding. Default archetype for small to medium inland settlements.

```
residentialShare:    0.55
commercialShare:     0.12
industrialShare:     0.08
civicShare:          0.05
openSpaceShare:      0.08
infrastructureShare: 0.12

commercialSpine:     radial          -- commercial streets follow approach roads
commercialLocation:  centreAndSpines -- high street along main approach corridors
primaryPark:         square          -- market square at centre, irregular shape
parkLocation:        central
squaresCount:        1-2             -- market square + possible church square
industrialLocation:  downwindEdge    -- tanneries, mills pushed to fringe

centreMaxDensity:    high
edgeDensity:         low
densityFalloff:      gradual

typicalBlockDepth:   medium-shallow  -- burgage plot logic
plotGrain:           fine            -- narrow frontages
```

Character notes: the commercial streets follow the existing skeleton connections because those were originally the approach roads into town. Ring-fence a central irregular polygon as the market square before residential runs. Reserve the downwind edge for a small industrial zone. Everything else is residential infill with fine grain.

---

### 2. The Port and Waterfront City

Organised perpendicular to the water. The waterfront is the primary value axis and commercial spine. Industrial and storage uses cluster at the water's edge; residential rises behind on higher ground.

```
residentialShare:    0.48
commercialShare:     0.15
industrialShare:     0.14
civicShare:          0.05
openSpaceShare:      0.06
infrastructureShare: 0.12

commercialSpine:     linear          -- parallel to waterfront
commercialLocation:  waterfront      -- first 2-3 blocks from water
primaryPark:         linear          -- embankment or waterfront promenade
parkLocation:        waterfront      -- between commercial and water edge
squaresCount:        1               -- customs house square or harbour square
industrialLocation:  waterfrontFlank -- warehouses and yards at harbour edges

centreMaxDensity:    high            -- dense near water
edgeDensity:         low
densityFalloff:      steep           -- sharp gradient away from waterfront

typicalBlockDepth:   deep            -- warehouse plots run back from quay
plotGrain:           mixed           -- fine grain commercial, coarser industrial
```

Character notes: the waterfront strip should be reserved before anything else runs. The main commercial street runs parallel to the water one block back. Density falls away steeply as you climb from the water. The industrial zone flanks the harbour rather than sitting behind the commercial core.

---

### 3. The Planned Grid Town

American or colonial foundation. Strong geometric intention from the start, survey grid imposed on terrain, railway typically present from early in the city's history. Clear separation of uses into distinct zones.

```
residentialShare:    0.52
commercialShare:     0.14
industrialShare:     0.12
civicShare:          0.06
openSpaceShare:      0.08
infrastructureShare: 0.08

commercialSpine:     grid            -- main street + cross street
commercialLocation:  centralGrid     -- 2-3 blocks either side of main intersection
primaryPark:         civic           -- formal square or plaza at grid centre
parkLocation:        central
squaresCount:        1               -- central plaza, formally defined
industrialLocation:  railsideEdge    -- tracks define industrial zone boundary

centreMaxDensity:    medium-high
edgeDensity:         low
densityFalloff:      stepped         -- clear zone transitions

typicalBlockDepth:   regular         -- consistent block dimensions
plotGrain:           medium          -- wider lots than organic town
```

Character notes: skeleton connections become the main grid streets. The central intersection is the commercial and civic heart. The railway (if present) defines a hard edge to the industrial zone — reserve the railside strip before residential runs. The grid imposes regularity but the topology-aware algorithm can still vary it at edges where terrain intervenes.

---

### 4. The Industrial Town

Founded for or massively transformed by a single industry — mill town, mining town, manufacturing centre. The industrial use is the spatial generator; residential fabric exists to house the workforce and clusters around the works.

```
residentialShare:    0.50
commercialShare:     0.08
industrialShare:     0.22
civicShare:          0.04
openSpaceShare:      0.05
infrastructureShare: 0.11

commercialSpine:     linear          -- one main commercial street
commercialLocation:  worksApproach   -- between works gate and residential centre
primaryPark:         none/minimal    -- working class town, limited open space
parkLocation:        edge
squaresCount:        0-1
industrialLocation:  dominant        -- large central or waterside zone,
                                        not pushed to edge

centreMaxDensity:    very high       -- dense worker terraces
edgeDensity:         medium          -- housing extends far from centre
densityFalloff:      gradual         -- uniform density, less centre peak

typicalBlockDepth:   shallow         -- terrace logic, back-to-back possible
plotGrain:           fine-uniform    -- repetitive worker housing plots
```

Character notes: reserve a large industrial zone first — this is the primary use, not a residual. The residential fabric is organised around access to the works rather than around a commercial centre. Density is unusually uniform because housing was built at scale by a single developer. The commercial street is thin — this town serves workers, not merchants.

---

### 5. The Civic and Administrative Centre

Regional capital, cathedral city, or university town. Dominated by institutional land use. Large permanent plots resist development pressure. High-quality residential around the institutional core, commercial secondary.

```
residentialShare:    0.42
commercialShare:     0.10
industrialShare:     0.04
civicShare:          0.18          -- unusually high
openSpaceShare:      0.14          -- parks, closes, college grounds
infrastructureShare: 0.12

commercialSpine:     radial         -- approach roads have retail
commercialLocation:  centreRing     -- ring around civic core, not in it
primaryPark:         multiple       -- college grounds, cathedral close,
                                       civic park
parkLocation:        distributed    -- institutional plots scattered through city
squaresCount:        2-3            -- cathedral square, civic square,
                                       college quad
industrialLocation:  distant edge   -- minimal industrial, pushed far out

centreMaxDensity:    medium         -- institutions occupy centre, not dense housing
edgeDensity:         low
densityFalloff:      gradual

typicalBlockDepth:   varied         -- large institutional blocks mixed with
                                       fine residential grain
plotGrain:           mixed          -- coarse institutional, fine residential
```

Character notes: reserve the institutional plots first as large irregular polygons near the geographic centre — these are the permanent anchors. The commercial ring forms around them rather than at the centre. The open space budget is high because institutional land (college grounds, cathedral close, bishops' palace gardens) reads as open space even when privately owned.

---

## How to Use These

Each archetype runs a **reservation pass** before the existing residential algorithm:

```
generateCity(location, archetype):

  1. reserveInfrastructure(skeleton, archetype.infrastructureShare)
  2. reserveIndustrial(archetype.industrialLocation, archetype.industrialShare)
  3. reserveCivic(archetype.civicShare)         -- place landmark anchors
  4. reserveOpenSpace(archetype.parkLocation, archetype.openSpaceShare)
  5. reserveCommercial(archetype.commercialSpine, archetype.commercialShare)

  6. runResidentialInfill(remainder, archetype.densityProfile, archetype.plotGrain)
```

The reservations are the missing piece. Once the reserved zones exist, the current algorithm fills the remainder with residential fabric and most of what already exists still works. The archetypes just tell the reservation pass where to put things and how much to reserve.

Archetypes can be blended with a weight — a port town that's also an administrative centre (Bristol, say) is 60% port archetype and 40% civic archetype, with the reservations from both running before infill.

---

## Implementation Notes

### Pipeline architecture

Each pipeline step is a function `(map, params?) -> map` (mutates in place,
returns same reference for chaining). The full city pipeline:

```
cityMap = extractCityMap(regionMap, settlement)
cityMap = buildSkeletonRoads(cityMap)
cityMap = computeLandValue(cityMap)
cityMap = extractDevelopmentZones(cityMap)
cityMap = reserveLandUse(cityMap, archetype)
cityMap = layoutRibbons(cityMap)
cityMap = connectToNetwork(cityMap)
cityMap = placeBuildings(cityMap)
```

### reserveLandUse determines where layoutRibbons applies

`layoutRibbons` is strictly for residential and mixed-use fabric. It must
only operate on areas that `reserveLandUse` has left unreserved. The flow:

1. `extractDevelopmentZones` finds all buildable land
2. `reserveLandUse` carves out industrial, civic, open space, and commercial
   zones — these become first-class zone objects with a usage type
3. `layoutRibbons` operates only on the unreserved remainder

Reserved zones are kept as typed objects (not just subtracted from the cell
set) so they can be rendered, inspected, and eventually filled with
appropriate content (warehouses, parks, civic buildings).

### Adapting spec parameters to existing code

- **commercialSpine** — the skeleton already determines road topology. Rather than redesigning roads, the archetype should choose *which existing skeleton roads* become commercial.
- **densityFalloff** — the existing land value formula uses `1/(1 + dist/200)`. The archetype can tune the `200m` denominator.
- **plotGrain** — maps directly to the existing (but unwired) plot config table in `technical-reference.md` (8-16m frontages by nucleus type).

The reservation pass slots between zone extraction (tick 3) and ribbon layout (tick 4) in the current pipeline. The existing nucleus type classification (`waterfront`, `market`, `hilltop`, `valley`, `roadside`, `suburban`) could inform archetype selection per settlement.
