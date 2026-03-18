# Bitmap-Driven Reservation Model

## Problem

The current growth agent system scores cells on the fly during BFS spread using inline weighted sums of spatial layers. This is:
- Not debuggable — you can't see where an agent thinks land is valuable until it claims it
- Not composable — influence between zone types is hardcoded (industrialDistance) rather than generalised
- Not GPU-ready — per-cell scoring during BFS can't be parallelised

## Solution

Replace on-the-fly scoring with precomputed per-use **value bitmaps** and generalised **influence layers**. Every zone type both reads from and writes back to the bitmap landscape. The value bitmap is the suitability surface; allocation reads from it.

## Tick Loop

Each growth tick has three phases:

```
1. INFLUENCE — blur each zone type's current claims into influence layers
2. VALUE    — compose per-use value bitmaps from spatial + influence layers
3. ALLOCATE — agents claim cells from their value bitmap in priority order
```

Next tick, the influence layers reflect what was placed, changing the value landscape. Port docks placed in tick 5 depress residential value in tick 6.

## Influence Layers

After allocation, blur each zone type's claims to produce influence bitmaps:

| Influence Layer | Source Cells | Blur Radius | Effect |
|----------------|-------------|-------------|--------|
| `portProximity` | port | ~400m | Depresses residential, attracts commercial |
| `industrialProximity` | industrial | ~300m | Depresses residential, attracts worker housing at distance |
| `civicProximity` | civic | ~200m | Boosts residential and commercial |
| `parkProximity` | open space | ~200m | Boosts residential |
| `residentialProximity` | all residential | ~200m | Ports/industrial avoid |
| `developmentProximity` | all non-agriculture | ~radiusStep | Frontier eligibility |

Each is a standard bitmap operation: binary mask → box blur → normalise to 0-1.

Blur radii are archetype-configurable via `influenceRadii`.

## Value Bitmap Composition

Each zone type's value is a weighted sum of spatial layers + influence layers. The weights are defined per archetype in `valueComposition`:

```
commercialValue[x,z] = 0.6 * centrality[x,z]
                     + 2.0 * roadFrontage[x,z]
                     + 0.5 * developmentProximity[x,z]
                     + 0.3 * civicProximity[x,z]
                     - 0.5 * industrialProximity[x,z]

portValue[x,z]       = 1.5 * waterfrontness[x,z]
                     + 0.4 * roadFrontage[x,z]
                     + 0.3 * developmentProximity[x,z]
                     - 1.0 * residentialProximity[x,z]

residentialFineValue[x,z] = 0.5 * centrality[x,z]
                          + 0.3 * roadFrontage[x,z]
                          + 0.8 * developmentProximity[x,z]
                          - 1.2 * portProximity[x,z]
                          - 0.8 * industrialProximity[x,z]
                          + 0.4 * parkProximity[x,z]
                          + 0.3 * civicProximity[x,z]

residentialQualityValue[x,z] = 0.4 * waterfrontness[x,z]
                             + 0.4 * elevation[x,z]
                             - 1.5 * portProximity[x,z]
                             - 1.0 * industrialProximity[x,z]
                             + 0.6 * parkProximity[x,z]
```

The composition is a single pass over the grid per zone type — multiply-accumulate N layers. Trivially parallelisable on GPU.

The value bitmaps are stored as named layers on the map, viewable in the debug screen and bitmap logger.

## Allocation

Each agent reads its precomputed value bitmap:

1. Filter eligible cells: in a development zone, unreserved, `developmentProximity > threshold`
2. Sort eligible cells by value (descending)
3. Claim top cells up to per-tick budget and cumulative cap
4. Claimed cells must be contiguous with existing same-type claims or form a new cluster of at least `minFootprint` cells

Agents run in priority order. Higher-priority agents claim first; their cells are removed from eligibility for subsequent agents.

This is the simple allocation model. A richer per-type allocation model (ribbons, typed civic plots, polygon estates) is described in the [[land-allocation-model]] wiki page and is a separate piece of work.

## Archetype Configuration

