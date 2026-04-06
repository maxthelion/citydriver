---
title: "Land Reservation"
category: "algorithms"
tags: [land-use, archetypes, zoning, spatial-layers, pipeline]
summary: "How the land reservation system allocates non-residential land. Covers the legacy BFS seed-and-grow algorithm and the newer vector frontage approach being developed in experiments."
last-modified-by: user
---

## Two Approaches

Land reservation has been implemented two ways. The first (BFS seed-and-grow) is what currently runs in the main pipeline. The second (vector frontage) is the approach being developed in experiments 040–061 and described in [[micro-reservation-model]]. The vector approach is expected to replace the BFS approach for frontage-based uses once it matures.

## Legacy Approach: BFS Seed-and-Grow

### What Problem It Solves

Before residential infill runs, the city needs coherent commercial, industrial, civic, and open space zones. The land reservation system carves these out of development zones so that later pipeline steps (ribbon layout, building placement) only operate on the unreserved remainder.

The reservation runs at **Tick 5** of the `landFirstDevelopment` pipeline, after zone extraction and spatial layer computation but before street ribbon layout. See [[city-archetypes]] for the broader archetype system.

## Algorithm Overview

For each use type in the archetype's `reservationOrder`:

1. **Calculate budget** — `round(totalZoneCells * share)` cells to claim
2. **Score all unreserved zone cells** — weighted sum of spatial layer values using the archetype's `placement` weights
3. **Pick a single seed** — the highest-scoring unreserved cell
4. **Grow from seed** — BFS outward, claiming cells until the budget is reached
5. **Write to reservation grid** — claimed cells get a uint8 reservation type (1=commercial, 2=industrial, 3=civic, 4=open space)

### Key design consequence: one blob per use type

The algorithm always picks **one seed** and grows **one contiguous zone** per use type. The entire budget (e.g. 12% of all zone cells for commercial) gets spent in a single connected region rather than distributed across multiple smaller areas. BFS guarantees contiguity — only neighbours of already-claimed cells can be added.

This means reservation order matters heavily. The first-reserved type gets the best location for its placement weights. Later types work with whatever's left.

## Growth Modes

Each use type has a growth mode: **radial** or **directional**.

### Radial

BFS priority queue ordered by cell score. Expands roughly equally in all directions, producing compact/circular zones. Used for civic and open space in most archetypes.

### Directional

Like radial, but with an axis bias. The axis is determined by computing the gradient of the dominant spatial layer at the seed, then taking the perpendicular (contour direction). Neighbours aligned with the axis get a **2x score bonus**; perpendicular neighbours get **0.5x**. This produces elongated strips — commercial strips along roads, industrial strips along waterfronts.

## Spatial Layers

Five layers computed at Tick 4 (`computeSpatialLayers`) provide the scoring inputs. All are 0-1 floats masked by terrain suitability:

| Layer | Formula | What it represents |
|-------|---------|-------------------|
| **centrality** | `1 / (1 + distToNucleus / 60cells)` | Proximity to city nuclei (falloff 300m) |
| **waterfrontness** | `max(0, 1 - waterDist / 20cells)` | Proximity to water (range 100m) |
| **edgeness** | `(1 - centrality) * terrain` | Peripheral location |
| **roadFrontage** | Box blur of roadGrid (r=4 cells), normalised | Local road density |
| **downwindness** | Dot product onto prevailing wind, normalised | Position downwind of centre |

## Archetype Comparison

### Budget Shares

| Use type | Market Town | Port City | Grid Town | Industrial Town | Civic Centre |
|----------|-------------|-----------|-----------|-----------------|--------------|
| Commercial | 12% | 15% | 14% | 8% | 10% |
| Industrial | 8% | 14% | 12% | **22%** | 4% |
| Civic | 5% | 5% | 6% | 4% | **18%** |
| Open Space | 8% | 6% | 8% | 5% | **14%** |
| *Residential (remainder)* | *67%* | *60%* | *60%* | *61%* | *54%* |

### Reservation Order

The order determines which use type gets first pick of land:

