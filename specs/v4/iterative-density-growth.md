# Iterative Density Growth Loop

## Status: Proposed (not yet implemented)

This spec describes a target architecture for the city growth loop. It replaces the current "sprout side streets everywhere, then extract blocks" approach with a priority-driven frontier model where development advances outward from the center one opportunity at a time.

---

## How It Differs From Current Implementation

### Current approach (`growCity.js` + `blockSubdivision.js`)

The current system works in bulk per tick:

1. **Sprout side streets** from all unsprouted edges simultaneously (up to 60/tick cap)
2. **Extract all blocks** from the full road graph via `facesWithEdges()`
3. **Subdivide all new blocks** into plots at once
4. **Extend dead ends** for nuclei below population target
5. **Split deep blocks** by adding interior roads

This is a "flood fill" model — growth happens everywhere there's an unsprouted edge, with no priority ordering. The result:
- Roads are created speculatively (side streets into empty land) before knowing if plots will succeed there
- No density gradient — every area gets the same treatment regardless of proximity to center
- The edge cap (60/tick) is an artificial brake on exponential growth rather than a principled control
- Block extraction runs on the full graph every tick
- No terrain-following street directions — side streets are always perpendicular to parent

### Proposed approach (this spec)

A priority queue drives growth one opportunity at a time:

1. **Select the highest-priority frontier opportunity** (density, hierarchy, terrain, proximity)
2. **Extend one street** into undeveloped land, with terrain-aware direction
3. **Identify new blocks** formed by that one street addition
4. **Subdivide those blocks** into plots
5. **Place buildings** and count population
6. **Update the frontier** with new opportunities

Key differences:
- **Ordered growth**: center-out, high-density-first, arterial-frontage-first
- **One street at a time**: each iteration is atomic and validatable
- **Terrain-aware directions**: streets follow contours on slopes, align to water edges
- **Density-driven plot dimensions**: narrow terraced in center, wide detached at fringe
- **Building placement in-loop**: buildings are placed per-iteration, not in a separate pass
- **Incremental validation**: each iteration can be rolled back if it fails checks

---

## What We Can Adopt Now vs. Later

### Adopt now (incremental improvements to current code)

1. **Priority-ordered frontier** instead of processing all edges equally. Sort edges by density field value + road hierarchy before sprouting. This gives center-out growth without rewriting the loop structure.

2. **Terrain checks on street direction**. When sprouting a side street, check the slope at the target point. On slopes >8%, rotate the street to follow the contour instead of going purely perpendicular. This is a small change to `sproutSideStreets`.

3. **Density-driven plot dimensions**. Read the density field at each block's centroid and vary `frontageWidth`/`plotDepth` accordingly, instead of using fixed nucleus config everywhere. Denser areas get narrower, deeper plots.

4. **Snap-to-nearby-road**. When extending a side street, check if there's an existing road within 20-40m of the target endpoint. If so, curve toward it and create a junction instead of a dead end. This replaces the separate `connectBackLanes` function with a more organic connection pattern.

5. **Minimum spacing enforcement**. Before sprouting a side street, check if there's already a branch point within 40m along the parent edge. Skip if too close. This prevents the overdense road spaghetti visible in current output.

### Adopt later (requires deeper refactoring)

1. **Single-street-per-iteration model**. The current bulk approach works but doesn't produce the natural density gradient. Moving to one-street-per-iteration requires rethinking the tick structure.

2. **In-loop building placement**. Currently buildings are placed in a separate pipeline stage (`generateBuildings`). Moving this into the growth loop means buildings exist during growth and influence subsequent road placement.

3. **Incremental face extraction**. Currently `facesWithEdges()` runs on the full graph. An incremental version that only recomputes faces affected by a new edge would be O(1) per addition instead of O(E).

4. **Priority queue with proximity scoring**. True priority ordering requires a heap data structure and the "proximity to developed" metric, which needs spatial indexing of placed buildings.

5. **Rollback on validation failure**. The current code doesn't roll back failed iterations. Adding undo capability (remove edge, restore occupancy) would let the loop recover from bad placements.

6. **Post-loop passes** (commercial rezoning via betweenness centrality, amenity placement based on final population distribution, city edge treatment).

---

## Growth Frontier Concept

The **growth frontier** is the set of road segments with undeveloped land on at least one side. It replaces the current `sproutedEdges` Set with a priority queue.

Each frontier entry has:
```
{
  edgeId: number,
  side: 'left' | 'right' | 'both',
  priority: number,        // higher = develop first
  nucleusId: number,
}
```

Priority calculation:
```
priority = density(midpoint) * 0.4
         + hierarchyWeight(edge) * 0.2
         + terrainScore(midpoint) * 0.2
         + proximityToBuilt(midpoint) * 0.2
```

Where:
- `density`: from density field, 0-1
- `hierarchyWeight`: arterial=1.0, collector=0.7, local=0.4
- `terrainScore`: flat=1.0, gentle slope=0.7, moderate=0.3, steep=0.0
- `proximityToBuilt`: inverse distance to nearest existing plot, normalized

---

## Street Direction Computation

The current system always projects side streets perpendicular to the parent edge. The spec proposes blending three directional influences:

**Arterial alignment**: nearest arterial defines a grid direction. Strong within 200m, fading beyond.

**Terrain contour**: on slopes >3 degrees, streets should follow constant-elevation contours. The gradient direction from the heightmap gives the fall line; the perpendicular is the contour direction.

**Water edge alignment**: within 100m of water, streets run parallel to the shoreline.

```
direction = normalize(
  arterialDir * arterialWeight +
  contourDir * contourWeight +
  waterDir * waterWeight
)
```

This produces streets that follow the terrain naturally rather than creating a rigid perpendicular grid everywhere.

---

## Plot Dimension Table

The spec ties plot dimensions to density field values:

| Density | Frontage | Depth | Type |
|---------|----------|-------|------|
| >0.7 | 5-8m | 15-25m | Terraced / commercial |
| 0.5-0.7 | 7-10m | 20-30m | Townhouse |
| 0.3-0.5 | 10-15m | 20-30m | Semi-detached |
| <0.3 | 15-25m | 25-40m | Detached |

Currently we use fixed dimensions from `nucleus.plotConfig`. Interpolating from the density field would create a smooth gradient from dense center to sparse fringe.

---

## Termination Conditions

The spec defines four termination conditions:

1. **Population reached**: `current_population >= target_population`
2. **Land exhausted**: frontier queue empty
3. **Iteration limit**: safety valve (10,000 iterations)
4. **Diminishing returns**: last N iterations each added < M people

Currently we only have (1) and a weaker form of (2) (`anyGrowth === false`). Adding (4) would prevent the loop spinning on marginal land.

---

## Post-Loop Passes

These run after the growth loop and are currently partially implemented:

1. **Loop closure** — existing as `connectComponents()`, could be enhanced to also close dead-end stubs within 50m of another road
2. **Amenity placement** — existing as `generateAmenities()`
3. **Commercial rezoning** — not yet implemented, requires betweenness centrality on road graph
4. **Landmark placement** — not yet implemented
5. **Green space / land cover** — existing as `generateCityLandCover()`
6. **City edge treatment** — not yet implemented
