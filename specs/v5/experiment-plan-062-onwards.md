# Experiment Plan: 062 Onwards

## Context

Experiments 040–061 proved a set of micro-claim primitives on a single sector:
- Commercial frontage strip with service road and access gaps ✓
- Boundary-attached park polygon with perimeter road ✓
- Terrace band around civic space ✓
- Guide-aligned street layout ✓
- Residual ribbon fill ✓

The next phase moves systematically from individual micro operations for each
land use type, through composite sector layouts, to full city layouts per
archetype. The goal is to build up a complete picture of how a city gets divided
before committing to a pipeline integration.

---

## Structure

**Tier 1 — Individual primitives (062–073)**
One experiment per unimplemented land use type or micro operation. Single
sector, single operation, controlled fixture. Proves the geometric primitive
exists and works.

**Tier 2 — Composite sector layouts (074–080)**
Combine two or three primitives in one sector. Proves they can coexist and
that the ordering and adjacency logic works.

**Tier 3 — Multi-sector coordination (081–086)**
Test how the same operation distributes across multiple sectors — commercial
spine, park spacing, civic programme. First steps toward city-scale allocation.

**Tier 4 — Full archetype city layouts (087–092)**
Run a complete city layout for each archetype on a fixture. Proves the macro
ordering model works end to end.

---

## Tier 1 — Individual Primitives

### 062 Church and Churchyard

**Tests:** Placing a small civic polygon at a prominent location — near a road
junction, on high-value land, with a road on at least one side.

**Geometry:** Roughly 30×40m polygon. One straight road face. Compact, regular
shape. Internal area is the churchyard; the church building is a landmark within
it (not detailed at this stage — just the lot).

**New code needed:**
- `analyzeVectorChurchSector` or a `civic/church` variant in vectorFrontageLayout
- Placement scoring: high centrality, near road junction, not adjacent to industrial

**Success:** A compact civic polygon appears at a naturally prominent position
in the sector, with a road on its primary face. Surrounding residual area is
cleanly separated.

---

### 063 Market Square

**Tests:** An open civic space at or near a road confluence — the kind of
space that forms where multiple approach roads meet at the town centre.

**Geometry:** Irregular open polygon, 40–80m across. Paved, no internal
buildings at this stage. Roads on multiple sides (2–3). Different from a park:
urban, paved, central, defined by the roads around it rather than by terrain.

**New code needed:**
- `analyzeVectorMarketSquareSector` — identify road confluence point in sector,
  build polygon around it
- Distinct from park: no perimeter road (roads already bound it), no terrace
  (commercial directly faces the square)

**Success:** An open polygon appears at the natural meeting point of roads in
the sector. Commercial frontage runs along at least one face.

---

### 064 Town Hall / Civic Building Plot

**Tests:** A single prominent institutional plot at a road junction end — the
kind of position where a town hall or cathedral closes a vista down a main
street.

**Geometry:** Single rectangular plot, 25–60m wide, 20–40m deep. Positioned at
the head of a primary road or at a major junction. Not a polygon reservation —
a single large lot with specific orientation.

**New code needed:**
- `buildVistaTerminusPlot` — find road-end or prominent junction, place oriented
  rectangle facing down the primary road axis

**Success:** A single large civic plot appears at the natural visual terminus of
a main road. Surrounding area treats it as an anchor.

---

### 065 Warehouse Yard

**Tests:** A large flat rectangle near road and/or rail, with a loading access
road along one face.

**Geometry:** 60–150m × 40–80m rectangle. Must be on flat land. Must have road
access on at least one long face. No frontage parcels — the whole thing is
industrial floor space.

**New code needed:**
- `analyzeVectorWarehouseYardSector` — score flat road-adjacent areas, place
  rectangular lot, emit access road on primary face
- Scoring: high flatness weight, road proximity, downwind, near rail if available

**Success:** A large rectangular industrial lot appears on the flattest,
most transport-accessible part of the sector. Access road runs along the
building face.

---

### 066 View Villa Cluster

**Tests:** Low-density residential on premium amenity land — hilltop, sea view,
park edge, quiet fringe.

**Geometry:** Loose cluster of larger plots (15–25m wide, 25–40m deep). Lower
density than terrace. Plots oriented toward the view or amenity rather than
strictly parallel to the road.

**New code needed:**
- `analyzeVectorViewVillaSector` — find highest-amenity land in sector (high
  land value, slope, water proximity), place loose plot cluster with view
  orientation
- Plot generation distinct from terrace: wider plots, larger setbacks, may
  skip some positions

**Success:** A recognisably lower-density residential area appears on the
highest-value terrain. Plot sizes and spacing are visibly different from terrace
housing.

---

### 067 Quayside Strip

**Tests:** Linear industrial/commercial strip perpendicular to a waterfront —
the geometry of a working harbour.

