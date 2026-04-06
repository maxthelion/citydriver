# Experiment Plan: 062 Onwards

## Context

Experiments 040–061 proved a set of micro-claim geometric primitives on a
single sector:

- Commercial frontage strip with service road and access gaps ✓
- Boundary-attached park polygon with perimeter road ✓
- Terrace band around civic space ✓
- Guide-aligned street layout ✓
- Residual ribbon fill ✓

These functions (`analyzeVectorFrontageSector`, `analyzeVectorBoundaryParkSector`
etc.) are the **micro claim layer** — they define how a buyer shapes land within
a sector it has already been given.

What is missing is everything above them: the **buyer tick** — the mechanism
that decides which sector each buyer targets (macro search), runs claims in
priority order, tracks what has been claimed, and distributes uses across the
whole city.

The experiments from 062 onwards build that layer, incrementally, so that by
the end there is a working buyer tick that can lay out a whole city under
different archetypes.

---

## The Buyer Tick Model

A buyer tick for a single sector:

```
For each buyer variant in archetype priority order:
  1. Macro search — score all available sectors, pick best candidate
  2. Micro claim  — run the geometric primitive on the winning sector
  3. Record       — add ReservationLayout to city state, mark sector (partially) consumed
  4. Repeat until variant's budget is exhausted or no eligible sectors remain
```

What differentiates most land use types is **not** the polygon shape — it is
the macro search scoring. A church and a small park use nearly the same polygon
primitive. What makes them different is where they go:

- Church: high centrality, near road junction, prominent position
- Park: distributed, waterfront or hilltop, minimum spacing from other parks

The micro claim geometry is mostly shared or parameterised. The scoring is
what separates them.

A buyer variant therefore looks like:

```js
{
  key:         'civic/park',
  macroSearch: {
    score: (sector, spatialLayers, existingClaims) => number,
    minSpacing: 300,          // metres from other parks
    maxPerCity: 4,
  },
  microClaim:  analyzeVectorBoundaryParkSector,   // existing function
  params:      createVectorFrontageParams(cellSize, { parkMinLengthMeters: ... }),
  budget:      { shareOfZoneCells: 0.05 },
}
```

The buyer registry maps variant keys to these objects. The archetype program
is a priority-ordered list of variant keys. The buyer tick runner iterates the
list and executes macro search then micro claim for each.

---

## Experiment Tiers

**Tier 1 (062–067) — Buyer tick infrastructure**
Build the macro search layer and the tick runner. Use existing micro claim
functions. Prove that two buyers running in sequence pick the right sectors.

**Tier 2 (068–074) — Additional buyer variants**
Add new buyer variants by defining macro search scoring for each land use type.
Most share existing geometric primitives; a few need small extensions.

**Tier 3 (075–080) — Budget, ordering, and distribution**
Multiple buyers across the whole city. Budget limits, minimum spacing, priority
ordering effects. Prove that the sequence produces coherent districts.

**Tier 4 (081–086) — Full archetype programs**
Run complete buyer programs for each archetype. Output is a whole-city
reservation map. Proves the model end to end.

---

## Tier 1 — Buyer Tick Infrastructure

### 062 Macro Search: Scoring Sectors for One Buyer

**Goal:** Given a city fixture (post-spatial), score all available sectors for
the `commercial/frontage-strip` variant using the spatial layers already
computed (centrality, roadFrontage, landValue). Render the scored sector map —
colour sectors by score, highlight the top candidate.

**No micro claim runs yet.** This is purely about validating that the scoring
function picks the right sector.

**Success:** The highest-scoring sector is visually obviously a good commercial
location — high road frontage, central, near arterials. A bad result (scoring
picks a peripheral flat zone with no road exposure) reveals missing weight
terms.

**Output:** Coloured sector score map. Top-N candidates highlighted.

---

### 063 Macro Search: Two Competing Buyers

**Goal:** Score sectors simultaneously for `commercial/frontage-strip` and
`civic/park`. Render both score maps side by side. Confirm they prefer
different sectors.

**Success:** Commercial scores road-facing central sectors highest. Park scores
waterfront, hilltop, or interior high-value sectors highest. The two maps
should not have the same winner.

**Also test:** What happens when commercial runs first and claims a sector —
does park's scoring correctly avoid claimed land?

---

### 064 First Buyer Tick: Two Variants in Sequence

**Goal:** Run a minimal buyer tick loop with two variants:
1. `commercial/frontage-strip` claims its top sector
2. `civic/park` claims its top unclaimed sector

Commit both claims, render the result.

**New code needed:**
- `src/city/land/buyerTick.js` — minimal tick runner:
  - accepts an ordered list of buyer variants
  - for each: runs macroSearch, picks top sector, runs microClaim, records
    ReservationLayout, marks sector consumed
  - returns the full set of layouts

**Success:** Two sectors in the city are claimed — one clearly commercial, one
clearly a park. The claims don't overlap. Residual areas from both are clearly
defined.

---

### 065 Buyer Tick: Claimed State Propagates

**Goal:** Add `residential/edge-terrace` as a third variant. It must score
sectors adjacent to already-claimed civic space (the park from 064).

