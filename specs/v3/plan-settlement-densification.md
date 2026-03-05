# Plan: Settlement Densification with Feedback Loop

## Goal

Fill the regional map with a realistic density of settlements. Currently 8
settlements on a 256x256 grid (12.8km x 12.8km) is very sparse. A real
landscape this size would have dozens of farms, hamlets, and villages, with
larger settlements emerging at natural crossroads.

The settlement pattern should emerge from geography first, then be reinforced
by connectivity — settlements on busy routes grow larger, which attracts more
connections, which attracts more settlements.

## Current pipeline order

```
A1 Geology → A2 Terrain → A4 Coastline → A3 Hydrology →
A6 Settlements → A5 Land Cover → A7 Roads
```

## Proposed pipeline order

```
A1 Geology → A2 Terrain → A4 Coastline → A3 Hydrology →
A6a Primary settlements (towns/cities — current logic, fewer/bigger) →
A6b Farms & hamlets (geography-driven fill) →
A7a Initial roads (connect primaries + nearby farms) →
A6c Road-attracted settlements (market towns at junctions) →
A7b Road update (connect new settlements, reinforce busy routes) →
A6d Growth pass (promote settlements on busy routes) →
A5 Land Cover
```

## Phase details

### A6a — Primary settlements (modify existing)

Keep the current scored placement but with adjusted parameters:
- Reduce `maxSettlements` to 4-5 (just the major towns/cities)
- Increase `minSpacing` to 30+ (these are the big places)
- Tier assignment stays rank-based for primaries

These are the anchors of the settlement network.

### A6b — Farms & hamlets (new)

Full scan of the region. Place a small settlement wherever conditions are
good enough, subject to minimum spacing from each other.

**Scoring** (reuse existing scorer with different weights):
- Fertile soil: high weight (primary driver)
- Flat land: high weight
- River/stream access: moderate weight (water for livestock/irrigation)
- Coast proximity: low weight (fishing hamlets)
- Road proximity: zero or very weak (farms don't need roads to exist)
- Hub gravity: zero (farms go where land is good)

**Parameters**:
- Min spacing: 6-8 cells (300-400m) — farms can be close together
- Score threshold: lower than primaries (e.g. > 0.15)
- Tier: 4 (hamlet) or 5 (farm) — new tiers below village
- No cap on count — place as many as the land supports

**Valley/coast/river preference** emerges naturally from the scoring — these
areas score highest on flatness, fertility, and water access.

### A7a — Initial roads (modify existing)

Run the current road generator connecting:
- All tier 1-2 settlements (arterials between primaries)
- Tier 3 villages to nearest higher-tier (collectors)
- Tier 4 hamlets to nearest settlement within range (local roads)
- Farms (tier 5) do NOT get road connections yet — they're just on the map

The road generator's `roadGrid` sharing mechanism means routes between
primaries that pass near hamlets will naturally route through or near them.

### A6c — Road-attracted settlements (new)

After roads exist, look for opportunities created by the road network:

**Market towns** — Find points along arterial roads that are:
- Far from any existing tier 1-3 settlement (> 15 cells)
- Near a road junction or midpoint between two settlements
- On decent land (not steep, not flooded)
- Score bonus for road proximity and traffic (number of connecting roads)

**Upgraded hamlets** — Hamlets that happen to sit very close to an arterial
get promoted to tier 3 (village) — they've grown because of the road.

**Parameters**:
- Max market towns: 3-6 (not too many)
- Min spacing from existing tier 1-3: 15 cells
- Tier: 3 (village) for market towns

### A7b — Road update (new)

Re-run road generation with the expanded settlement list. Key differences
from A7a:
- New tier-3 market towns get collector roads
- The `roadGrid` from A7a is carried forward, so existing routes are
  strongly preferred (0.3x cost) — roads don't move, they just add branches
- New connections form between the market towns and nearby settlements

Alternatively, instead of re-running from scratch, incrementally add roads
for only the new settlements, pathfinding onto the existing `roadGrid`.

### A6d — Growth pass (new)

Count how many roads pass through or near each settlement. Settlements on
busy routes get promoted:

- **Traffic score**: for each settlement, count roads within N cells, weighted
  by road hierarchy (arterial = 3, collector = 1)
- Tier-4 hamlets with high traffic → promote to tier 3 (village)
- Tier-3 villages with high traffic → promote to tier 2 (town)
- Tier-2 towns with exceptional traffic → stays tier 2 but gets a population
  boost

This creates the feedback loop: good geography → settlement → road →
more settlements → more roads → settlement grows.

## Tier system

| Tier | Name | Min spacing | Population | Road connection |
|------|------|-------------|------------|-----------------|
| 1 | City | 40 cells | 20k-100k | Arterials to all tier 2 |
| 2 | Town | 25 cells | 2k-20k | Arterials to tier 1, collectors to tier 3 |
| 3 | Village | 12 cells | 200-2k | Collector to nearest higher tier |
| 4 | Hamlet | 6 cells | 20-200 | Local road to nearest settlement |
| 5 | Farm | 4 cells | 5-20 | Track/no road (implicit access) |

## Implementation approach

### Option A: Iterative (recommended)

Implement as a loop in `pipeline.js`:

```
settlements = placePrimaries(...)
settlements += placeFarms(...)
roads = generateRoads(settlements.filter(tier <= 4), ...)
settlements += placeMarketTowns(roads, ...)
roads = updateRoads(settlements, roads, ...)
settlements = growthPass(settlements, roads)
```

Each step is a small function. The pipeline orchestrates the feedback loop.

### Option B: Monolithic

Single `generateSettlements` function that does everything internally.
Simpler API but harder to debug and visualise intermediate steps.

**Recommendation: Option A.** It matches the existing pipeline pattern,
allows debug snapshots between steps, and each function stays focused.

## Files to create/modify

- `src/regional/generateSettlements.js` — Refactor into `placePrimaries()`
  (extract current logic, reduce max count)
- `src/regional/generateFarms.js` — New. Full-scan farm/hamlet placement
- `src/regional/generateMarketTowns.js` — New. Road-attracted placement
- `src/regional/generateRoads.js` — Add incremental mode that accepts
  existing `roadGrid` and only connects new settlements
- `src/regional/growSettlements.js` — New. Traffic-based tier promotion
- `src/regional/pipeline.js` — Orchestrate the new order

## Impact on city pipeline

- Many more settlements visible within a city's rectangle
- Regional roads between satellites create natural arterial framework
- B4 arterials can focus on *urban* arterials (ring roads, bypasses)
  rather than inventing the primary network
- B3 density field gets multiple nuclei from nearby settlements
- The `regionalRoads` data passed to the city will be richer

## Risks

- **Performance**: full-scan placement on 256x256 could place hundreds of
  farms. Road generation for all of them could be slow. Mitigate by only
  connecting tier <= 4 to nearest single settlement (no all-pairs).
- **Visual clutter**: too many settlements could make the region map noisy.
  Mitigate with appropriate min spacing and tier-based rendering.
- **Road spaghetti**: connecting every hamlet produces too many roads.
  Mitigate by only giving tier 4 a single local road, and tier 5 no road.
