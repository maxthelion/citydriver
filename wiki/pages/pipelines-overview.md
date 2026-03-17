---
title: "Pipelines Overview"
category: "pipeline"
tags: [pipeline, regional, city, archetypes, overview]
summary: "Index of all generation pipelines: regional, city, and per-archetype city growth."
last-modified-by: user
---

## Overview

The generator runs two main pipelines in sequence. The **regional pipeline** produces a complete landscape with terrain, rivers, settlements, roads, and railways. The **city pipeline** then zooms into a single settlement, extracts and refines regional features, and grows the city through a series of ticks driven by the settlement's [[city-archetypes|archetype]].

## 1. Regional Pipeline

Generates the full regional map from a seed. Each phase enriches a shared LayerStack. Settlements and roads use a feedback loop — roads attract new settlements, which attract more roads.

See [[regional-pipeline]] for the full phase-by-phase breakdown, LayerStack contents, and entry point.

| Phase | Detail Page | Summary |
|-------|------------|---------|
| A0/A0b | [[regional-pipeline]] | Tectonics + river corridor planning |
| A1 | [[regional-geology]] | Rock types, erosion resistance, soil fertility |
| A2 | [[regional-pipeline]] | Terrain from layered noise + geology + corridor depression |
| A4 | [[regional-coasts]] | Erosion-shaped coastline with bays, headlands, harbours |
| A3 | [[regional-rivers]] | River networks, valley carving, floodplains |
| A6 | [[regional-settlements]] | Settlements, farms, market towns (feedback loop with roads) |
| A7 | [[regional-roads]] | Terrain-aware A* road network (two passes) |
| A8 | [[regional-railways-pipeline]] | Off-map cities and railway routing with settlement bonus |

## 2. City Pipeline

Takes a regional LayerStack and a settlement position, extracts a window of regional data, refines it to city resolution (5m cells), and grows the city through 7 ticks.

The archetype determines how tick 5 (land reservation) allocates land, and in future will control more of the pipeline — see [[archetype-data-model]] for planned extensions.

See [[city-generation-pipeline]] for the full tick sequence.

| Tick | Step | What it produces |
|------|------|-----------------|
| 0 | [[city-region-inheritance]] | Inherit terrain, rivers, railways, water from region; refine; place nuclei |
| 1 | Skeleton roads | Arterial network connecting nuclei via MST + A* |
| 2 | Land value | Nucleus-aware land value (flatness + proximity + waterfront) |
| 3 | Development zones | Voronoi + threshold + morphological close + flood-fill |
| 4 | Spatial layers | Centrality, waterfrontness, edgeness, road frontage, downwindness |
| 5 | [[land-reservation]] | Archetype-driven land use reservation (commercial, industrial, civic, open space) |
| 6 | Ribbon layout | Parallel streets within zones, contour-following on slopes |
| 7 | Network connection | Connect zone spines to skeleton via A* |

## 3. City Archetypes

Each settlement is scored against all archetypes; the best fit is selected. The archetype controls land reservation and will eventually control more pipeline steps.

See [[city-archetypes]] for the full descriptions and [[archetype-data-model]] for the schema.

| Archetype | Character | Key trait |
|-----------|-----------|-----------|
| [[archetype-market-town]] | Medieval organic town | Civic core, commercial along approach roads |
| [[archetype-port-city]] | Waterfront-driven | Industrial warehouses at harbour, commerce one block back |
| [[archetype-grid-town]] | Colonial planned grid | Central plaza, regular blocks, railway-era industrial edge |
| [[archetype-industrial-town]] | Single-industry dominated | Large central works, worker housing clusters around factory |
| [[archetype-civic-centre]] | Cathedral/university city | Institutional campus at centre, generous open space |

## 4. Per-Archetype Pipelines

Each archetype defines a set of starting variables and eligibility rules that determine which settlements it can apply to, and how the city growth ticks behave.

### [[archetype-market-town]]

*Stub — detailed pipeline on the archetypes branch.*

**Eligibility:** Default fallback; viable for any settlement. Bonus if 'market' nucleus present or 3+ roads converge.

**Starting variables:** Civic first, commercial follows road frontage. 67% residential remainder. Organic street pattern.

### [[archetype-port-city]]

*Stub — detailed pipeline on the archetypes branch.*

**Eligibility:** Requires 10%+ waterfront cells in development zones. Scored by waterfront fraction.

**Starting variables:** Industrial claims waterfront first. Directional growth parallel to water edge. Steep density gradient inland.

### [[archetype-grid-town]]

*Stub — detailed pipeline on the archetypes branch.*

**Eligibility:** Penalised by terrain variance > 0.04. Needs relatively flat land for regular grid.

**Starting variables:** Civic plaza at centre, commercial main street. Regular block sizes. Railway defines industrial edge.

### [[archetype-industrial-town]]

*Stub — detailed pipeline on the archetypes branch.*

**Eligibility:** Benefits from rivers (water power) and flat buildable land.

**Starting variables:** Industrial zone is primary (22% of land), not peripheral. Radial growth from works. Minimal open space.

### [[archetype-civic-centre]]

*Stub — detailed pipeline on the archetypes branch.*

**Eligibility:** Favours higher-tier settlements (tier 1-2). Benefits from road count.

**Starting variables:** Civic 18%, open space 14% — largest non-residential allocation. Industrial minimal (4%) and pushed far downwind.
