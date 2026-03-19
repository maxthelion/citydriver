---
title: "Street Direction Compromise"
category: "algorithms"
tags: [streets, terrain, roads, grid, compromise, gridBias]
summary: "How streets resolve competing pressures from terrain contours and anchor road perpendicularity, controlled by a gridBias parameter."
last-modified-by: user
---

## The Problem

At any point in a zone, street direction has three competing influences:

1. **Terrain contour** — streets want to follow contours on slopes (level for walking/driving)
2. **Road A perpendicular** — streets want to meet nearby road A at right angles (traffic flow, plot layout)
3. **Road B perpendicular** — streets want to meet nearby road B at right angles

These rarely agree. A hillside zone between two roads meeting at 60° can't satisfy all three at once.

## The gridBias Parameter

A single parameter `gridBias` (0.0 to 1.0) controls the compromise:

- **0.0** — pure terrain-following. Streets follow contours exactly. Road junctions are at whatever angle results.
- **0.5** — balanced. Streets blend terrain and road influences. Smooth curves where they conflict.
- **1.0** — pure grid. Streets are perpendicular to nearest road regardless of terrain. Planned city character.

Different archetypes use different values:
- Organic hill town: 0.1-0.2
- Market town: 0.3-0.4
- Grid town: 0.8-0.9
- Industrial town: 0.5-0.6

## Three Transition Approaches

### Straight compromise
Pick one blended direction for each street and keep it straight. Direction is:
```
dir = normalize(gridBias * roadPerp + (1 - gridBias) * contourDir)
```
Simple. The angle is a fixed compromise everywhere along the street. Wrong near one road, wrong near the other, but consistent.

### Smooth curve
The street direction varies along its length. Near road A, direction is weighted toward A-perpendicular. In the interior, direction follows contour. Near road B, toward B-perpendicular.
```
At position P:
  weightA = proximity(P, roadA) * gridBias
  weightB = proximity(P, roadB) * gridBias
  weightTerrain = 1 - weightA - weightB
  dir = normalize(weightA * perpA + weightB * perpB + weightTerrain * contourDir)
```
Natural-looking curves. More complex to implement. Streets are no longer straight lines.

### Local kink
Streets follow contour for most of their length. Within ~50m of an anchor road, they bend sharply to meet it at right angles. The interior is pure terrain-following, only the junction adapts.

Like a chicane or dogleg. Keeps the interior pattern optimal for terrain. Only the road junction is compromised.

## Influence Weighting

Proximity-based: each influence's weight falls off with distance from the source.

- Road influence: strongest within ~100m of the road, zero beyond ~200m
- Terrain influence: constant everywhere (terrain is everywhere)
- The falloff curve could be linear, Gaussian, or step function

The `gridBias` parameter scales the road influence:
- At gridBias=0, road influence is zero regardless of proximity
- At gridBias=1, road influence at proximity=0 is 1.0 (fully perpendicular)

## Future Consideration

This parameter could be driven by the archetype or even vary spatially — more grid-like near the city centre (where roads are more important), more terrain-following at the periphery (where terrain dominates). A bitmap layer `gridBias` could be composed like other spatial layers.

## Experiments

- 007o: straight compromise with gridBias parameter
- 007p: smooth curve (direction varies along street length)
- 007q: local kink (contour interior, perpendicular last 50m near roads)
