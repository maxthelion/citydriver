# 007i — Gradient-direction cross streets

## Goal

Improve 007h's terrain face streets by using each face's **steepest gradient
direction** for cross streets instead of arbitrary top/bottom edge
correspondences. This ensures cross streets run straight uphill and parallel
streets follow contours rather than producing shallow-angle streets from
point-correspondence mismatch.

## Problem with 007h

In 007h the cross streets were formed by connecting the i-th point on the
bottom elevation-edge to the i-th point on the top elevation-edge. Because the
edge sort was based on a dominant-axis projection, the correspondence was
arbitrary and the resulting cross streets often ran at shallow angles relative
to the true gradient. Shallow cross streets meant the contour-parallel streets
were nearly parallel to them, producing over-dense clumps.

## Approach

For each terrain face (produced by the same elevation-band flood-fill as 007h):

### 1 — Compute face gradient

Accumulate per-cell elevation gradients using central finite differences
(falling back to one-sided differences at face boundary cells). Average all
per-cell gradient vectors and normalise to get the face's dominant uphill
unit vector `(gradX, gradZ)`.

### 2 — Derive axes

- **Gradient axis** (uphill): `(gradX, gradZ)` — cross streets run along this.
- **Contour axis** (perpendicular): `(-gradZ, gradX)` — cross streets are
  swept at intervals along this axis.

### 3 — Sweep cross streets

Find the face extent along the contour axis. Starting from
`ceil(minContour / CROSS_SPACING) * CROSS_SPACING`, place a cross street line
every CROSS_SPACING metres. Each cross street line runs in the gradient
direction through its sweep point. Walk cell-by-cell at half-cell steps to
find which cells the line passes through; keep the longest contiguous in-face
run as the clipped segment.

### 4 — Mark parallel street anchor points

Along each cross street segment, mark points at PARALLEL_SPACING intervals
anchored to multiples of PARALLEL_SPACING (so adjacent cross streets share the
same set of offsets).

### 5 — Connect corresponding points

Sort cross streets by their contour-axis offset. For each adjacent pair,
match points with the same gradient-axis offset and draw a parallel street
between them.

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CROSS_SPACING` | 90 m | Spacing between cross streets along the contour axis |
| `PARALLEL_SPACING` | 35 m | Spacing between parallel streets along the gradient axis |
| `MIN_FACE_CELLS` | 500 | Minimum cells to retain a face |
| `MIN_STREET_LEN` | 20 m | Skip degenerate segments shorter than this |

## Results (seed 884469:27:95)

- Zone: 40 414 cells, avgSlope = 0.163
- Elevation quartiles: q25 = 16.7 m, q50 = 39.4 m, q75 = 67.4 m
- **6 terrain faces** (same segmentation as 007h)
- **71 cross streets** generated
- **234 parallel streets** generated
- Runtime: ~8.9 s

Face breakdown:

| Face | Band | Cells | Cross streets | Parallel streets |
|------|------|-------|---------------|-----------------|
| 0 | 1 | 2 646 | 6 | 15 |
| 1 | 0 | 10 103 | 19 | 58 |
| 2 | 2 | 1 164 | 4 | 6 |
| 3 | 1 | 7 458 | 15 | 48 |
| 4 | 2 | 8 938 | 14 | 54 |
| 5 | 3 | 9 971 | 12 | 53 |

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
| Cyan (1 px) | Parallel streets — follow contours |
| Yellow (1 px) | Zone boundary |
| Grey | Existing road skeleton |

## Observations

Using the per-face gradient direction rather than edge-point correspondences
produces cross streets that consistently run in the steepest-ascent direction
of each face. The sweep-along-contour approach gives even lateral spacing
between cross streets without depending on the face having cleanly separable
top and bottom edges.

Parallel streets are sparser than 007h (234 vs 394) because the cross streets
now genuinely span the gradient range of each face, making fewer cross street
pairs overlap in gradient-offset space. The resulting grid is more regular:
cross streets are perpendicular to contours, parallels are perpendicular to
cross streets.

The cell-walk clipping (half-cell steps, longest contiguous in-face run) is
simpler than polygon clipping and handles the irregular face shapes without
the need for a boundary polygon.

## Next steps

- Promote face-boundary cells to formal road segments connecting the arterial
  skeleton.
- Allow per-face gradient fallback when the computed gradient magnitude is very
  low (flat terrace): use the zone-level `slopeDir` or a neighbouring face's
  gradient.
- Blend street angle smoothly across face boundaries to avoid abrupt direction
  changes at face edges.
- Investigate multi-step walking (full-cell steps) and whether sub-pixel
  accuracy matters for the output quality.