**Geometry:** Deep plots (15–30m) running back from the water edge. A quay road
runs parallel to the water. Crane positions or loading access along the water
face. Similar to commercial frontage but deeper, facing water not road.

**New code needed:**
- `analyzeVectorQuaysideSector` — detect water edge in sector, build perpendicular
  plots running back from it, emit quay road parallel to water
- Scoring: high waterfrontness, flat, road/rail access

**Success:** A strip of deep plots faces the water with their backs toward the
land. A quay road runs between the water edge and the plot fronts.

---

### 068 Promenade

**Tests:** A pedestrian path along a waterfront with no built plots — pure open
space with amenity value.

**Geometry:** A narrow linear polygon (10–20m wide) running along the water edge.
No buildings. A path along the water face.

**New code needed:**
- `buildPromenadeStrip` — find water edge polyline in sector, offset a narrow
  polygon, emit a path road along the inner edge
- No parcels produced — the promenade is the reservation

**Success:** A narrow linear open strip runs along the water edge. It acts as a
barrier for subsequent landward reservations (commercial or residential facing
the promenade).

---

### 069 Cemetery

**Tests:** A large irregular polygon at the edge of the settlement — distinct
from a park in that it has no perimeter road, no frontage, and is placed at
the fringe rather than the centre.

**Geometry:** Irregular, 1–4 hectares. At the edge of buildable land, near
terrain limits or settlement boundary. A single access road or gate at one
corner.

**New code needed:**
- `analyzeVectorCemeterySector` — score edge/low-centrality areas, place
  irregular polygon clipped to zone boundary
- Placement scoring: edgeness, low centrality, never adjacent to commercial

**Success:** An irregular boundary-edge polygon appears at the fringe of
buildable land. It acts as a hard barrier for ribbon street fill.

---

### 070 Station Precinct

**Tests:** The area around a railway station — platform approach road,
forecourt, taxi/bus space.

**Geometry:** A roughly rectangular cleared area adjacent to the railway.
A station road approaches from the nearest arterial. A forecourt polygon in
front of the station.

**New code needed:**
- `buildStationPrecinct` — find nearest railway cell to sector, build approach
  road from arterial, place forecourt polygon
- Depends on `map.railwayGrid` and `map.station`

**Success:** A cleared station precinct appears where the railway crosses or
runs near the sector. An access road connects to the arterial.

---

### 071 Back-to-Back / Dense Terrace

**Tests:** High-density residential without rear gardens — plots on both sides
of a narrow street, backs meeting in the middle. Industrial-era workers' housing.

**Geometry:** Plots 5–7m wide, 8–12m deep. Street width narrower than standard
terrace. No rear access. High coverage.

**New code needed:**
- Variant of the terrace claim with narrower plots and reduced depth parameter
- Could be a `microClaim` parameter variant rather than a new function

**Success:** Noticeably denser and narrower housing appears compared to standard
terrace. Street width is visibly narrower.

---

### 072 Industrial Railside Strip

**Tests:** Linear industrial allocation running parallel to a railway line —
the classic mill town pattern.

**Geometry:** A long narrow rectangle parallel to the railway, 20–40m wide,
up to 200m long. Plots have rail access on one face, road access on the other.

**New code needed:**
- `analyzeVectorRailsideSector` — detect railway corridor in sector, build
  parallel strip, emit access roads on both faces
- Scoring: adjacency to railway, flat, downwind

**Success:** A linear industrial strip runs parallel to the railway. Road
access and rail access faces are clearly distinct.

---

### 073 Civic Square with Commercial Surround

**Tests:** A market square (from 063) with commercial frontage running along
its road-facing edges — the typical market town centre pattern.

**Geometry:** Central open space + commercial strips on 2–3 faces, residential
or civic behind. The commercial strips face the square rather than an arterial.

**New code needed:**
- Composite of `analyzeVectorMarketSquareSector` + `analyzeVectorFrontageSector`
  where the frontage edges face the square rather than an external road

**Success:** A coherent town centre: open square at the convergence of roads,
commercial facing it on multiple sides, residential behind.

---

## Tier 2 — Composite Sector Layouts

These experiments combine multiple primitives to test that they coexist cleanly.

### 074 Church + Residential Ring

Church/churchyard as the anchor, residential terrace band around it (from 046),
residual fill behind.

### 075 Warehouse + Workers' Housing

Warehouse yard (065) on flat land, back-to-back housing (071) immediately
adjacent, separated by a service road.

### 076 Quayside + Commercial + Residential

Quayside strip (067) at the water, commercial frontage strip (053) set back one
block, residential terrace fill behind.

### 077 Station + Commercial Spine

Station precinct (070) as anchor. Commercial spine running from station toward
the town centre. Residential filling behind the commercial.

### 078 Full Civic Quarter

