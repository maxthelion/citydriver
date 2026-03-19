# 007p — Smooth curve

## Goal

Test the "smooth curve" approach from the street-direction-compromise design:
cross street direction varies along its length. Near anchor roads the direction
is road-perpendicular. In the interior it follows the terrain gradient. Smooth
transition between the two based on distance to the nearest road cell.

## Approach

### Per-face algorithm

1. **Gradient direction** — average per-cell elevation gradient across the face
   (same as 007i).
2. **Road perpendicular** — find nearest arterial/collector road segment to face
   centroid; take the perpendicular direction, oriented to align with the
   gradient (so it never flips downhill).
3. **Road-distance BFS** — single BFS from every road cell in the crop region,
   storing metres-to-nearest-road in a Float32Array.
4. **Sweep origins** — at CROSS_SPACING (90 m) intervals along the contour axis
   (same sweep as 007i), find the first in-face cell near each sweep point.
5. **Walk the cross street** — from each origin, walk both the positive and
   negative gradient directions cell by cell:
   - Look up road distance for current cell.
   - Compute blend: `blend = min(1, roadDist / BLEND_RADIUS)` — 0 at road, 1
     beyond BLEND_RADIUS (200 m).
   - Apply GRID_BIAS (0.5): `roadWeight = GRID_BIAS * (1 - blend)`.
   - Target direction: `normalize(roadWeight * roadPerp + (1 - roadWeight) * gradient)`.
   - Pick the 8-connected face-interior neighbour with the best dot product
     toward target direction.
   - Walk until leaving face or MAX_WALK_STEPS exceeded.
   - Cross street = combined polyline from negative + positive directions.
6. **Junction points** — walk the polyline measuring arc-length; record a
   junction every PARALLEL_SPACING (35 m) metres, keyed by sequential index
   (same as 007k3).
7. **Parallel streets** — connect index-N junctions between adjacent cross
   streets in the same face.

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `GRID_BIAS` | 0.5 | Road influence strength (0 = pure gradient, 1 = pure perp) |
| `BLEND_RADIUS` | 200 m | Full gradient direction beyond this distance |
| `CROSS_SPACING` | 90 m | Spacing between sweep origins along contour axis |
| `PARALLEL_SPACING` | 35 m | Junction point spacing along walk arc-length |
| `MIN_STREET_LEN` | 20 m | Skip degenerate segments |
| `MAX_WALK_STEPS` | 2000 | Guard against infinite loops |

## Results (seed 884469:27:95)

- Zone: 40 421 cells, avgSlope = 0.163
- Elevation quartiles: q25 = 16.7 m, q50 = 39.4 m, q75 = 67.4 m
- 6 terrain faces
- Road BFS: 114 948 cells visited
- **45 cross streets** (walked polylines)
- **264 parallel streets**
- Runtime: ~9.5 s

Face breakdown:

| Face | Band | Cells | Nearest road dist | Cross streets | Parallel streets |
|------|------|-------|-------------------|---------------|-----------------|
| 0 | 1 | 2 604 | 121.3 m (collector) | 5 | 18 |
| 1 | 0 | 10 105 | 47.3 m (collector) | 11 | 86 |
| 2 | 2 | 1 150 | 59.7 m (collector) | 3 | 6 |
| 3 | 1 | 7 501 | 273.2 m (collector) | 11 | 53 |
| 4 | 2 | 8 955 | 293.5 m (collector) | 8 | 48 |
| 5 | 3 | 9 974 | 169.7 m (collector) | 7 | 53 |

## Rendering legend

| Colour | Meaning |
|--------|---------|
| Green tint | Face 0 (band 1) |
| Blue tint | Face 1 (band 0) |
| Orange tint | Face 2 (band 2) |
| Purple tint | Face 3 (band 1) |
| Cyan tint | Face 4 (band 2) |
| Pink tint | Face 5 (band 3) |
| Faint white | Face boundary cells |
| White (2 px) | Road grid |
| Magenta (1 px) | Cross streets — walked polylines, curved near roads |
| Cyan (1 px) | Parallel streets — index-matched between adjacent cross streets |
| Yellow (1 px) | Zone boundary |

## Observations

The cell-by-cell walk with per-cell direction blending produces cross streets
that visibly curve: they approach roads at a direction closer to road-
perpendicular, then bend toward the terrain gradient as they move into the
interior. The effect is strongest for faces near roads (faces 1 and 2 at 47–60 m
distance) and weaker for faces far from roads (faces 3 and 4 at 270–290 m,
beyond the 200 m blend radius, so they behave like pure gradient streets).

The 8-connected walk picks neighbours greedily by best dot product at each step,
so on very coarse terrain the walk can steer into dead ends where all forward
neighbours are already visited. The `bestDot < 0` guard terminates the walk
rather than backtracking, which can shorten some streets on irregular faces.

Junction count and parallel coverage (264 parallels from 45 cross streets) is
broadly similar to 007k3, confirming the index-keyed matching continues to work
with curved walks.

## Comparison with 007o (straight compromise)

007o uses a single blended direction per face (fixed for the whole street).
007p walks cell by cell so each street curves as it crosses the blend zone. The
practical difference is visible near roads: in 007o all cross streets in a face
run at the same blended angle; in 007p streets that start near a road are
steeper (more perpendicular) at the near end and flatten out toward the gradient
direction deeper in the face.

## Next steps

- Try BLEND_RADIUS values (100 m, 300 m) to calibrate how far the road
  influence reaches.
- Experiment 007q: local kink — contour interior with a sharp bend only within
  ~50 m of an anchor road.
- Consider using per-cell gradient (not face-average gradient) for the walk
  direction computation to get genuinely contour-following behaviour in the
  interior.
- Investigate backtracking or beam-search to avoid premature termination on
  irregular faces.