**Tests:** Does macro search correctly boost sectors that neighbour the park
claim? Does the terrace band correctly wrap around the park polygon boundary?

**New code needed:**
- Macro search scoring for `residential/edge-terrace`:
  - adjacentToClaim (civic/park) → high score
  - adjacentToClaim (commercial) → medium score
  - no adjacency → low score

**Success:** The terrace claim appears immediately adjacent to the park, not in
a random sector. The terrace band geometry wraps the correct face.

---

### 066 Buyer Tick: Residual Fill as Final Variant

**Goal:** Add `residential/residual-fill` as the last variant. It fills
whatever is left in each sector after commercial, civic, and terrace claims
have run.

**Tests:** Does residual fill correctly use the residual areas left by earlier
claims? Does it skip sectors that are fully claimed?

**Success:** Every sector has ribbon streets filling the unclaimed area. The
boundary between commercial/park/terrace and residual fill is clean —
streets don't cross into reserved polygons.

---

### 067 Buyer Tick: Serialised Claim State

**Goal:** Serialise the full set of ReservationLayouts from a buyer tick run
to JSON alongside the fixture. Load and re-render without re-running the tick.

**Why:** If claims are deterministic but expensive, being able to save and
replay them makes experiments faster and more comparable.

**New code needed:**
- `ReservationLayout.toJSON()` already exists on each layout
- A thin wrapper that saves/loads the array of layouts alongside the fixture

**Success:** The rendered output from a loaded claim state is identical to the
output from re-running the tick.

---

## Tier 2 — Additional Buyer Variants

Each experiment adds one new buyer variant — primarily by defining its macro
search scoring. The micro claim reuses or lightly parameterises an existing
primitive.

### 068 Church / Churchyard

**Macro search:** High centrality, near road junction (two or more roads
meeting), not adjacent to industrial. Scoring uses centrality + roadFrontage
at junction points.

**Micro claim:** Small polygon (~30×40m). Reuses the park polygon primitive
with smaller target dimensions and no perimeter road (road already bounds it).

**Budget:** 1–2 per city.

---

### 069 Market Square

**Macro search:** Road confluence — sectors where two or more roads meet near
the sector centroid. High centrality. This is the commercial anchor, so it
should run before or alongside commercial.

**Micro claim:** Open polygon at the road convergence point. Roads bound it on
multiple sides. Reuses the civic polygon primitive; no internal parcels.

**Budget:** 1 per city (possibly 2 for larger cities).

---

### 070 Industrial Yard

**Macro search:** Flat terrain (low slope), downwind, near road or rail, low
centrality (edgeness). Avoids residential and civic adjacency.

**Micro claim:** Large rectangle (60–150m × 40–80m). Access road on primary
face. Reuses park polygon primitive with larger target dimensions and access
road emission rather than perimeter road.

**Budget:** Share of flat edge zone cells (varies by archetype — large for
industrial town, small for market town).

---

### 071 Quayside

**Macro search:** Sectors with a water edge. Maximum waterfrontness score.
Flat land. Near rail if available.

**Micro claim:** Strip of deep plots running perpendicular to the water edge.
A quay road parallel to the water. The frontage faces the water, not a road.
Adapts `analyzeVectorFrontageSector` to use the water edge as the anchor
rather than a road edge.

**Budget:** Linear proportion of waterfront length.

---

### 072 View Villa Cluster

**Macro search:** High land value + slope + water proximity or high elevation.
Specifically: sectors that score high on at least two of — hilltop, sea view,
park adjacency, quiet fringe. Low centrality acceptable.

**Micro claim:** Loose cluster of wider, deeper plots. Parameterises the
existing terrace claim with larger plot dimensions and lower density. Does not
require road frontage on both sides.

**Budget:** Small share of high-amenity zone cells.

---

### 073 Railside Industrial Strip

**Macro search:** Sectors adjacent to railway. Downwind. Flat.

**Micro claim:** Long narrow rectangle parallel to the railway corridor.
Road access on the landward face, railway on the other. Parameterised version
of the industrial yard with a forced linear orientation.

**Budget:** Proportion of railway-adjacent zone cells.

---

### 074 Promenade

**Macro search:** Sectors with direct water frontage. Preferably not already
claimed by quayside.

**Micro claim:** Narrow strip (10–20m) along the water edge. No built parcels.
A path road along the inner edge. Acts as a barrier — commercial or residential
facing it treat it as their frontage.

**Budget:** Thin linear claim along water edge; low cell count.

---

## Tier 3 — Budget, Ordering, and Distribution

### 075 Commercial Budget Across Multiple Sectors

Run `commercial/frontage-strip` with a city-level budget (e.g. 10% of zone
cells). Watch it claim multiple sectors in sequence — top-scored first, then
next-best, until budget exhausted.

**Key question:** Does the commercial budget distribute across naturally good
locations, or does it concentrate in one sector?

---

### 076 Distributed Civic: Minimum Spacing

Run `civic/park` with a budget of 3–4 parks and a minimum spacing of 300m.
Each successive park claim must be at least 300m from all previous ones.

