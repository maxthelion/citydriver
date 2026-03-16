---
title: "City Archetypes"
category: "functionality"
tags: [archetypes, settlements, growth, land-use, geography]
summary: "How city archetypes control land reservation, placement requirements, organic growth, and street layout."
last-modified-by: user
---

## Overview

Each settlement is assigned an archetype that shapes its character. The archetype determines how much land is reserved for different purposes, where those reservations are made, and how organic the resulting city feels. Archetypes also impose geographic requirements on where a settlement can be placed.

See [[city-generator-overview]] for how archetypes fit into the generation pipeline.

## What Archetypes Control

- **Land reservation** — the proportion of land allocated to residential, commercial, industrial, civic, and other uses
- **Reservation placement** — where each land use tends to cluster (e.g. industry near water or rail, commerce at the centre)
- **Organic vs planned character** — how regular or irregular the street layout and plot boundaries are
- **Street pattern** — grid, radial, organic, or hybrid layouts depending on the archetype

## Geographic Requirements

Different archetypes have different siting constraints:

### Harbours

Require coastal locations. Work best with bays and large rivers that connect inland, providing both sheltered anchorage and trade routes to the interior.

### Market Towns

Best established at the confluence of different regional settlements — crossroads and meeting points where trade naturally concentrates.

### Planned Cities

Generally represent more recently built cities. They require flatter terrain to accommodate their regular layouts. The specific street pattern (grid, radial, etc.) is itself determined by the archetype.

## Planned vs Organic

Archetypes fall on a spectrum from highly organic (medieval market towns with irregular streets that evolved over time) to highly planned (grid cities laid out in a single phase). This affects:

- Street regularity and block shape
- Plot size consistency
- How growth ticks add new development — organic cities grow outward irregularly, planned cities extend their grid or radial pattern
