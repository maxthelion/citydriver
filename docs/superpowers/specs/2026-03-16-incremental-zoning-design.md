# Incremental Zoning with Per-Use Growth Agents

## Problem

The current `reserveLandUse` system allocates zoning in a single pass, producing large monolithic blobs of contiguous use. This doesn't look like how real cities develop — real zoning emerges incrementally through many small decisions, with different use types spreading in different ways (commercial creeping along roads, industrial clustering at waterfront, civic scattered as discrete plots).

## Solution

Replace the single-pass reservation with a **multi-tick growth agent system**. Each use type is a growth agent with its own spatial behaviour. On each tick, a development radius expands around every nucleus, and all agents run within the newly eligible area, competing for cells.

## Growth Tick Model

Each tick expands a **development radius** around every nucleus simultaneously. The radius grows by a configurable increment per tick (archetype-dependent, e.g. 200m for organic towns, 400m for planned/industrial).

- Tick 0 remains `setupCity`
- Ticks 1-4 unchanged (skeleton roads, land value, zones, spatial layers)
- Ticks 5..N are growth agent ticks (replaces `reserveLandUse`)
- After all growth ticks: layoutRibbons, connectToNetwork

Each nucleus tracks its own radius. Where radii overlap, nuclei compete — the highest-scoring claim wins.

## Growth Agents

Each use type is a growth agent with distinct spatial behaviour:

| Agent | Seed Strategy | Spread Behaviour | Typical Footprint | Description |
|-------|--------------|-----------------|-------------------|-------------|
| **commercial** | Along high-value road frontages | Linear creep along roads, multiple seeds | Small-medium | Shop rows, market streets |
| **industrial** | Waterfront, downwind, near arterials | Contiguous blob growth, few large seeds | Large | Warehouse districts, factory yards |
| **civic** | Near centre, scattered | Isolated dots/small clusters, no spread pressure | Small discrete | Church, town hall, school |
| **openSpace** | Near water, hilltops, edges | Mixed — linear (promenades) or blobs (parks) | Medium-large | Parks, squares, cemeteries |
| **agriculture** | Ring beyond development frontier | Belt around settlement edge | Large belt | Market gardens, consumed by later ticks |
| **residentialFine** | Behind commercial frontages, near centre | Organic fill, many seeds | Small | Individual plots, terraces |
| **residentialEstate** | Edge of development, near industrial | Large planned blocks | Medium-large | Planned estates, workers' housing |
| **residentialQuality** | Waterfront away from docks, hilltops | Clusters in desirable locations | Medium | Villas, good terraces |

## Agent Execution per Tick

On each tick, for each nucleus:

1. **Expand radius** — new ring of eligible cells becomes available
2. **Agriculture retreats** — agricultural cells within the new radius are marked as convertible
3. **Agents run in priority order** (archetype-defined):
   - Agent scores eligible cells using its terrain affinity + spatial layers
   - Agent places new seeds if scoring thresholds are met
   - Existing clusters grow outward by claiming adjacent eligible cells, up to a per-tick budget
   - Claimed cells are removed from the eligible pool
4. **Agriculture fills** — unclaimed cells beyond the frontier get marked as agriculture
5. **Residential fills** — remaining unclaimed cells within the radius go through residential agent placement (fine/estate/quality based on surroundings)

### Key rules

- Agents cannot overwrite each other's claims (first-come in priority order)
- Nuclei compete — if two nuclei's radii overlap, their agents interleave (highest-scoring claim wins)
- Each agent's `share` is a **hard cumulative cap** — fraction of total zone cells (same meaning as current archetype shares). Once an agent has claimed `share × totalZoneCells` cells across all ticks, it stops seeding and stops growing existing clusters. Shares need not sum to 1.0 — unclaimed cells remain unreserved.
- Seeds persist across ticks — a commercial strip started in tick 2 keeps growing in tick 3
- When an agent hits its cap, partially-grown clusters are kept as-is (realistic irregular edges)
- If all eligible cells within a nucleus's radius are claimed, that nucleus is skipped for the tick
- Agents that depend on other agents' claims (e.g. `residentialQuality` avoids industrial) must run after them in priority order — this is a hard ordering constraint, not just a preference

### Termination

Growth ticks stop when **all nuclei's radii have exceeded the map bounds** or **all zone cells have been claimed**. The archetype can also specify a `maxGrowthTicks` cap (default 8). `LandFirstDevelopment.tick()` returns `false` when the termination condition is met, then proceeds to layoutRibbons.

### First tick bootstrap

On the first growth tick (tick 5), there is no existing agriculture to retreat. Agriculture agent runs in step 4 (fill beyond frontier) to establish the initial agricultural belt. From tick 6 onward, step 2 (agriculture retreat) converts agricultural cells within the newly expanded radius to eligible.

