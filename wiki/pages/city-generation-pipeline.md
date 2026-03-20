---
title: "City Generation Pipeline"
category: "pipeline"
tags: [city, pipeline, generation, ticks, archetypes, generator]
summary: "The ordered sequence of steps that generates a city from inherited regional map features, driven by archetype selection."
last-modified-by: user
---

## Overview

Cities are not generated from scratch. They inherit terrain, rivers, water, and settlement positions from the regional map, then develop through a sequence of named pipeline steps. The city's [[city-archetypes|archetype]] determines how growth ticks allocate and shape land use.

The pipeline is implemented as a JavaScript generator (`cityPipeline`) executed by `PipelineRunner`. Each step yields a descriptor `{ id, fn }` — the runner executes `fn()`, fires timing and invariant hooks, and advances on request. See [[pipeline-abstraction]] for the full design.

## Step 0: Region Inheritance

City setup extracts a window from the regional map, refines terrain to 5m resolution, and imports rivers, railways, and settlements. See [[city-region-inheritance]] for full details of what is inherited and how.

## Archetype Selection

Before growth ticks run, the settlement is scored against all five archetypes (in `archetypeScoring.js`). The best-fitting archetype is selected and passed to the pipeline. The archetype controls growth agent budgets, ribbon street density, value layer weights, and whether a planned or organic growth strategy runs.

## Pipeline Steps

### skeleton

Builds the arterial road network connecting nuclei via minimum spanning tree and A* pathfinding. Writes `roadGrid` and `bridgeGrid` layers, road features, and a planar graph for routing.

### land-value

Computes `landValue` (0–1) for every cell. Two passes:
1. **Flatness** — terrain suitability from slope and elevation roughness (7×7 kernel)
2. **Value** — weighted composite of nucleus proximity, water proximity, flatness, and coast access

### zones

Extracts development zones as **graph faces** from the planar road graph (`PlanarGraph.facesWithEdges()`). Each face becomes a zone with:
- `cells` — rasterized grid cells within the polygon
- `polygon` / `boundingEdgeIds` / `boundingNodeIds` — topological references
- `centroid`, `avgSlope`, `slopeDir`, `avgLandValue` — spatial metadata

Falls back to a bitmap flood-fill approach if the graph has fewer than 2 edges.

### zone-boundary

Creates secondary collector roads along zone polygon boundaries. These roads split large zones into finer development parcels, improving street grain. Roads are clipped against water and existing roads, then merged onto the skeleton via node splitting.

### zones-refine

Re-runs zone extraction. Because `zone-boundary` added new edges to the planar graph, `facesWithEdges()` now returns finer faces. The second extraction picks up the new road-defined boundaries as zone edges.

### spatial

Computes five scoring layers used by land reservation and growth agents:
- **Centrality** — distance falloff from nuclei (300m)
- **Waterfrontness** — inverse distance to water (100m range)
- **Edgeness** — inverse of centrality
- **Road frontage** — local road density (4-cell blur of road grid)
- **Downwindness** — position relative to prevailing wind

All layers are 0–1 floats masked by terrain suitability.

### growth-N:influence … growth-N:roads (organic growth)

Runs the organic growth loop. Each tick (N = 1, 2, …) has five named sub-steps:

| Sub-step | What it does |
|----------|-------------|
| `growth-N:influence` | BFS blur reservation grid → proximity gradients; agriculture retreat |
| `growth-N:value` | Compose per-agent value bitmaps from spatial + influence layers |
| `growth-N:ribbons` | Throttled ribbon layout: place parallel streets in zones near existing dev |
| `growth-N:allocate` | Agent allocation loop (blob/frontage/ribbon allocators); writes `reservationGrid` |
| `growth-N:roads` | Grow roads from ribbon gaps via A* pathfinding; agriculture fill |

The loop terminates when all agent budgets are exhausted or `maxGrowthTicks` is reached.

For archetypes without a growth config, three steps run instead:
- `reserve` — BFS-based land use reservation from `reserveLandUse.js`
- `ribbons` — full `layoutRibbons` run on all zones

### connect

Connects zone spines to the skeleton road network via A* pathfinding. Also runs full-connectivity checking: disconnected local-road components are connected to the nearest skeleton node (up to 20 connectors).

## Source Files

| File | Role |
|------|------|
| `src/city/setup.js` | Step 0: regional inheritance, terrain refinement, nucleus placement |
| `src/city/strategies/landFirstDevelopment.js` | Thin PipelineRunner wrapper |
| `src/city/pipeline/cityPipeline.js` | Generator pipeline definition |
| `src/city/pipeline/PipelineRunner.js` | Step executor with hook support |
| `src/city/pipeline/buildSkeletonRoads.js` | `skeleton` step |
| `src/city/pipeline/computeLandValue.js` | `land-value` step |
| `src/city/pipeline/extractZones.js` | `zones` / `zones-refine` steps |
| `src/city/pipeline/zoneBoundaryRoads.js` | `zone-boundary` step |
| `src/city/pipeline/computeSpatialLayers.js` | `spatial` step |
| `src/city/pipeline/growthTick.js` | `growth-N:*` phase functions + `runGrowthTick` wrapper |
| `src/city/pipeline/layoutRibbons.js` | `growth-N:ribbons` / `ribbons` step |
| `src/city/pipeline/segmentTerrainFaces.js` | Terrain face segmentation for per-face ribbon layout |
| `src/city/pipeline/connectToNetwork.js` | `connect` step |
| `src/city/archetypes.js` | Archetype definitions |
| `src/city/archetypeScoring.js` | Archetype auto-selection |

## Related Docs

- [[pipeline-abstraction]] — PipelineRunner design, generator composition, strategy registry
- [[pipeline-invariant-tests]] — bitmap, polyline, and block invariants checked at every step
- [[pipeline-observability]] — hook-based timing and bitmap logging
- [[land-reservation]] — detailed doc on tick-5 (legacy) and growth agent allocation
- [[terrain-face-streets]] — per-face ribbon layout design