| Archetype | 1st | 2nd | 3rd | 4th | Rationale |
|-----------|-----|-----|-----|-----|-----------|
| **Market Town** | civic | openSpace | industrial | commercial | Civic core is the organising principle; commercial fills remaining approach roads |
| **Port City** | industrial | commercial | openSpace | civic | Waterfront warehouses claim the harbour first |
| **Grid Town** | civic | commercial | industrial | openSpace | Central plaza first, then main street commercial |
| **Industrial Town** | industrial | civic | commercial | openSpace | The works are the spatial anchor — everything else is secondary |
| **Civic Centre** | civic | openSpace | commercial | industrial | Institutional plots and grounds dominate the centre |

### Placement Weights

How each archetype steers each use type toward different parts of the map:

**Commercial:**
- Market Town: centrality 0.8, roadFrontage 0.6 — shops along central approach roads
- Port City: waterfrontness 0.7, roadFrontage 0.4 — quayside trading
- Grid Town: centrality 0.9, roadFrontage 0.5 — main street at grid centre
- Industrial Town: centrality 0.5, roadFrontage 0.7 — single main street, road access matters more than centrality
- Civic Centre: centrality 0.5, roadFrontage 0.6 — commercial ring around institutional core

**Industrial:**
- Market Town: downwindness 0.7, edgeness 0.5 — mills/tanneries pushed to the fringe, downwind
- Port City: waterfrontness 0.6, downwindness 0.4, edgeness 0.3 — warehouse district at harbour
- Grid Town: edgeness 0.7, downwindness 0.5 — railside strip at town edge
- Industrial Town: waterfrontness 0.4, downwindness 0.3, centrality 0.3 — factory is *central*, not peripheral
- Civic Centre: downwindness 0.8, edgeness 0.5 — minimal industry, pushed far out

**Civic:**
- All archetypes weight centrality highest (0.6-1.0). Port City adds waterfrontness 0.3.

**Open Space:**
- Market Town / Grid Town: centrality 0.6-0.7 — market square, town green
- Port City: waterfrontness 0.9 — embankment/promenade
- Industrial Town: edgeness 0.8 — minimal parks at the fringe
- Civic Centre: centrality 0.6, waterfrontness 0.3 — college grounds, cathedral closes

### Growth Modes

| Use type | Market Town | Port City | Grid Town | Industrial Town | Civic Centre |
|----------|-------------|-----------|-----------|-----------------|--------------|
| Commercial | directional | directional | directional | directional | directional |
| Industrial | directional | directional | directional | **radial** | directional |
| Civic | radial | radial | radial | radial | radial |
| Open Space | radial | **directional** | radial | radial | radial |

Notable differences:
- **Industrial Town** uses radial growth for industry — the works spread outward as a large central blob rather than a strip
- **Port City** uses directional growth for open space — produces a linear promenade along the waterfront

## The Contiguity Trade-off

The single-seed design produces realistic zone coherence (real cities have a commercial core, not scattered shops), but it means the **entire budget concentrates in one area**. A 12% commercial share on a 1600-cell zone creates one 192-cell commercial blob.

This can feel like the system "spends the whole budget in one spot" rather than distributing land uses across the city. Possible future approaches to address this:
- **Multiple seeds** — split the budget across 2-3 seeds (e.g. a primary and secondary commercial area)
- **Zone-local reservation** — reserve independently within each development zone rather than pooling all zones
- **Diminishing returns** — reduce a cell's score as distance from seed increases beyond a threshold, forcing the algorithm to start a new cluster

## Source Files (Legacy BFS)

| File | Role |
|------|------|
| `src/city/pipeline/reserveLandUse.js` | Main algorithm: scoring, seed selection, radial/directional growth |
| `src/city/archetypes.js` | Archetype definitions (shares, order, placement, growthMode) |
| `src/city/pipeline/computeSpatialLayers.js` | Spatial layer computation (centrality, waterfrontness, etc.) |
| `src/city/zoneExtraction.js` | Zone identification (upstream input) |

## New Approach: Vector Frontage

See [[micro-reservation-model]] for the vector-based approach being developed in experiments 040–061. It replaces BFS cell claiming with polygon-level reservations:

- Commercial claims a shallow frontage strip along anchor road edges
- Parks are placed as explicit polygons with perimeter roads
- Residential terrace bands wrap around civic space before generic fill
- Residual areas are filled with ribbon streets using `residualRibbonFill`

The new approach separates **macro search** (which sector does a buyer target?) from **micro claim** (what shape does it reserve within that sector?). See [[micro-reservation-model]] for the full model.