## Archetype Configuration

Each archetype defines its agents as a list with parameters:

```js
marketTown: {
  radiusStep: 200,        // metres per tick
  agentPriority: ['civic', 'commercial', 'industrial', 'openSpace',
                  'residentialQuality', 'residentialFine', 'residentialEstate',
                  'agriculture'],
  agents: {
    commercial: {
      share: 0.12,                          // cumulative cap
      seedStrategy: 'roadFrontage',         // where new seeds appear
      spreadBehaviour: 'linear',            // how clusters grow
      footprint: [4, 20],                   // min/max cluster size in cells
      affinity: { centrality: 0.6, roadFrontage: 0.8 },
      seedsPerTick: 3,
    },
    industrial: {
      share: 0.08,
      seedStrategy: 'edge',
      spreadBehaviour: 'blob',
      footprint: [30, 100],
      affinity: { downwindness: 0.6, edgeness: 0.5 },
      seedsPerTick: 1,
    },
    civic: {
      share: 0.05,
      seedStrategy: 'scattered',
      spreadBehaviour: 'dot',
      footprint: [3, 10],
      affinity: { centrality: 0.7, roadFrontage: 0.3 },
      seedsPerTick: 2,
    },
    openSpace: {
      share: 0.08,
      seedStrategy: 'terrain',
      spreadBehaviour: 'blob',
      footprint: [10, 50],
      affinity: { waterfrontness: 0.3, edgeness: 0.4 },
      seedsPerTick: 1,
    },
    agriculture: {
      share: 0.15,
      seedStrategy: 'frontier',
      spreadBehaviour: 'belt',
      footprint: [50, 200],
      affinity: { edgeness: 1.0 },
      seedsPerTick: 0,                     // fills automatically beyond frontier
    },
    residentialFine: {
      share: 0.30,
      seedStrategy: 'fill',
      spreadBehaviour: 'organic',
      footprint: [2, 15],
      affinity: { centrality: 0.5, roadFrontage: 0.3 },
      seedsPerTick: 5,
    },
    residentialEstate: {
      share: 0.10,
      seedStrategy: 'edge',
      spreadBehaviour: 'blob',
      footprint: [20, 80],
      affinity: { edgeness: 0.7 },
      seedsPerTick: 1,
    },
    residentialQuality: {
      share: 0.12,
      seedStrategy: 'desirable',
      spreadBehaviour: 'cluster',
      footprint: [8, 40],
      affinity: { waterfrontness: 0.4, centrality: -0.2, edgeness: 0.3 },
      seedsPerTick: 2,
    },
  }
}
```