```js
marketTown: {
  growth: {
    radiusStep: 800,
    maxGrowthTicks: 20,
    agentPriority: ['port', 'civic', 'commercial', 'industrial', 'openSpace',
                    'residentialQuality', 'residentialFine', 'residentialEstate',
                    'agriculture'],
    valueComposition: {
      commercial:        { centrality: 0.6, roadFrontage: 2.0, developmentProximity: 0.5,
                           civicProximity: 0.3, industrialProximity: -0.5 },
      port:              { waterfrontness: 1.5, roadFrontage: 0.4, developmentProximity: 0.3,
                           residentialProximity: -1.0 },
      industrial:        { edgeness: 0.5, downwindness: 0.6, developmentProximity: 0.3,
                           terrainSuitability: 0.8 },
      civic:             { centrality: 0.7, roadFrontage: 0.3, developmentProximity: 0.5 },
      openSpace:         { waterfrontness: 0.3, edgeness: 0.4, developmentProximity: 0.3 },
      residentialFine:   { centrality: 0.5, roadFrontage: 0.3, developmentProximity: 0.8,
                           portProximity: -1.2, industrialProximity: -0.8, parkProximity: 0.4 },
      residentialEstate: { edgeness: 0.5, developmentProximity: 0.3,
                           industrialProximity: -0.3 },
      residentialQuality:{ waterfrontness: 0.4, elevation: 0.4, portProximity: -1.5,
                           industrialProximity: -1.0, parkProximity: 0.6 },
    },
    influenceRadii: {
      port: 80,              // cells (~400m at 5m)
      industrial: 60,        // ~300m
      civic: 40,             // ~200m
      openSpace: 40,         // ~200m
      residential: 40,       // ~200m (all residential combined)
    },
    agents: {
      commercial:        { share: 0.12, budgetPerTick: 0.03, minFootprint: 20 },
      port:              { share: 0.06, budgetPerTick: 0.02, minFootprint: 100 },
      industrial:        { share: 0.08, budgetPerTick: 0.02, minFootprint: 100 },
      civic:             { share: 0.05, budgetPerTick: 0.01, minFootprint: 50 },
      openSpace:         { share: 0.08, budgetPerTick: 0.02, minFootprint: 50 },
      residentialFine:   { share: 0.30, budgetPerTick: 0.06, minFootprint: 10 },
      residentialEstate: { share: 0.10, budgetPerTick: 0.03, minFootprint: 80 },
      residentialQuality:{ share: 0.12, budgetPerTick: 0.03, minFootprint: 30 },
      agriculture:       { share: 0.15 },
    },
  }
}
```

`valueComposition` defines where things want to be. `agents` defines how much gets placed per tick. `influenceRadii` defines how far each zone type's influence spreads.

## Integration with Existing Pipeline

```
0: setupCity
1: buildSkeletonRoads
2: computeLandValue
3: extractZones
4: computeSpatialLayers (centrality, waterfrontness, edgeness, roadFrontage, downwindness)
5..N: growth ticks (influence → value → allocate)
N+1: layoutRibbons
N+2: connectToNetwork
```

Ticks 0-4 unchanged. The growth ticks replace the current `reserveLandUse` (v5 main) or the BFS-based growth agents (incremental-zoning branch).

### What stays
- `computeSpatialLayers` (tick 4) — produces base spatial layers
- `extractZones` (tick 3) — produces development zones for eligibility
- `buildSkeletonRoads` (tick 1) — produces road network
- `BitmapLogger` — logs all value and influence layers each tick

### What changes
- `growthTick.js` — rewritten: influence → value → allocate loop
- `growthAgents.js` — simplified to allocation only (sort-and-claim from value bitmap)
- `archetypes.js` — `valueComposition` and `influenceRadii` replace `affinity` and inline scoring

### What's new
- `valueLayers.js` — composes value bitmaps from weighted sum of layers
- `influenceLayers.js` — blurs zone claims into influence bitmaps

## Reservation Types

Same as current incremental-zoning branch, plus port:

| Value | Type |
|-------|------|
| 0 | unreserved |
| 1 | commercial |
| 2 | industrial |
| 3 | civic |
| 4 | open space |
| 5 | agriculture |
| 6 | residential fine |
| 7 | residential estate |
| 8 | residential quality |
| 9 | port |

## Debugging

Every intermediate bitmap is viewable:
- Per-use value layers (`commercialValue`, `portValue`, etc.) — see where each agent thinks land is valuable
- Influence layers (`portProximity`, `industrialProximity`, etc.) — see how placed zones affect the landscape
- Reservation grid — see what's been claimed

The bitmap logger captures all of these per tick, producing a complete trace of how the city's value landscape evolved.

## Future

- **Typed allocators** — ribbon streets, polygon estates, typed civic plots (see [[land-allocation-model]])
- **GPU acceleration** — value composition and influence blurs are embarrassingly parallel
- **Per-archetype influence radii** — port city's docks spread influence further than market town's
