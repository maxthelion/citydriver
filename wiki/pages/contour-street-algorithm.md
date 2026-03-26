---
title: "Contour Street Algorithm"
category: "algorithms"
tags: [streets, ribbons, contour, terrain, organic, algorithm]
summary: "How organic terrain-following streets are generated within a zone — elevation-based face segmentation, cross street sweeps, distance-indexed junction matching."
last-modified-by: user
---

## What It Does

The contour street algorithm generates organic street patterns that follow terrain. Given a [[zones|zone]] with elevation data, it produces:

- **Cross streets** (magenta in renders) — lines running uphill/downhill through the zone
- **Parallel streets** (cyan) — lines connecting junctions on adjacent cross streets, approximately following contour lines
- **Junctions** (white dots) — where cross and parallel streets meet

The result looks like a hillside neighbourhood: streets run along the slope at constant elevation (parallels), connected by steeper streets running up and down (cross streets).

## The Algorithm

### Step 1: Segment the zone into terrain faces

The zone is split into regions of similar elevation using **elevation quartile bands**. Cells are assigned to one of 4 bands based on their elevation relative to the zone's quartiles (q25, q50, q75). Contiguous cells in the same band are flood-filled into faces.

Why quartiles: faces follow contour lines because all cells in a face are at similar elevation. Cross streets within a face naturally run uphill (perpendicular to contours). Parallel streets connecting same-index junctions on adjacent cross streets naturally follow contours (same elevation band).

Minimum face size: 500 cells. Smaller fragments are discarded (this can leave gaps — see known issues below).

### Step 2: Compute gradient direction per face

For each face, compute the average elevation gradient — the direction that goes most steeply uphill. This is done by sampling the elevation difference between neighbouring cells and averaging the gradient vectors.

The **contour direction** is perpendicular to the gradient — along the hillside at constant elevation.

### Step 3: Sweep cross streets along the contour axis

Cross streets are placed at regular intervals (90m) along the contour axis. For each cross street position:

1. Define a line running in the gradient direction (uphill) at this contour offset
2. Walk along the line at half-cell steps
3. Test each point: is it inside this face?
4. Keep the longest contiguous run of in-face points
5. If the run is long enough (>20m), it becomes a cross street

The result: evenly-spaced cross streets running uphill through the face, clipped to the face boundary.

### Step 4: Place junctions along cross streets

Walk each cross street measuring horizontal arc-length distance. Every 35m (PARALLEL_SPACING), mark a junction point. Record its position, elevation, and sequential index (0, 1, 2, ...).

### Step 5: Connect junctions between adjacent cross streets

For each pair of adjacent cross streets (sorted by contour offset), connect junction index N on street A to junction index N on street B. This produces **parallel streets** — approximately contour-following lines connecting same-position junctions on adjacent uphill streets.

**Gradient filter:** If the elevation difference between two connected junctions would create a grade steeper than 15%, skip the connection. This prevents steep diagonal streets where contours curve sharply between adjacent cross streets.

### Step 6: Post-processing

After all faces are processed:

1. **Parallel separation filter** — remove any parallel street within 5m of another (prevents bunching at face boundaries)
2. **Self-crossing removal** — detect crossing segment pairs from different faces, remove the shorter one
3. **Road clipping** — truncate streets at existing road cells, creating T-junctions instead of crossings

## Parameters

| Parameter | Value | Meaning |
|-----------|-------|---------|
| CROSS_SPACING | 90m | Distance between cross streets along the contour axis |
| PARALLEL_SPACING | 35m | Arc-length between junction points along cross streets |
| MIN_STREET_LEN | 20m | Minimum length for any street segment |
| Min face size | 500 cells | Faces smaller than this are discarded |
| Max gradient | 15% | Parallel connections steeper than this are rejected |
| Min parallel separation | 5m | Parallels closer than this are removed |

## How It Relates to Real Cities

On a real hillside:
- **Main roads** (our cross streets) zigzag or switchback up the slope
- **Residential streets** (our parallels) run along the contour at constant elevation — this is how terraced housing works
- **Blocks** are the areas between adjacent parallel streets, fronted by the road on each side

The spacing parameters roughly match real suburban development: 90m between main uphill roads, 35m between residential streets (enough for two rows of houses back-to-back with gardens).

## Known Issues

See `docs/superpowers/specs/2026-03-25-k3-quality-issues.md` for detailed analysis. Summary:

1. **Junction matching on irregular faces** — when adjacent cross streets have very different lengths, same-index junctions can be at very different positions. Produces missing or poor-quality parallels.

2. **Face coverage gaps** — cells at elevation quartile boundaries may not belong to any face. These areas get no streets.

3. **Streets crossing water** — the algorithm doesn't check for water cells mid-segment. A street can bridge over a narrow river.

4. **Separation filter too weak** — checks midpoint only, misses streets that are close at one end but diverge.

These are quality issues suitable for [[petri loop|experiment-loop]] iteration — try variations and check against strengthened invariant tests.

## Origin

This algorithm was developed through experiments 007a-007k3, iterating from simple terrain splitting through gradient walks and contour tracing to the current approach. Key milestones:

- **007g**: Contour-line streets — good parallels but cross streets were a mess
- **007h**: Terrain face segmentation — the key breakthrough (split by slope)
- **007i**: Gradient-direction cross streets within faces
- **007k3**: Distance-indexed junctions — the current algorithm (no elevation snapping, sequential index matching)

## Future Direction

This batch-generate-then-filter approach is being replaced by [[incremental-street-layout]] — an algorithm that lays streets one at a time, validating each against rules before continuing. The incremental approach eliminates the post-processing gaps and quality issues described above by catching problems before they propagate.

The [[terrain-face-streets]] page describes a related design where each face's top/bottom edges are subdivided explicitly. The incremental approach incorporates this idea through construction lines connected to anchor roads.

## Related

- [[terrain-face-streets]] — the target design for per-face street layout
- [[spatial-concepts]] — where ribbons fit in the zone → parcel → ribbon → plot hierarchy
- [[zones]] — this algorithm operates within zones
- [[plots]] — plots are cut from land between parallel streets
- [[road-hierarchy]] — contour streets are local/residential hierarchy
- [[world-state-invariants]] — geometry rules the output should satisfy
