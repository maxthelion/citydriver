---
title: "City Generator Overview"
category: "functionality"
tags: [overview, simulation, procedural-generation, city, pipeline]
summary: "High-level overview of the city generator: a system that builds lifelike cities from interrelated causal processes spanning geology to 3D-renderable features."
last-modified-by: user
---

## What It Does

City Generator produces lifelike cities from a set of interrelated causal processes. Each stage feeds into the next, so the final city emerges from geography and geology rather than being placed arbitrarily.

## Generation Pipeline

### Regional Geography and Geology

Generation begins at the regional scale. Terrain, geology, and natural features (rivers, coastline, forests) are established first. These form the constraints that everything else responds to.

### Settlement Placement

Settlements are placed on the regional map based on geographic suitability. Connecting roads are generated between them. Each settlement's location is chosen to suit a particular city archetype — harbour towns on the coast, market towns at crossroads, industrial cities near resources, and so on.

### City Archetypes

Each settlement has an archetype (e.g. harbour, industrial city, market town) that determines its character. The archetype drives which growth ticks are applied and how they behave.

### Growth Ticks

When a city is selected, a number of growth ticks are run on it. The nature of these ticks is determined by the city's archetype. Growth ticks determine:

- What land can be built on
- Where different kinds of development are placed
- How the city expands over successive iterations

### Output Features

The output is a map of features that can be rendered in 3D. Features include:

- Roads
- Rivers
- Coastline
- Forests
- Buildings on plots of land

## Bitmap Layer Pipeline

The system uses a pipeline of composable bitmap layers to determine derived properties such as:

- **Buildability** — where construction is permitted
- **Land value** — which areas attract different development types
- Other spatial constraints that feed into placement decisions

Layers can be composed and combined, allowing complex spatial logic to emerge from simple per-layer rules.

## Debugging

The pipeline can be debugged by inspecting the output of individual layers at various stages:

- **2D layer views** — individual bitmap layers can be viewed in 2D with zooming, making it easy to inspect spatial data at any resolution
- **3D overlay** — layers can be overlaid on top of the 3D map to see how computed properties relate to the rendered city
- **Side-by-side comparison** — different strategies can be viewed side by side, useful for comparing the effect of parameter changes or alternative approaches
