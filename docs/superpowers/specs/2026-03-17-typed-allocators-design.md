# Typed Allocators and Incremental Road Growth

## Problem

The current BFS allocator produces blob-shaped zones for all use types. Real cities have distinct spatial patterns: commercial as thin strips along roads, residential as terraced ribbons, industrial as large clusters. The road network is also static after tick 1 — it should grow during development ticks as residential areas expand.

## Solution

Replace the single BFS allocator with typed allocators: **frontage** for commercial, **ribbon** for residential, and keep **BFS blob** for industrial/civic/open space. Add an incremental road growth step to each tick that creates streets from residential ribbon gaps, places cross streets, and closes paths between developing areas.

## Residential Ribbon Allocation

Residential allocation claims strips of cells that create a terraced pattern:

1. **Find a road edge** — scan cells along existing roads (skeleton + streets created in previous ticks) where the residential value bitmap is high
2. **Determine ribbon direction** — follow the road direction, adjusted for terrain contours (existing ribbon orientation logic: on slopes, align perpendicular to slope direction so ribbons follow contours)
3. **Claim a strip** — from the road edge, claim a row of cells perpendicular to the ribbon direction (one plot depth, ~2-4 cells). This is one side of the ribbon.
4. **Skip a gap** — leave a row of cells unclaimed (becomes the next street)
5. **Claim the next strip** — another row of plots backing onto the gap
6. **Repeat** until max ribbon length is reached (archetype-configurable, e.g. 100-200m)

Each ribbon has a start and end point where cross streets will be placed (see Road Growth below).

### Residential sub-type parameters

| Type | Plot depth | Gap width | Max ribbon length | Character |
|------|-----------|-----------|-------------------|-----------|
| residentialFine | 2-3 cells (10-15m) | 1-2 cells (5-10m) | 100-150m | Dense terraces, many per tick |
| residentialEstate | 4-6 cells (20-30m) | 2-3 cells (10-15m) | 150-250m | Planned blocks, fewer per tick |
| residentialQuality | 4-8 cells (20-40m) | 3-4 cells (15-20m) | 80-120m | Loose spacing, larger lots |

### Terrain integration

The existing `layoutRibbons.js` computes ribbon orientation from terrain:
- On slopes (avgSlope > threshold): ribbon direction is perpendicular to slope, so streets follow contours
- On flat terrain: ribbon direction points toward the parent nucleus

This logic should be reused. The new ribbon allocator reads slope data and computes orientation per ribbon segment.

## Commercial Frontage Allocation

Commercial claims cells directly along road edges, not in blobs:

1. **Walk along roads** — find road cells (on roadGrid) where commercial value bitmap exceeds a threshold
2. **Determine road direction** — from local road cell connectivity (which neighbours are also road cells)
3. **Claim frontage cells** — perpendicular to road direction, on one or both sides of the road
4. **Depth from value** — number of cells claimed perpendicular to road scales with local commercial value:
   - High value (central arterial): 3-4 cells deep (15-20m)
   - Medium value: 2 cells (10m)
   - Low value: 1 cell (5m)
5. **Main roads only** — commercial claims along skeleton roads and ribbon streets, not cross streets. Cross streets are identified by being short and perpendicular to a parent road.

Commercial runs before residential in priority order, so it gets first pick of road frontage. Residential ribbons then sprout from remaining road edges.

## Road Growth During Ticks

After allocation, a road growth step runs each tick:

### 1. Ribbon streets

Gaps between residential ribbon strips are marked as road cells on roadGrid. These are a natural byproduct of the ribbon allocation pattern — the allocator leaves gaps, the road step fills them.

### 2. Cross streets

At the start and end of each ribbon, a short perpendicular road is placed. Cross streets extend outward until they:
- Hit an existing road → form a junction
- Get close to another road endpoint (within N cells) → bridge the gap to form a connection
- Reach a max distance (archetype-configurable) → terminate as a dead end

Cross streets are the bookends that cap ribbons, not lines cutting through them.

### 3. Path closing

