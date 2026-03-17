---
title: "City Region Inheritance"
category: "pipeline"
tags: [city, pipeline, inheritance, setup, rivers, railways]
summary: "How city generation extracts and refines features from the regional map during tick 0 setup."
last-modified-by: user
---

## Overview

Cities are not generated from scratch. Tick 0 (`setupCity`) extracts a window from the regional map centred on a settlement and refines it to city resolution (5m cells, vs ~200m regional cells). This is the bridge between the [[pipelines-overview|regional pipeline]] and the [[city-generation-pipeline|city pipeline]].

## Extraction Window

The city grid is centred on the settlement's regional position, extending `CITY_RADIUS` (15) regional cells in each direction. This gives a city area of ~6km x 6km at 200m regional cell size.

World-space origin is clamped to regional data bounds. The city grid dimensions are computed from the clamped extent divided by `CITY_CELL_SIZE` (5m).

## Terrain Inheritance

- **Elevation** — bilinear interpolation from regional grid to city resolution, then refined with 3-octave Perlin noise (2m amplitude) for local surface detail that doesn't exist at regional scale
- **Slope** — recomputed via central difference on the refined elevation (not inherited, since the Perlin detail changes gradients)
- **Water mask** — seeded from sea level threshold on the refined elevation (not inherited from regional waterMask, which has coarse 200m river stamps)

## River Inheritance

Rivers are imported as vector polylines using `inheritRivers()`:

1. Regional `riverPaths` (segment tree with `{points, children}`) are walked recursively
2. Each segment's polyline is clipped to city bounds via `clipPolylineToBounds`
3. Clipped polylines are Chaikin-smoothed (1 pass) for higher-resolution curves
4. River width computed from `√accumulation` — wider downstream
5. Each clipped river added as a `'river'` feature on the FeatureMap, which stamps waterMask and carves channels

## Railway Inheritance

Railways are imported similarly using `inheritRailways()`:

1. Regional railways have `polyline` arrays in world coordinates
2. Each polyline is clipped to city bounds via `clipPolylineToBounds`
3. Clipped polylines are Chaikin-smoothed (2 passes)
4. Each clipped railway added as a `'railway'` feature on the FeatureMap, which stamps `railwayGrid` and sets buildability to 0 along the track corridor (8m total width)

### Station Placement

If railways are present, a station is placed at the nearest dry-land point along a track near the city centre:

- Sample points along all railway polyline segments
- Skip any point on water
- Pick the closest point to the settlement position
- Record position and track angle for station building alignment

The station is stored as `map.station = { x, z, angle }` and rendered as a rectangular building aligned with the track direction.

### Railway Effects on City Development

- **railwayGrid** — uint8 grid stamped where track runs, used by coverage layers for terrain colouring (gravel/ballast) and by building placement for exclusion
- **Building exclusion** — railway grid cells are marked occupied in `placeBuildings`, preventing buildings on tracks
- **Coverage layer** — `stampRailway` produces a `railway` coverage layer with ballast-coloured terrain blending

## Settlement Inheritance

Regional settlements within city bounds are filtered and converted to city grid coordinates. They serve as nucleus seeds during placement — the centre nucleus is at the settlement's own position, and nearby regional settlements become additional nuclei.

## Computed Layers

After inheritance, setup computes layers that don't exist at regional scale:

- **Water classification** — BFS from sea-level cells distinguishes sea (1), lake (2), river (3)
- **Water depth** — BFS from land into water for rendering and path costs
- **Terrain suitability** — composite of elevation, slope, water proximity, flood risk
- **Flood zones** — precomputed grid for building exclusion
- **Initial land value** — terrain-based assessment (flatness + proximity + waterfront)
- **Nuclei** — growth centre seeds placed on buildable land (10-20 per city, tier-dependent cap)

## Source Files

| File | Role |
|------|------|
| `src/city/setup.js` | Main setup function, all inheritance and computed layers |
| `src/core/inheritRivers.js` | Clip river segment trees to city bounds |
| `src/core/inheritRailways.js` | Clip railway polylines to city bounds |
| `src/core/clipPolyline.js` | Rectangle clipping with interpolated crossing points |