For an **industrial town**, `industrial` would be first in priority with share 0.22, `seedStrategy: 'arterial'`, footprint [80, 300], and seedsPerTick 1 (one massive early allocation). `residentialEstate` would have higher share (workers' housing near works).

For a **port city**, `industrial` would have `affinity: { waterfrontness: 0.9 }` for docks/warehouses. Commercial seeds parallel to the waterfront. `residentialQuality` would target waterfront away from docks.

For a **civic centre**, `civic` share rises to 0.18 with larger footprints (institutional compounds). Multiple open space agents. Minimal industrial.

## Integration with Bitmap Pipeline

The agents **consume existing spatial layers as inputs** — no duplication:

| Existing Layer | Computed By | Used By Agents |
|---|---|---|
| centrality | computeSpatialLayers (tick 4) | civic, commercial, residentialFine |
| waterfrontness | computeSpatialLayers (tick 4) | industrial (port), residentialQuality, openSpace |
| edgeness | computeSpatialLayers (tick 4) | industrial, residentialEstate, agriculture |
| roadFrontage | computeSpatialLayers (tick 4) | commercial, residentialFine |
| downwindness | computeSpatialLayers (tick 4) | industrial |
| buildability | setupCity (tick 0) | all agents (hard constraint) |
| landValue | computeLandValue (tick 2) | residentialQuality, commercial |

### What changes

- `reserveLandUse` (tick 5) is **replaced** by the growth agent system running as multiple ticks
- `extractZones` (tick 3) still produces development zones — agents use zone cells as the overall eligibility mask (a cell must be in a development zone AND within a nucleus's radius to be eligible). Zone-to-nucleus ownership is ignored for growth — any nucleus whose radius covers the cell can claim it
- `computeSpatialLayers` (tick 4) runs once to produce layers agents read from
- Ticks 1-4 unchanged

### What agents write

- The same `reservationGrid` (Grid2D, uint8) — same format, populated incrementally
- Expanded reservation types: commercial (1), industrial (2), civic (3), openSpace (4), agriculture (5), residentialFine (6), residentialEstate (7), residentialQuality (8)
- `reservationZones` array — accumulated across ticks
- Per-nucleus `currentRadius` tracking
- Growth state persisted on the map between ticks:

```js
map.growthState = {
  nucleusRadii: Map<nucleusIdx, number>,     // current radius per nucleus
  activeSeeds: Map<agentType, Array<{gx, gz, nucleusIdx}>>,  // seeds that persist across ticks
  claimedCounts: Map<agentType, number>,     // cells claimed so far (for cap enforcement)
  tick: number,                               // current growth tick index
}
```

### layoutRibbons integration

`layoutRibbons` (N+1) runs after all growth ticks. It should operate on cells reserved as any residential type (6, 7, 8) and unreserved cells (0) within development zones. Industrial (2), civic (3), and agriculture (5) zones are skipped — they don't get internal street networks. Commercial (1) and openSpace (4) may get streets depending on size.

### Pipeline shape

```
0: setupCity
1: buildSkeletonRoads
2: computeLandValue
3: extractZones
4: computeSpatialLayers
5..N: growth agent ticks (replaces reserveLandUse)
N+1: layoutRibbons
N+2: connectToNetwork
```

## Seed Strategies

How each strategy finds locations for new seeds:

- **roadFrontage**: Eligible cells where `roadGrid > 0` within 2 cells AND within the new ring. Score by affinity. Pick top N seeds with minimum spacing of `footprint[0]` cells apart.
- **edge**: Eligible cells in the outer 30% of the current development radius. Score by affinity. Pick top N.
- **scattered**: All eligible cells within radius, scored by affinity, pick top N with minimum spacing of `3 × footprint[1]` cells apart (ensures spread).
- **terrain**: Eligible cells scored purely by a single dominant spatial layer (highest affinity weight). Pick top N.
- **frontier**: No explicit seeds. Fills all eligible cells in the ring between `radius` and `radius + radiusStep` that are outside any nucleus's current radius.
- **fill**: All unclaimed eligible cells within radius, scored by affinity, pick top N. No minimum spacing — many small seeds.
- **arterial**: Eligible cells where `roadGrid > 0` AND road hierarchy is 'arterial' or 'collector'. Score by contiguous-area potential (prefer cells with many unclaimed neighbours). Pick top N.
- **desirable**: Eligible cells with `landValue > 0.5` AND no industrial reservation (type 2) within 20 cells. Score by affinity. Pick top N.

## Spread Behaviours

How clusters grow from their seeds:

- **linear**: BFS along road-adjacent cells, strongly preferring cells that continue the road frontage direction
- **blob**: BFS outward from seed, all directions equally weighted, produces roughly circular clusters
- **dot**: No spread — seed is the entire allocation (single plot or tiny cluster)
- **organic**: BFS with randomised neighbour ordering, produces irregular shapes
- **belt**: Fills a ring at constant distance from nearest nucleus
- **cluster**: BFS preferring cells near other same-type claims, produces tight groups

## Allocation Granularity

The footprint parameter (min/max cluster size) varies by archetype to reflect founding character:

- **Organic towns** (market town): Small footprints across all agents — fine-grained, plot-by-plot growth
- **Industrial towns**: Large industrial footprints early (big land grabs near arterials), medium residential estates
- **Planned towns**: Medium-regular footprints, more uniform block sizes
- **Port cities**: Large industrial footprints at waterfront (docks, warehouses), fine commercial behind

## Files Changed

- **Replace**: `src/city/pipeline/reserveLandUse.js` — current single-pass system replaced by growth agent runner
- **Create**: `src/city/pipeline/growthAgents.js` — agent definitions, seed strategies, spread behaviours
- **Create**: `src/city/pipeline/growthTick.js` — per-tick orchestration (expand radius, run agents, fill agriculture)
- **Modify**: `src/city/archetypes.js` — replace current shares/placement/growthMode with agent configuration
- **Modify**: `src/city/strategies/landFirstDevelopment.js` — multiple growth ticks instead of single reserveLandUse call
- **Modify**: `src/rendering/debugLayers.js` — update reservation colours for new use types (agriculture, residential sub-types)
- **Modify**: `src/core/FeatureMap.js` — ensure clone copies growth state (per-nucleus radii, active seeds)
- **Modify**: `src/city/archetypeScoring.js` — update to read new agent config structure instead of `shares`/`placement`
- **Modify**: `src/city/pipeline/layoutRibbons.js` — skip industrial, civic, agriculture zones; operate on residential + unreserved
- **Modify**: `src/core/composeMask.js` — handle expanded reservation types (5-8)
