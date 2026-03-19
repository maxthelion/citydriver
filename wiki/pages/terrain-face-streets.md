---
title: "Terrain Face Streets"
category: "algorithms"
tags: [terrain, streets, ribbons, zones, slope, contour]
summary: "Street layout by segmenting zones into terrain faces with consistent slope, then laying contour-following streets and uphill cross streets within each face."
last-modified-by: user
---

## Core Idea

Real cities on hills are composed of distinct terrain faces — each with consistent slope direction and steepness. Each face gets a street pattern suited to its character. The boundaries between faces (ridges, valleys, grade breaks) are where major roads naturally run.

## How It Works

### 1. Segment zones into terrain faces

Within each development zone, detect where slope direction or steepness changes significantly. Split the zone along these boundaries into sub-zones, each representing a terrain face with uniform slope character.

A terrain face has:
- Consistent slope direction (within ~30°)
- Consistent steepness (within a band: flat, moderate, steep)
- A clear "top edge" (uphill boundary) and "bottom edge" (downhill boundary)
- Side edges connecting top to bottom

### 2. Per-face street layout

Each face gets streets based on its character:

| Steepness | Parallel streets | Cross streets | Character |
|-----------|-----------------|---------------|-----------|
| Flat (< 0.05) | Regular grid toward nearest road | Regular grid perpendicular | Uniform blocks |
| Moderate (0.05-0.2) | Contour-following ribbons | Uphill at regular intervals | Terraced housing |
| Steep (0.2-0.35) | Tight contour terraces | Fewer, switchback access | Dense hillside |
| Very steep (> 0.35) | Not developable | — | — |

### 3. Cross streets from edge subdivision

For sloped faces:
1. Identify the **bottom edge** (downhill boundary) and **top edge** (uphill boundary)
2. Subdivide both edges at regular intervals (e.g. every 90m)
3. Connect corresponding points between top and bottom — these connections go straight uphill and become cross streets
4. The parallel/contour streets are then drawn between adjacent cross streets at the desired plot depth

This is similar to experiment 007e's gradient walk, but with the key improvement: by splitting into faces first, each face's top and bottom edges are well-defined, so the cross streets are straight and parallel rather than fanning irregularly.

### 4. Face boundaries become roads

The boundaries between adjacent terrain faces are natural locations for roads:
- **Ridge roads** — along the top of a face
- **Valley roads** — along the bottom between two faces
- **Grade break roads** — where steepness changes

These face-boundary roads connect to the zone boundary roads (from experiment 004) and the arterial skeleton.

## Relationship to Experiments

| Experiment | What it tested | Relevant finding |
|---|---|---|
| 007a | Zone splitting where slope varies | Splitting helps — separate faces get separate ribbon directions |
| 007d | Cross-street-first layout | Consistent spacing from measured grid points — good for flat faces |
| 007e | Gradient uphill walk | Good cross street direction on slopes, but doesn't cover flat areas |
| 007f | Multi-edge inward walk | Full coverage but radial/starburst pattern |
| 007g | Contour tracing | Parallel streets follow terrain perfectly, but cross streets were a mess |

The terrain face approach combines the best findings:
- From 007a: split zones where terrain varies
- From 007e: cross streets go uphill from bottom to top edge
- From 007g: parallel streets follow contour lines within each face
- From 007d: measured grid points ensure consistent spacing

## Implementation Notes

### Face detection

Sample slope direction at a grid of points across the zone. Cluster adjacent cells with similar slope direction into faces. Boundaries between clusters become face edges. This is essentially a slope-direction segmentation.

### Edge classification

For each face, classify boundary segments:
- **Bottom edge**: boundary where the terrain is at its lowest (downhill side)
- **Top edge**: boundary where terrain is highest (uphill side)
- **Side edges**: boundaries connecting top to bottom (roughly along the slope direction)

### Street generation within a face

1. Subdivide bottom edge at regular intervals → starting points
2. Subdivide top edge at same intervals → ending points
3. Connect corresponding start/end points → cross streets (uphill)
4. Between adjacent cross streets, draw parallel lines at plot-depth spacing → contour streets
