---
title: "Bitmap Pipeline Model"
category: "architecture"
tags: [bitmaps, layers, pipeline, gpu, spatial-layers, Grid2D]
summary: "How the city generator uses composable bitmap layers as its core data model, the different layer types, and principles for working with them."
last-modified-by: user
---

## Core Principle

Everything that can be a bitmap should be. Spatial data flows through the pipeline as Grid2D layers that are composed, blurred, thresholded, and scored against. This makes the pipeline debuggable (every intermediate state is a viewable image) and composable (new behaviour comes from combining existing layers, not writing special-case code).

## Layer Types

### Static Layers

Computed once during setup or early pipeline stages. Don't change after creation.

| Layer | Computed By | Type | Description |
|-------|-------------|------|-------------|
| elevation | setupCity | float32 | Terrain height |
| slope | setupCity | float32 | Terrain gradient steepness |
| waterMask | setupCity | uint8 | Binary: water vs land |
| waterType | setupCity | uint8 | Categorical: sea/lake/river/land |
| waterDist | setupCity | float32 | Distance from land to water |
| waterDepth | setupCity | float32 | Distance from shore into water |
| terrainSuitability | setupCity | float32 | 0-1 terrain suitability (slope + elevation); replaces old buildability layer |

### Derived Layers

Computed from other layers, usually via blur or composition. Computed once after their inputs are ready.

| Layer | Computed By | Inputs | Description |
|-------|-------------|--------|-------------|
| landValue | computeLandValue (tick 2) | slope, waterDist, terrainSuitability, nuclei | Economic value gradient |
| centrality | computeSpatialLayers (tick 4) | nuclei, terrainSuitability | Proximity to settlement centres |
| waterfrontness | computeSpatialLayers (tick 4) | waterDist, terrainSuitability | Proximity to water |
| edgeness | computeSpatialLayers (tick 4) | centrality, terrainSuitability | Inverse centrality (how far from centre) |
| roadFrontage | computeSpatialLayers (tick 4) | roadGrid, terrainSuitability | Proximity to roads (blurred) |
| downwindness | computeSpatialLayers (tick 4) | wind direction, terrainSuitability | Position relative to prevailing wind |

### Stateful Layers

Written to and read from at multiple pipeline stages. Accumulate state over time.

| Layer | First Written | Updated By | Description |
|-------|---------------|-----------|-------------|
| roadGrid | buildSkeletonRoads (tick 1) | layoutRibbons, connectToNetwork | Binary: road cells |
| bridgeGrid | buildSkeletonRoads (tick 1) | — | Binary: bridge cells |
| zoneGrid | extractZones (tick 3) | — | Zone ID per cell |
| reservationGrid | growth ticks (tick 5+) | growth ticks | Categorical: zone use type (commercial, industrial, etc.) |

### Dynamic Per-Tick Layers

Recomputed each growth tick because their source data changes as the city grows.

| Layer | Computed By | Source | Description |
|-------|-------------|--------|-------------|
| developmentProximity | growthTick | reservationGrid | Blur of existing development — where the city currently is |
| industrialDistance | growthTick | reservationGrid (industrial cells) | Inverse blur of industrial zones — high = far from industry |

These follow the exact same bitmap pattern as the static derived layers (blur a binary mask, normalise). The only difference is they're recomputed because their inputs change each tick.

## Composition Patterns

### Blur (proximity gradient)

Take a binary mask, apply box blur, normalise to 0-1. Produces a smooth gradient showing proximity to the masked feature. Used for: waterfrontness, roadFrontage, developmentProximity, industrialDistance.

### Inverse (distance/avoidance)

Compute a proximity gradient then invert (1 - normalised value). High values mean far away. Used for: edgeness (inverse centrality), industrialDistance (inverse industrial proximity).

### Weighted sum (scoring)

Score a cell by taking the weighted sum of multiple layer values at that point. The weights (affinities) determine which layers matter most for a given use type. Used for: agent seed placement, agent spread scoring, land reservation scoring.

```
score = affinity.centrality * centrality.get(x, z)
      + affinity.roadFrontage * roadFrontage.get(x, z)
      + affinity.developmentProximity * developmentProximity.get(x, z)
```

### Threshold (eligibility)

Apply a cutoff to a continuous layer to produce a binary mask. Used for: development eligibility (developmentProximity > threshold), buildability constraints.

### Mask multiplication

Multiply two layers together to combine constraints. A cell must score well on both layers. Used for: terrain suitability multiplied into spatial layers (centrality × terrainSuitability).

## Land Value is Per-Use-Type

There is no single universal "land value". Each use type values different things:

| Use Type | Values | Avoids |
|----------|--------|--------|
| **Industrial** | Flat land, space, arterial roads, ports, rail, edge of city | Centre, steep terrain |
| **Residential** | Elevation, centrality, waterfront, quiet streets | Industrial proximity |
| **Commercial** | Busy central streets, road frontage, footfall | Edges, dead ends |
| **Civic** | Centrality, road access, prominence | — |
| **Open space** | Waterfront, hilltops, edges | — |

The current single `landValue` layer is a generic computation (flatness + nucleus proximity + water bonus). This is useful as a baseline but doesn't capture use-specific value.

In practice, the **affinity weights are the per-use land value function**. When a commercial agent scores a cell with `{ centrality: 0.6, roadFrontage: 2.0 }`, that IS commercial land value — computed on the fly from composing spatial layers. The generic `landValue` layer could be retired or treated as just one more input layer that some agents weight.

Residential value being depressed by industrial proximity is handled by the `industrialDistance` dynamic layer — residential agents weight it positively (high = far from industrial = good), while industrial agents ignore it.

## Design Rules

1. **If it's spatial data, make it a layer.** Don't compute distances, proximities, or gradients inline in algorithm code. Compute them as a layer, then score against the layer.

2. **Agent behaviour comes from affinity weights, not code branches.** Commercial sticks to roads because `roadFrontage` affinity is 2.0, not because there's a road-search loop. Industrial avoids residential because `industrialDistance` affinity is high.

3. **Dynamic layers follow the same pattern as static ones.** `developmentProximity` is computed the same way as `waterfrontness` — blur a mask, normalise. The only difference is when it's computed.

4. **Parameterise, don't hardcode.** Blur radii, thresholds, and weights should be in archetype config, not in pipeline code. Different archetypes may need different blur radii for the same layer.

5. **Every layer should be inspectable.** If you can't visualise it in the debug screen or bitmap logger, it's not a proper layer. This is how we debug the pipeline — by looking at what each layer contains at each step.

## Future: GPU Acceleration

The bitmap operations (blur, distance transform, BFS flood, mask composition) are the main performance bottleneck. A 1200×1200 grid at 5m cell size means 1.44M cells. Box blur at radius 40 touches ~1.44M × 81 = 116M cell reads per pass.

These operations are embarrassingly parallel and map well to GPU compute shaders (WebGL/WebGPU). Candidates for GPU acceleration:

- **Box blur / Gaussian blur** — separable, each output pixel independent
- **Distance transforms** — parallel jump flooding algorithm
- **Binary mask operations** — threshold, multiply, invert
- **Scoring** — weighted sum of N layers at each cell

The Grid2D data is already flat typed arrays (Float32Array, Uint8Array) which map directly to GPU buffer formats. A future optimisation pass could move the hot-path operations to shaders while keeping the same layer-based API.
