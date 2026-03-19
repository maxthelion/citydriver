# 007n — Road direction as contour axis: perpendicular cross streets guaranteed

## Goal

Replace the terrain gradient as the cross-street axis direction with the
direction of the **nearest anchor road** (arterial or collector). Cross streets
are swept perpendicular to the road direction, guaranteeing right-angle
junctions wherever they meet the anchor road network.

## Problem with 007i

In 007i the cross-street direction was derived from the per-face terrain
gradient. Because road segments are laid by the skeleton strategy following
their own logic, the gradient direction rarely aligns with the road direction.
This causes cross streets to meet anchor roads at steep angles rather than
true perpendiculars, which produces awkward T-junctions and irregular blocks.

## Approach

For each terrain face (same elevation-band flood-fill as 007h/007i):

### 1 — Find nearest anchor road segment

Iterate over all roads with `hierarchy === 'arterial'` or `'collector'`. For
each polyline segment compute the perpendicular distance from the face centroid
using clamped point-to-segment projection. Take the segment with the smallest
distance; extract its unit direction vector `(ctX, ctZ)`.

### 2 — Derive axes from road direction

- **Road / contour axis** `(ctX, ctZ)`: cross streets are swept at intervals
  along this direction (parallel streets run along it).
- **Cross-street axis** `(-ctZ, ctX)`: perpendicular to the road; cross streets
  run in this direction into the face.

### 3 — Sweep cross streets

Find the face extent along the road axis. Starting from
`ceil(minRoadProj / CROSS_SPACING) * CROSS_SPACING`, place a cross street line
every CROSS_SPACING metres. Each line runs in the cross-street direction. Walk
at half-cell steps, keep the longest contiguous in-face run as the clipped
segment.

### 4 — Mark parallel street anchor points

Along each cross street, mark points at PARALLEL_SPACING intervals anchored
to multiples of PARALLEL_SPACING (so adjacent cross streets share offsets).

### 5 — Connect corresponding points

Sort cross streets by their road-axis offset. For each adjacent pair, match
points with the same cross-street-axis offset and draw a parallel street
between them.

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CROSS_SPACING` | 90 m | Spacing between cross streets along the road axis |
| `PARALLEL_SPACING` | 35 m | Spacing between parallel streets along the cross-street axis |
| `MIN_FACE_CELLS` | 500 | Minimum cells to retain a face |
| `MIN_STREET_LEN` | 20 m | Skip degenerate segments shorter than this |

## Results (seed 884469:27:95)

- Zone: 40 421 cells, avgSlope = 0.163
- Elevation quartiles: q25 = 16.7 m, q50 = 39.4 m, q75 = 67.4 m
- **6 terrain faces** (same segmentation as 007i)
- **64 cross streets** generated
- **223 parallel streets** generated
- Anchor roads found: 79 (arterial + collector)
- Runtime: ~9.0 s

Face breakdown:

| Face | Band | Cells | Cross streets | Parallel streets |
|------|------|-------|---------------|-----------------|
| 0 | 1 | 2 604 | 6 | 11 |
| 1 | 0 | 10 105 | 15 | 43 |
| 2 | 2 | 1 150 | 4 | 5 |
| 3 | 1 | 7 501 | 15 | 49 |
| 4 | 2 | 8 955 | 12 | 54 |
| 5 | 3 | 9 974 | 12 | 61 |

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
| White (3 px) | Anchor roads used as reference direction |
| Magenta (1 px) | Cross streets — perpendicular to nearest anchor road |
| Cyan (1 px) | Parallel streets — run parallel to anchor road direction |
| Yellow (1 px) | Zone boundary |
| Grey | Existing road skeleton |

## Observations

Using the nearest anchor road direction as the contour axis eliminates the
angle mismatch between cross streets and anchor roads that was present in 007i.
Cross streets are always perpendicular to the road they will eventually connect
to, producing clean T- and four-way junctions.

The street counts are slightly lower than 007i (64 cross vs 71, 223 parallel
vs 234). This is expected: the road direction and terrain gradient are rarely
identical, so a face's cross-street sweep can clip shorter or fall outside the
face more often in regions where the road and slope diverge strongly.

The trade-off is that parallel streets no longer strictly follow elevation
contours. On steeply sloping terrain with a road that runs across the slope,
the parallel streets will run along the slope rather than across it. Whether
this matters depends on the target city morphology.

## Next steps

- Blend the road-axis direction with the gradient direction using a weighting
  (e.g. road weight = f(distance to anchor)), so faces far from any road fall
  back gracefully to gradient-based streets.
- Promote face-boundary cells to formal road connections to the anchor skeleton.
- Investigate per-face nearest-road caching to reduce the O(faces × segments)
  search cost on large maps.