Scan for pairs of road endpoints or developing areas that are close but unconnected. Lay a connecting road between them. This creates ring roads and shortcuts as the city densifies. Triggers:
- Two road dead-ends within a threshold distance
- Development clusters on opposite sides of a gap
- Ring road formation around busy nuclei (high development density)

### Feedback loop

Roads created during a tick are written to roadGrid. Next tick:
- `roadFrontage` spatial layer is recomputed (if spatial layers are refreshed)
- Commercial value shifts (new roads = new frontage opportunities)
- Residential can sprout new ribbons from the new streets
- The city grows organically as roads and development co-evolve

## Other Allocators (Unchanged)

These keep using the existing BFS allocator from value bitmaps:

- **Industrial** — BFS blob, large contiguous clusters at high industrial value
- **Civic** — BFS blob, smaller footprints at high civic value
- **Open space** — BFS blob, terrain-following at high open space value
- **Agriculture** — frontier fill beyond development proximity

## Archetype Configuration

Each residential type gets ribbon parameters in addition to the existing value/agent config:

```js
agents: {
  residentialFine: {
    share: 0.30, budgetPerTick: 0.06,
    allocator: 'ribbon',
    plotDepth: 3,        // cells perpendicular to road
    gapWidth: 1,         // cells between strips (becomes street)
    maxRibbonLength: 30, // cells along road before cross street
    seedCount: 12, noise: 0.2,
  },
  residentialEstate: {
    share: 0.10, budgetPerTick: 0.03,
    allocator: 'ribbon',
    plotDepth: 5,
    gapWidth: 2,
    maxRibbonLength: 40,
    seedCount: 3, noise: 0.1,
  },
  residentialQuality: {
    share: 0.12, budgetPerTick: 0.03,
    allocator: 'ribbon',
    plotDepth: 6,
    gapWidth: 3,
    maxRibbonLength: 20,
    seedCount: 5, noise: 0.15,
  },
  commercial: {
    share: 0.12, budgetPerTick: 0.03,
    allocator: 'frontage',
    maxDepth: 4,         // max cells perpendicular to road
    valueThreshold: 0.3, // min commercial value to claim
    seedCount: 8, noise: 0.1,
  },
  industrial: {
    share: 0.08, budgetPerTick: 0.02,
    allocator: 'blob',   // existing BFS
    minFootprint: 50, seedCount: 2, minSpacing: 80, noise: 0.1,
  },
  // civic, openSpace, agriculture — same as current
}
```

Road growth parameters:

```js
roadGrowth: {
  maxCrossStreetLength: 40, // cells before dead-ending
  pathClosingDistance: 30,   // max gap to bridge between endpoints
  ringRoadThreshold: 0.8,   // development density to trigger ring road
}
```

## Files

| File | Role |
|------|------|
| `src/city/pipeline/allocateRibbon.js` (new) | Ribbon allocation for residential |
| `src/city/pipeline/allocateFrontage.js` (new) | Frontage allocation for commercial |
| `src/city/pipeline/allocate.js` (keep) | BFS blob allocation for industrial/civic/openSpace |
| `src/city/pipeline/growRoads.js` (new) | Cross streets, gap filling, path closing |
| `src/city/pipeline/growthTick.js` (modify) | Dispatch to correct allocator per agent, add road growth step |
| `src/city/archetypes.js` (modify) | Add allocator type and ribbon/frontage params per agent |
| `src/city/pipeline/layoutRibbons.js` (reference) | Reuse terrain orientation logic |

## Tick Loop

```
1. INFLUENCE — compute influence layers
2. VALUE    — compose per-use value bitmaps
3. ALLOCATE — per agent in priority order:
     civic:              blob from civicValue
     commercial:         frontage along roads from commercialValue
     industrial:         blob from industrialValue
     openSpace:          blob from openSpaceValue
     residentialQuality: ribbon from resQualityValue
     residentialFine:    ribbon from resFineValue
     residentialEstate:  ribbon from resEstateValue
     agriculture:        frontier fill
4. ROADS    — mark ribbon gaps as streets, place cross streets, close paths
```
