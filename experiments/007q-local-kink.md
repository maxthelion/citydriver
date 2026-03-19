# 007q — Local kink: gradient interior with perpendicular approach near roads

## Goal

Test the "local kink" approach from the street-direction-compromise design. Cross
streets follow the terrain gradient direction for most of their length, but bend
sharply near anchor roads to meet them at right angles. Like a chicane or dogleg.

## Approach

For each terrain face (same elevation-band flood-fill as 007i):

### 1 — Compute gradient direction (same as 007i)

Average the per-cell elevation gradient across the face using central differences.
Normalise to get a unit uphill vector `(gradX, gradZ)`. Contour direction is
`(-gradZ, gradX)`.

### 2 — Sweep straight cross streets

Sweep cross street lines at CROSS_SPACING intervals along the contour axis,
running in the gradient direction. Clip each line to the longest contiguous
in-face run at half-cell step resolution. This is identical to 007i.

### 3 — Post-process: apply kink near anchor roads

For each endpoint of each clipped cross street:

1. Scan the roadGrid within KINK_RADIUS (50 m / 10 cells) for road cells.
2. If a road cell is found, compute the road direction at that cell by summing
   4-connected neighbour vectors on the roadGrid.
3. Derive the road perpendicular. Pick the sign that faces toward the gradient
   direction (so the kink curves toward the road, not away).
4. Walk from the endpoint inward for KINK_CELLS (10) steps. At each step blend
   the walking direction from pure gradient (at the hinge point) toward the road
   perpendicular (at the endpoint), using linear interpolation:
   ```
   t = k / numKinkSteps   (0 at hinge, 1 at endpoint)
   dir = normalise((1-t) * gradient + t * roadPerp)
   ```
5. Replace the endpoint region of the cross street's point list with the kinked
   positions.

Result: `[straight gradient section] → [short blended bend] → [road]`

### 4 — Mark junction points on the kinked cross street

Mark PARALLEL_SPACING junction points anchored to multiples of PARALLEL_SPACING
along the original gradient offset range. Each junction point is sampled from
the kinked run by parameter interpolation.

### 5 — Connect corresponding junction points → parallel streets

Sort cross streets by contour offset. For adjacent pairs, match points sharing
the same gradient offset and connect them as parallel street segments.

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CROSS_SPACING` | 90 m | Spacing between cross streets along the contour |
| `PARALLEL_SPACING` | 35 m | Spacing between parallel junction points |
| `KINK_RADIUS` | 50 m | Distance from road at which kink begins |
| `KINK_CELLS` | 10 | Number of cells blended over (= KINK_RADIUS / cellSize) |
| `MIN_STREET_LEN` | 20 m | Skip degenerate segments shorter than this |

## Results (seed 884469:27:95)

- Zone: 40 304 cells, avgSlope = 0.163
- Elevation quartiles: q25 = 16.8 m, q50 = 39.5 m, q75 = 67.5 m
- **6 terrain faces** (same segmentation as 007i)
- **72 cross streets** generated
- **234 parallel streets** generated
- Runtime: ~9.5 s

Face breakdown:

| Face | Band | Cells | Cross streets | Parallel streets |
|------|------|-------|---------------|-----------------|
| 0 | 1 | 3 305 | 8 | 21 |
| 1 | 0 | 10 076 | 20 | 52 |
| 2 | 2 | 1 361 | 4 | 7 |
| 3 | 1 | 6 771 | 14 | 46 |
| 4 | 2 | 8 714 | 14 | 56 |
| 5 | 3 | 9 928 | 12 | 52 |

## Rendering legend

| Colour | Meaning |
|--------|---------|
| Green tint | Face 0 (band 1) |
| Blue tint | Face 1 (band 0) |
| Orange tint | Face 2 (band 2) |
| Purple tint | Face 3 (band 1) |
| Cyan tint | Face 4 (band 2) |
| Pink tint | Face 5 (band 3) |
| White pixels | Face boundary cells |
| White (2 px) | Anchor road skeleton |
| Magenta (1 px) | Cross streets — gradient interior with kinks near roads |
| Cyan (1 px) | Parallel streets — connect same-offset points on adjacent cross streets |
| Yellow (1 px) | Zone boundary |

## Observations

Cross streets show a straight gradient-following body that bends over the last
50 m as they approach anchor roads. The kink is visible as a short diagonal
dogleg just before the road. The perpendicular approach direction is determined
by the actual road cell neighbourhood, so the bend aligns to whatever direction
the road is running at that junction point.

Parallel streets are derived from junction points sampled along the kinked cross
streets. Where the kink shifts a cross street endpoint laterally relative to its
pre-kink trajectory, adjacent parallel street endpoints may also shift, producing
slightly irregular parallel spacing near roads. In the interior the parallels
remain well-spaced and contour-following.

Street counts are similar to 007i (72 cross vs 71, 234 parallel vs 234) because
the face clipping logic is unchanged; the kink only modifies endpoint positions
after clipping.

## Comparison to other approaches

| Approach | Interior | Junction | Complexity |
|----------|----------|----------|------------|
| 007i pure gradient | gradient | awkward angle | low |
| 007n road axis | road-perp | right angle | low |
| 007o straight compromise | blended | blended angle | low |
| 007p smooth curve | gradient→perp | right angle | medium |
| **007q local kink** | **gradient** | **right angle** | **medium** |

Local kink gives the cleanest separation: the interior is optimised for terrain
(gradient-following, good for walking) and only the last 50 m adapts to the road.
The trade-off is the visible dogleg, which may read as organic/hilly character
or as awkward depending on the context and kink severity.

## Next steps

- Tune KINK_RADIUS and KINK_CELLS; a shorter kink (30 m, 6 cells) may be less
  visually jarring while still achieving a near-perpendicular junction.
- Vary blend curve: linear interpolation produces a curved dogleg; a step function
  at the midpoint would produce a sharper single-angle bend.
- Consider snapping the kinked endpoint to the nearest road cell rather than
  stopping 50 m from it; this would close the gap between the kink and the road.
- Evaluate all three compromise approaches (007o, 007p, 007q) side-by-side on
  the same zone to select the preferred character for each archetype.