**Key question:** Does minimum spacing correctly distribute parks across the
city? Does the spacing interact well with the scoring — or does the best
unclaimed sector always neighbour the last claimed one?

---

### 077 Priority Order Effects

Run the same set of buyers in two different orderings:
- A: commercial → civic → industrial → residential
- B: civic → commercial → industrial → residential

Compare the outputs. Civic-first should produce a city where commercial wraps
around a pre-existing civic core. Commercial-first should produce a city where
civic is pushed to secondary locations.

**Key question:** Does priority order produce visually distinct city layouts?
This validates that the ordering mechanism is doing real work.

---

### 078 Industrial + Residential Adjacency

Run `industrial/yard` and `residential/residual-fill` in sequence. Industrial
claims flat edge land. Residential fills around it.

**Key question:** Does residential correctly avoid claiming land adjacent to
industrial (downwind penalty)? Does a buffer zone appear naturally from the
scoring, or does it need an explicit forbidden-adjacency rule?

---

### 079 Full Civic Programme

Run the full civic variant set for a market town:
- `civic/market-square` (1, central)
- `civic/park` (2, distributed)
- `civic/church` (2, near junctions)

All with minimum spacing. Render the full city with civic claims only.

**Key question:** Does the civic programme produce something that reads like a
real market town civic structure — square at the centre, parks distributed,
churches at prominent crossroads?

---

### 080 Residential Hierarchy

Run three residential variants in sequence:
1. `residential/view-villa` (claims premium terrain first)
2. `residential/edge-terrace` (wraps civic space)
3. `residential/residual-fill` (fills everything else)

**Key question:** Is the hierarchy visible? Does premium housing clearly occupy
the best terrain? Does the terrace band appear around civic space? Does residual
fill cleanly handle what's left?

---

## Tier 4 — Full Archetype Programs

Each experiment runs the complete buyer tick loop for one archetype on a real
city fixture (post-spatial). Output is a full-city reservation map coloured by
land use type. No internal street layout yet — just the reservation polygons.

### 081 Market Town

Program order: market-square → parks → churches → commercial-frontage →
industrial-yard → view-villa → edge-terrace → residual-fill

Expected: civic core at centre, commercial along main approach roads, small
industrial area downwind, residential filling the rest, premium housing on
best terrain.

---

### 082 Harbour / Port

Program order: quayside → promenade → commercial-near-harbour →
civic-waterfront → industrial-railside → residual-fill

Expected: working harbour at the water, commercial strip landward of it,
promenade along the non-industrial waterfront, residential filling inland.

---

### 083 Industrial City

Program order: industrial-yard (large budget) → railside-strip →
commercial-spine (small) → civic (minimal) → residential-dense → residual-fill

Expected: large industrial blocks dominating flat land, housing packed around
them, one modest commercial spine.

---

### 084 Civic Centre

Program order: civic-campus (large, central) → parks (generous budget) →
commercial-ring → residential → residual-fill

Expected: large institutional grounds at centre, generous open space, commercial
ring serving the campus, residential around the edge.

---

### 085 Grid Town

Program order: civic-square (at grid centre) → commercial (on primary axes) →
industrial (at grid edge) → residential-block → residual-fill

Expected: clearly regular, all uses aligned to the grid, civic at the crossing
of main axes.

---

## What New Code Is Required

| Tier | What | Where |
|---|---|---|
| 1 | `buyerTick.js` — macro search runner + tick loop | `src/city/land/buyerTick.js` |
| 1 | Macro search scoring for `commercial/frontage-strip` and `civic/park` | Same file or buyer registry |
| 1 | Buyer registry — maps variant keys to macroSearch + microClaim + params | `src/city/land/buyerRegistry.js` |
| 2 | Macro search scoring per variant (068–074) | Buyer registry entries |
| 2 | Water-edge anchor for quayside (extends analyzeVectorFrontageSector) | vectorFrontageLayout.js |
| 3 | Minimum spacing enforcement in macro search | buyerTick.js |
| 3 | Budget tracking across multiple sector claims | buyerTick.js |
| 4 | Archetype programs as declarative buyer lists | `src/city/archetypes.js` or separate files |

The micro claim functions (`analyzeVector*`, `fillResidualAreasWithRibbons`)
are already built. Almost all new code is in the macro search and tick
orchestration layer.

---

## Key Questions Each Tier Must Answer

**After Tier 1:**
- Does scoring reliably pick the right sector for each buyer?
- Does the claim state correctly propagate — do later buyers see what earlier
  buyers claimed?

**After Tier 2:**
- Do most land use types share micro claim primitives with different scoring?
- Which types genuinely need new geometric operations vs new scoring only?

**After Tier 3:**
- Does priority order visibly change the city layout?
- Does minimum spacing produce distributed civic uses without explicit
  placement rules?
- Does residential naturally avoid industrial without a hardcoded penalty?

**After Tier 4:**
- Do the five archetype programs produce visually distinct city layouts?
- Does the reservation map look like the intended archetype before any street
  layout runs?
