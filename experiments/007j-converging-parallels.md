# 007j — Elevation-matched parallel streets (converging at junctions)

## Goal

Fix the parallel street (cyan) layout from 007i so that contour-following streets
**converge at cross street junctions** rather than running in perfectly parallel offset
lines.

## Problem with 007i

In 007i the Nth source point on cross street A was connected to the Nth source point
on cross street B, where "Nth" was defined by the same fixed `PARALLEL_SPACING`
gradient-axis offset. Because both sets of points were placed at identical gradient
offsets, the connecting lines were perfectly parallel to each other — the gradient
offset spacing was the same on both cross streets regardless of local terrain.

On a real hillside, contour lines converge where terrain is steep (elevation changes
rapidly per unit of gradient distance) and diverge where terrain is gentle. Using
fixed-offset matching lost this geometry.

## New approach

For each adjacent cross street pair (A, B):

### 1 — Place source points on A only

Mark points along cross street A at `PARALLEL_SPACING` intervals anchored to
multiples of `PARALLEL_SPACING` (same snapping rule as 007i, but only applied to A).

### 2 — Read elevation at each source point

For each source point P on A, read the terrain elevation at P by converting its
world position back to grid coordinates and calling `elev.get(gx, gz)`.

### 3 — Sample cross street B at fine resolution

Sample cross street B at `ELEV_STEP = 1 m` intervals and record `(wx, wz, elevation)`
at each sample. This gives a dense piecewise-linear elevation profile along B.

### 4 — Find elevation-matched point on B

Search the samples of B for the interval where elevation crosses the target value.
If found, interpolate linearly within that interval to get point Q on B at exactly
the same elevation as P.

If the elevation of B never reaches the target (the cross street does not span that
contour), skip the parallel — it simply does not exist here.

### 5 — Connect P to Q

Draw a parallel street from P to Q. Because Q is at the same elevation as P, the
resulting street is a true contour-follower that bends to match local terrain rather
than being constrained to a fixed transverse offset.

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CROSS_SPACING` | 90 m | Spacing between cross streets along the contour axis (same as 007i) |
| `PARALLEL_SPACING` | 35 m | Spacing between source points on cross street A |
| `ELEV_STEP` | 1 m | Sampling resolution for elevation profile along cross street B |
| `MIN_FACE_CELLS` | 500 | Minimum cells to retain a face (same as 007i) |
| `MIN_STREET_LEN` | 20 m | Skip degenerate segments shorter than this |

## Results (seed 884469:27:95)

- Zone: 40 398 cells, avgSlope = 0.163
- Elevation quartiles: q25 = 16.7 m, q50 = 39.4 m, q75 = 67.4 m
- **6 terrain faces** (same segmentation as 007i)
- **71 cross streets** generated (same as 007i — cross street logic unchanged)
- **269 parallel streets** generated (vs 234 in 007i)
- Runtime: ~9.0 s

Face breakdown:

| Face | Band | Cells | Cross streets | Parallel streets |
|------|------|-------|---------------|-----------------|
| 0 | 1 | 2 915 | 7 | 17 |
| 1 | 0 | 10 099 | 20 | 67 |
| 2 | 2 | 1 242 | 4 | 6 |
| 3 | 1 | 7 185 | 14 | 52 |
| 4 | 2 | 8 856 | 14 | 63 |
| 5 | 3 | 9 959 | 12 | 64 |

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
| Magenta (1 px) | Cross streets — run straight uphill |
| Cyan (1 px) | Parallel streets — elevation-matched, converge/diverge with terrain |
| Yellow (1 px) | Zone boundary |
| Grey | Existing road skeleton |

## Observations

The elevation-matching approach produces parallel streets that visibly converge
where terrain is steep between two cross streets and spread apart where it is
gentle. Instead of a uniform grid of cyan lines, the spacing along each cross
street now reflects the local contour density of the terrain.

The parallel count increased slightly (269 vs 234 in 007i) because elevation
matching can connect points even when the two cross streets do not share an
identical gradient-axis offset range — a source point on A will find a match on B
as long as B spans that elevation, regardless of where on B the matching point falls.

The `ELEV_STEP = 1 m` sampling along cross street B is fine enough to resolve
sub-cell elevation variation without being expensive (cross streets are typically
60–300 m long, so 60–300 samples per pair).

## Next steps

- Smooth the junction angles at both endpoints so parallel streets arrive
  tangentially rather than at an arbitrary angle set by the two-point straight line.
- Handle cases where a cross street has a non-monotone elevation profile (small
  local reversals); currently only the first crossing is used.
- Extend to multi-match: if the elevation profile of B crosses the target twice,
  pick the crossing whose resulting street is shortest (most direct contour path).
