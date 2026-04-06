# Land Allocation Experiments

## Context

This spec covers the next phase of experimentation after the fixture
infrastructure in `experiment-acceleration-plan.md` is in place. The goal is
to find a workable land allocation model — specifically:

- How commercial, industrial, parks, and civic reserve their land before
  streets subdivide everything
- How ribbon streets fill the residual polygon after commercial has taken
  anchor road frontage
- How parks appear as reserved arbitrary polygons
- What tooling makes this fast to iterate on

---

## The Two-Phase Model

The current growth tick model allocates land and lays streets simultaneously
per tick. This makes the two concerns hard to separate. A cleaner model splits
them:

### Phase 1 — Reservation

Each land use type claims its preferred area as a polygon, in archetype-priority
order. Each type makes claims up to a budget, then yields to the next type.

**Typical priority order for a market town:**
1. Commercial — claims anchor road frontage and high-centrality cells
2. Civic / parks — distributed claims, minimum spacing enforced
3. Industrial — flat, downwind, near transport
4. Residential — fills whatever is left

The reservation phase produces a set of labelled polygons. Roads have not been
laid yet. Large reservations that need road access but not dense streets
(industrial yards, parks) get their shape before any street layout can prevent it.

This is what the functionality overview describes but hasn't been implemented
cleanly. The current `reservationGrid` is a step in this direction but operates
at the cell level rather than the polygon level.

### Phase 2 — Street Layout

Each reserved polygon runs its appropriate street layout algorithm:

| Land use | Layout |
|---|---|
| Commercial | Dense frontage grid, streets perpendicular to anchor road |
| Industrial | Coarser grid, loading access priority |
| Residential | Ribbon streets filling residual polygon |
| Park | Perimeter path only, no internal streets |
| Civic | Determined by civic type (church yard, square, etc.) |

The residential case is the most important: after commercial strips the anchor
road frontage, the residual polygon is irregular. Ribbon streets fill that
shape, not the original zone boundary.

Residential should not always be treated as one final generic fill step. Some
reservations, especially civic ones, may want a shallow residential edge claim
first — for example terraced housing facing a park or square — with the
generic residual ribbons only filling what remains after that edge treatment.

Residential should also not be treated as socially uniform. Some residential
buyers may seek premium amenity land such as sea views, hilltops, park edges,
or quieter high-value fringe positions, and may claim those places at lower
density before generic residential fill is applied.

---

## Ribbon Streets in Residual Polygons

After commercial reserves anchor road frontage, the remaining zone area is an
arbitrary polygon — the zone minus the commercial strip. The ribbon algorithm
needs to treat the commercial reservation boundary as the new anchor edge and
grow streets away from it into the residual area.

This is not a fundamental change to the ribbon algorithm. The algorithm already
orients itself relative to anchor edges. The change is in what counts as the
anchor:

**Current:** anchor = zone boundary edge that borders an existing road
**Proposed:** anchor = any edge of the residual polygon that borders a
reservation (commercial, road, or zone boundary)

The residual polygon is computed as: zone cells minus reserved cells, then
traced into a boundary polygon. That polygon is passed to the ribbon layout in
place of the original zone polygon.

### Open question: handling concavities

When commercial takes a strip along one side and a park takes a corner, the
residual polygon may be non-convex or have re-entrant corners. The ribbon
algorithm handles simple concavities already (it clips streets at zone
boundaries). Pathological shapes — a thin L-shape, a polygon with a large
internal notch — may need a fallback that splits the residual into convex
sub-polygons first.

---

## Parks as Reserved Polygons

A park is a polygon placed during the reservation phase. It has no internal
streets — just a perimeter path. It acts as a barrier for all subsequent street
layout.

### Placement rules

- One park per N cells of zone area (distributed, not clustered)
- Located in high land-value areas that are not anchor-road-adjacent
  (commercial needs that frontage)
- Minimum spacing from other parks
- Prefer flat ground with water proximity

### Shape

Three viable options, in order of complexity:

1. **Rectangular** — pick a centroid, expand to target area, clip to zone
   boundary. Simple, fast, predictable.
2. **Road-bounded** — grow from centroid until hitting existing roads on two
   or more sides. The park fills the block it sits in. Organic without being
   arbitrary.
3. **Random walk polygon** — short random walk from centroid, convex hull.
   More organic shape but harder to control size.

Rectangular is the right starting point. Road-bounded is the more realistic
long-term target — parks in real cities tend to occupy blocks that were
reserved before surrounding streets were laid.

