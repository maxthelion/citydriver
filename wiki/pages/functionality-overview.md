---
title: "Functionality Overview"
category: "functionality"
tags: [overview, pipeline, region, city, archetypes, land-use, growth]
summary: "A top-down description of the full generation process, from regional geography to city-level land allocation and street layout."
last-modified-by: user
---

## Philosophy

The core insight behind this approach is that **micro-level detail can't be modelled realistically without imagining the macro context it sits within**. A city's shape, street grain, and land use are downstream consequences of geography, connectivity, and history — not arbitrary choices. The pipeline therefore works top-down: region first, then city, then streets, then plots.

---

## Regional Scale

### Geography

Generation begins with a region: terrain topology, geology, water bodies, and coastline. Rivers entering the region may have accumulated flow from outside the map boundary.

### Settlements and Roads

Settlements are placed at locations of highest geographic value — flat land near water, natural crossing points, sheltered coastlines. Once placed, they are connected by a road network. The road network currently does not connect to the wider world beyond the region boundary.

### Railways

The railway network brings in a broader macro context: imagining cities beyond the region, their relative importance (e.g. capital city), and major rail corridors. This shapes which settlements become rail-connected and how significant their stations are.

### Sea Trade

A similar macro-reasoning can be applied to sea trade, to determine whether a coastal settlement would realistically support a large port.

### Gaps in the Current Model

Two macro factors that would shape a real region are not yet modelled:

- **Resources** — coal, iron, timber, and agricultural land traditionally determined what industry developed where.
- **Climate** — temperature and rainfall shape landscape character, vegetation, and building typology.

---

## City Scale

When a city is generated, the pipeline zooms into a settlement on the regional map and works at higher resolution over a constrained area. The goal is to fill the whole area with roads, buildings, and other features.

### Inherited Data

The city pipeline begins by importing from the region:

- Elevation data (refined at higher resolution with additional noise)
- Rivers
- Railways
- Existing roads and settlement boundaries

### City Archetypes

Each city is generated according to an **archetype** — a set of rules that determines layout character, land use priorities, and growth behaviour. Archetypes are designed to reflect how different kinds of settlement actually develop. Current archetypes include:

| Archetype | Key character |
|-----------|--------------|
| Harbour | Organised around river or sea frontage; warehousing near water |
| Port | Trade-driven; strong road/rail links; large commercial presence |
| Market Town | Commercial hub at road confluences; organic growth |
| Industrial City | Dominated by a single industry; large flat reservations |
| Civic Centre | Cathedral town, university city, or administrative capital |

Archetypes control growth agent budgets, land use priorities, and whether the city grows organically or on a planned grid.

### City Age and Layout Strategy

City age is a significant driver of layout character:

- **New cities** (colonial, planned) tend towards regular grids or radial patterns.
- **Old cities** tend to be organic — grown from multiple local nuclei that developed simultaneously and merged over time.

For an older organic city, the pipeline begins:

1. **Place nuclei** at high-value locations (similar criteria to regional settlement placement: near water, flat land, natural nodes).
2. **Connect nuclei** via an arterial road network.
3. **Extract zones and sectors** from the faces of that road graph.

---

## Land Allocation

After the basic skeleton is established, the remaining challenge is dividing the city map so that every piece of land has a determined use. This is the most complex and currently most incomplete part of the pipeline.

### Core Principles

- Large land uses (industrial yards, parks, rail freight) must be **reserved early** — once streets have subdivided everything, there is no room for them.
- In reality, land use shifts over time through many competing transactions. The model approximates this by targeting **percentage coverage** per use type rather than simulating individual transactions.
- Roads, once laid, are treated as permanent.

### Land Use Placement Rules

Different uses follow different placement logic:

- **Commercial** tends to attach to anchor roads and high-footfall routes.
- **Industrial** is placed downwind and near transport (road and rail).
- **Residential** fills whatever is not claimed by another use; density and plot size vary with land value and proximity to amenity or nuisance.
- **Civic uses** (parks, churches, market squares, cinemas) need to be distributed evenly across the city rather than clustered.
- **Density** is higher where land is at a premium; plots are smaller in central or high-value zones.

### Growth Ticks

The city grows through a series of **ticks**. In each tick, land uses make claims against a budget. The archetype determines the order and weighting of these claims.

**Example — Industrial archetype tick:**
1. Industrial reserves flat sectors near transport links.
2. Commercial claims plots along nearby streets.
3. Residential fills remaining cells in nearby sectors.

**Example — Harbour archetype tick:**
1. Warehouses and freight uses claim river frontage near rail and road access.
2. Commercial fills adjacent streets, weighted towards uses that serve the port.
3. Market squares appear nearby.
4. Industrial locates downwind and within easy reach of port infrastructure.

**Example — Market town archetype tick:**
1. Commercial clusters at confluences of major roads.
2. Residential fills around commercial cores.
3. Industrial places downwind.

Civic uses (parks, churches, etc.) are placed each tick according to their own distribution rules, targeting even coverage.

### Budget Granularity

The tick budget size matters:

- Too large → land allocations become blocky and unrealistic.
- Too small → large reservations can't form because smaller claims fill available space first.

### Residential Ribbon Streets

Residential areas are built using **ribbon streets** — rows of plots arranged along parallel streets. Because ribbons fill areas around reservations of other types, residential may need to be placed **late in the process** rather than allocated progressively in each tick.

---

## Open Questions

Several elements of the pipeline are not yet placed in the sequence:

- **Train stations** — where are they placed, and at what point in the growth process?
- **Water features** — promenades, beaches, waterfronts.
- **Rural plots** — farms and edge-of-city agricultural land.

---

## Engineering Considerations

The system should be **modular and composeable** so that each pipeline step can be developed and tested in isolation. Key design questions:

- What are the discrete pipeline steps?
- What is the contract between steps (inputs and outputs)?
- How does the output of one step feed into the next?
- How do we experiment with alternative strategies for individual steps without breaking the whole pipeline?

See [[pipeline-abstraction]] for the current approach to these questions, and [[city-generation-pipeline]] for the detailed step sequence.
