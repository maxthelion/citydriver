---
title: "City Generation Pipeline"
category: "pipeline"
tags: [city, pipeline, generation, ticks, archetypes]
summary: "The ordered sequence of steps that generates a city from inherited regional map features, driven by archetype selection."
last-modified-by: user
---

## Overview

Cities are not generated from scratch. They inherit terrain, rivers, water, and settlement positions from the regional map, then develop through a sequence of growth ticks. The city's [[city-archetypes|archetype]] determines how the growth ticks allocate and shape land use.

## Inherited Features from the Regional Map

City setup (`setupCity`, tick 0) extracts a window from the regional map centred on a settlement and refines it to city resolution (5m cells, vs ~200m regional cells):

- **Elevation** — bilinear interpolation from regional grid, refined with 3-octave Perlin noise (2m amplitude) for local detail
- **Slope** — recomputed via central difference after elevation refinement
- **Water mask** — seeded from sea level threshold on the refined elevation
- **Rivers** — imported as vector polylines from regional river paths, smoothed with Chaikin subdivision
- **Regional settlements** — filtered to those within city bounds, used as nucleus seeds
- **Flood zones** — precomputed grid for building exclusion

From these inherited layers, setup also computes:
- Water classification (river/estuary/ocean) and water depth (BFS)
- Terrain suitability (composite of elevation, slope, water, flood risk)
- Initial land value
- **Nuclei** — growth centre seeds placed on buildable land, starting with the settlement location and nearby regional settlements, then greedy placement up to a tier-based cap (10-20)

## Archetype Selection

Before growth ticks run, the settlement is scored against all five archetypes (in `archetypeScoring.js`). The best-fitting archetype is selected and passed to the development strategy. The archetype controls how tick 5 ([[land-reservation]]) allocates land — budget shares, reservation order, placement weights, and growth modes.

## Growth Ticks

The **LandFirstDevelopment** strategy runs 7 ticks sequentially. Each tick is a pure pipeline function that reads layers from the map and writes new ones.

### Tick 1: Build Skeleton Roads

Builds the arterial road network connecting nuclei via minimum spanning tree and A* pathfinding. Writes `roadGrid` and `bridgeGrid` layers, road features, and a planar graph for routing.

### Tick 2: Compute Land Value

Recomputes land value with a nucleus-aware formula:
- 60% local flatness (average slope within 15m)
- 40% proximity to nearest nucleus (200m falloff)
- Up to 0.15 waterfront bonus (within 50m of water)

### Tick 3: Extract Development Zones

Identifies buildable areas suitable for development:
1. Voronoi assignment of cells to nearest nucleus
2. Threshold filtering (land value > 0.15, buildability > 0.15, slope < adaptive limit)
3. Morphological close (2-cell dilate + erode to fill gaps)
4. Flood-fill to find connected components
5. Discard zones smaller than 30 cells (~750 m²)

### Tick 4: Compute Spatial Layers

Generates five scoring layers used by land reservation:
- **Centrality** — distance falloff from nuclei (300m)
- **Waterfrontness** — inverse distance to water (100m range)
- **Edgeness** — inverse of centrality
- **Road frontage** — local road density (4-cell blur of road grid)
- **Downwindness** — position relative to prevailing wind

All layers are 0-1 floats masked by terrain suitability.

### Tick 5: Reserve Land Use

The archetype-driven step. See [[land-reservation]] for full details.

For each use type in the archetype's reservation order, scores all unreserved zone cells using placement weights, picks the highest-scoring seed, and grows a contiguous zone (radial or directional) until the budget is exhausted. Writes `reservationGrid` (uint8: 0=none, 1=commercial, 2=industrial, 3=civic, 4=open space).

### Tick 6: Layout Ribbons

Places parallel streets within each development zone:
- Orientation determined by terrain slope (contour-following if slope > 0.1, otherwise radial toward nucleus)
- Spine street through zone centroid
- Parallel streets at variable spacing: ~30m near nucleus (dense urban), ~40m mid-range, ~50m at edges (suburban)
- Cross streets every 80-100m where parallels overlap
- Streets clipped against water and existing roads

### Tick 7: Connect to Network

Connects each zone's spine to the skeleton road network via A* pathfinding. Adds collector roads (8m width, max 500m path length) and updates the planar graph for routing.

## Source Files

| File | Role |
|------|------|
| `src/city/setup.js` | Tick 0: regional inheritance, terrain refinement, nucleus placement |
| `src/city/strategies/landFirstDevelopment.js` | Strategy orchestrator (tick sequencing) |
| `src/city/pipeline/buildSkeletonRoads.js` | Tick 1 |
| `src/city/pipeline/computeLandValue.js` | Tick 2 |
| `src/city/pipeline/extractZones.js` | Tick 3 |
| `src/city/pipeline/computeSpatialLayers.js` | Tick 4 |
| `src/city/pipeline/reserveLandUse.js` | Tick 5 |
| `src/city/pipeline/layoutRibbons.js` | Tick 6 |
| `src/city/pipeline/connectToNetwork.js` | Tick 7 |
| `src/city/archetypes.js` | Archetype definitions |
| `src/city/archetypeScoring.js` | Archetype auto-selection |