### Effect on ribbon layout

The park polygon is treated as an obstacle. Ribbon streets that would cross the
park boundary are clipped. This is the same clipping that currently handles
water and existing roads — the park just registers as another barrier type.

### Residential around parks and civic space

A park may want built frontage on some or all sides. In those cases the order is
not:

1. reserve park
2. fill everything else with generic residential ribbons

Instead it is:

1. reserve park
2. reserve a shallow residential terrace/frontage band along some or all park
   edges
3. then fill the remaining residual with generic residential ribbons

This means the reservation phase must support residential as both:

- a special edge-claim buyer
- and a residual-fill buyer

It may also need to support premium residential buyers that claim special
amenity land before ordinary residential residual fill.

---

## Experimentation Tooling

Two modes, at different levels of interactivity.

### Mode 1: Parallel script-based variants

Covered by `experiment-acceleration-plan.md`. Load a post-zones-refine fixture,
run N growth configurations in parallel, render outputs into one experiment
directory, compare in the viewer.

Good for: systematic comparison of discrete parameter sets. Running overnight.
Petri loop evaluation.

### Mode 2: Interactive parameter viewer

A 2D web viewer where you can adjust growth parameters in real time and
immediately see the result. The feedback loop is seconds, not minutes.

**Concept:**

1. Load a fixture (post-zones-refine) — the viewer renders the current zone
   and spatial layer state in 2D
2. A parameter panel exposes growth controls:
   - Agent priority order (drag to reorder)
   - Budget per agent per tick (slider)
   - Commercial: anchor road weight, centrality weight
   - Industrial: downwind weight, flatness threshold
   - Parks: minimum spacing, target area
   - Residential: delay ticks before ribbon starts
3. "Run growth" button: clones the fixture map, runs growth steps to
   completion, renders the result as a layer overlay
4. "Fork" button: keeps the current result as the left panel, runs a
   new parameter set in the right panel, shows both side by side
5. Layer toggles: switch between viewing reservationGrid, zoneGrid, road
   network, spatial layers independently

**What exists already:**
- `FeatureMap.clone()` — deep copies everything in memory, used by
  `CompareArchetypesScreen` already
- 2D debug layer views — the debug UI already renders any named layer as a
  2D overlay on the 3D map
- Growth steps run synchronously — fast enough for interactive use once
  pipeline setup is skipped

**What needs building:**
- A lightweight standalone 2D viewer (not embedded in the 3D city screen)
- Parameter panel with sliders and drag-to-reorder for agent priority
- "Run from fixture" mode that skips `generateRegion` and `setupCity`
- Fork/compare layout

**Relationship to the existing experiment viewer:**

The script-based viewer (`experiments/index.html`) shows static PNG outputs
from named experiments. The interactive viewer is a different tool — for
exploration, not archiving. Results worth keeping get exported as a numbered
experiment via the standard `run-experiment.js` script.

---

## First Experiment: Ordered Reservation

Before building the interactive viewer, the first experiment to run (using
parallel script-based variants) is the simplest version of the reservation
phase:

1. Load post-zones-refine fixture
2. Run a single reservation pass: commercial claims anchor road cells first,
   then parks, then industrial, then residential fills remainder
3. No street layout yet — just render the `reservationGrid` as coloured cells
4. Compare different priority orderings side by side

This validates whether the reservation model produces plausible land use
distributions before any street layout complexity is introduced.

**Experiment parameters to vary:**
- Agent priority order (6 permutations of commercial/industrial/park/residential)
- Commercial budget (cells per tick)
- Park minimum spacing (50m, 100m, 200m)
- Whether residential waits for all other agents or interleaves

Expected output: 2D reservation grid renders for seeds 42, 99, 884469 showing
coloured land use polygons without streets. The question to answer: does the
distribution look like a real city or are there obvious pathologies (all
commercial in one corner, parks clustered, industrial everywhere).

---

## Relationship to Other Specs

| Spec | Dependency |
|---|---|
| `experiment-acceleration-plan.md` | Fixture infrastructure required before any of this |
| `functionality-overview.md` | The ideas being tested here |
| `land-buyer-model.md` | Declarative buyer families/variants for reservation and road consequences |
| `pipeline-step-contracts.md` | Reservation phase would be a named pipeline step with a declared contract |
| `pipeline-event-log.md` | Reservation decisions (why cell X was claimed by commercial) are a natural event stream |
| `city-archetypes.md` | Archetype config determines agent priority order and budgets |