Park (054–057) + market square (063) + church (062) + town hall (064) in
adjacent sectors. Tests that the civic cluster feels coherent and that the
minimum-spacing rules keep each element distributed sensibly.

---

## Tier 3 — Multi-Sector Coordination

### 079 Commercial Spine Across Multiple Sectors

A commercial strip running through 3–4 connected sectors along a primary road.
Tests that the frontage geometry reads as a continuous high street rather than
disconnected sector-local strips.

**Key question:** How do sector boundaries affect the continuity of the
commercial frontage? Does the service road break at sector boundaries or
continue through?

### 080 Distributed Parks

Place 3–4 parks across a real city fixture, respecting minimum spacing. Tests
the macro search logic for distributed civic uses.

**Key question:** Does the scoring naturally distribute parks to different
parts of the city? Or do they cluster on the highest-value land?

### 081 Civic Programme Pass

Run the full civic programme for a market town archetype: church, market
square, park, town hall. Each placed in sequence, each with minimum spacing
from the others and from competing uses.

**Key question:** Does the sequential placement leave coherent spatial gaps for
residential? Does the civic programme feel like a town centre rather than a
collection of isolated polygons?

### 082 Industrial District

Warehouse yards + railside strips + back-to-back housing forming a coherent
industrial quarter on flat/downwind land. Tests multi-element industrial
district formation.

### 083 Commercial Hierarchy

Primary commercial (along arterials), secondary commercial (along collectors),
none on ribbon streets. Tests that commercial scales with road importance.

---

## Tier 4 — Full Archetype City Layouts

Each experiment runs the full reservation pass for one archetype on a real
fixture. The output is a coloured reservation map showing the whole city
divided by land use.

At this stage no street layout runs inside the reservations. The experiment
answers: does the distribution look like the intended archetype?

### 087 Market Town Full Layout

Priority order: civic (church + square + park) → commercial (high street
frontage) → industrial (downwind) → residential (everywhere else).

Expected pattern: civic core near centre, commercial along main approach roads,
small industrial area downwind, residential filling the rest.

### 088 Harbour / Port Layout

Priority order: quayside industrial → commercial near harbour → civic near
waterfront → residential behind.

Expected pattern: deep quayside plots at the water, commercial strip one block
back, civic open space along the embankment, residential filling inland.

### 089 Industrial City Layout

Priority order: industrial (large central/edge yards) → workers' housing near
industry → commercial (single main street) → civic (minimal).

Expected pattern: large industrial blocks dominating the flat land, housing
packed around it, one commercial spine.

### 090 Civic Centre Layout

Priority order: civic (cathedral close, college grounds, parks) → commercial
ring around civic core → residential outside.

Expected pattern: large institutional grounds at centre, civic open space,
commercial ring serving the institutions, residential around the edge.

### 091 Grid Town Layout

Priority order: civic square at grid centre → commercial on main cross streets
→ residential filling regular blocks → industrial at grid edge.

Expected pattern: clearly regular, all land uses aligned to the grid, civic at
crossing of main axes.

---

## What New Code Is Required

Most Tier 1 experiments need a new `analyzeVector*` function or a simple
geometric helper. Tier 2 is composition of existing functions. Tier 3–4 needs
the macro search layer.

| Experiments | New code |
|---|---|
| 062 church | `analyzeVectorChurchSector` or civic/church variant |
| 063 market square | `analyzeVectorMarketSquareSector` |
| 064 town hall plot | `buildVistaTerminusPlot` |
| 065 warehouse yard | `analyzeVectorWarehouseYardSector` |
| 066 view villas | `analyzeVectorViewVillaSector` |
| 067 quayside | `analyzeVectorQuaysideSector` |
| 068 promenade | `buildPromenadeStrip` |
| 069 cemetery | `analyzeVectorCemeterySector` |
| 070 station precinct | `buildStationPrecinct` |
| 071 back-to-back | Parameter variant of terrace claim |
| 072 railside strip | `analyzeVectorRailsideSector` |
| 073 square + commercial | Composite of existing functions |
| 074–078 | Composition only |
| 079–083 | Macro search: sector scoring, minimum spacing, budget distribution |
| 087–091 | Archetype programs as declarative buyer configs |

---

## Key Questions to Answer Before Tier 4

Before running full archetype layouts, three open questions need answers from
Tier 1–3:

**1. How do sector boundaries affect continuity?**
Do commercial strips and streets read as continuous across sector boundaries?
This affects whether sectors are the right granularity for allocation.

**2. How do civic uses distribute themselves?**
Does placement-by-score naturally produce the right spacing, or does it always
cluster on the highest-value land? This determines whether minimum-spacing rules
are needed, and if so how strict.

**3. What is the right budget granularity?**
If commercial gets 12% of city cells, does placing that budget in one sector
produce a realistic high street, or does it need to be split across multiple
sectors proportionally? The Tier 3 spine and distribution experiments answer this.
