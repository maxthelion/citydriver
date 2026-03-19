# 007h — Terrain face segmentation

## Goal

Segment the selected zone into terrain faces (sub-zones with consistent slope)
using elevation-band splitting. For each face, find the top and bottom boundary
edges, subdivide them at regular intervals, connect corresponding points as
uphill cross streets, and fill between adjacent cross streets with
contour-following parallel streets.

## Approach

### Face segmentation

Compute the 25th, 50th and 75th percentile elevation across all zone cells.
This divides the elevation range into four bands. Flood-fill each band with
4-connectivity to produce connected face components. Discard faces with fewer
than 500 cells.

### Edge classification

For each face:
1. Collect all boundary cells (cells with at least one 4-connected neighbour
   outside the face).
2. Sort boundary cells by elevation.
3. Lower 40 % of boundary cells → **bottom edge** (downhill side).
   Upper 40 % of boundary cells → **top edge** (uphill side).
4. Convert each edge cell set to an ordered polyline by sorting along the
   dominant axis (whichever of X or Z spans more cells).

### Cross streets (uphill connections)

Subdivide the bottom and top polylines at CROSS_SPACING = 90 m intervals,
producing the same number of points on each edge. Connect the i-th bottom
point to the i-th top point — these are the uphill cross streets.

### Parallel streets (contour-following)

Between each adjacent pair of cross streets, interpolate at regular
PARALLEL_SPACING = 35 m depth intervals along both cross streets and connect
the corresponding points. These are the contour-parallel streets.

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CROSS_SPACING` | 90 m | Interval between cross street origin points on each edge |
| `PARALLEL_SPACING` | 35 m | Depth increment between contour parallel streets |
| `MIN_FACE_CELLS` | 500 | Minimum cells to retain a face |
| `MIN_STREET_LEN` | 20 m | Skip degenerate street segments shorter than this |

## Results (seed 884469:27:95)

- Zone: 40 419 cells, avgSlope = 0.163
- Elevation quartiles: q25 = 16.7 m, q50 = 39.4 m, q75 = 67.4 m
- **6 terrain faces** produced (4 bands × flood-fill; some bands split into 2 components)
- **78 cross streets** generated
- **394 parallel streets** generated
- Runtime: ~9.4 s

Face breakdown:

| Face | Band | Cells | Avg elev | Cross streets | Parallel streets |
|------|------|-------|----------|---------------|-----------------|
| 0 | 1 | 2 611 | 26.1 m | 7 | 12 |
| 1 | 0 | 10 105 | 8.5 m | 22 | 110 |
| 2 | 2 | 1 151 | 50.8 m | 4 | 5 |
| 3 | 1 | 7 494 | 27.7 m | 15 | 67 |
| 4 | 2 | 8 953 | 53.1 m | 15 | 90 |
| 5 | 3 | 9 971 | 91.1 m | 15 | 110 |

## Rendering legend

| Colour | Meaning |
|--------|---------|
| Green tint | Band 0 (lowest elevation) faces |
| Blue tint | Band 1 faces |
| Orange tint | Band 2 faces |
| Purple tint | Band 3 (highest elevation) faces |
| White pixels (2 px) | Face boundary cells |
| Magenta (3 px) | Uphill cross streets |
| Cyan (3 px) | Contour-following parallel streets |
| Yellow (1 px) | Zone boundary |
| Grey | Existing road skeleton |

## Observations

Elevation-band splitting cleanly partitions the zone. Some bands (0, 1, 2)
produce two disconnected components because higher-elevation bands physically
separate the lower ones — this is expected on a hillside and produces
naturally separate terraced sectors.

The edge-classification approach (bottom 40% / top 40% by elevation) gives
reasonable bottom and top polylines on gently sloping faces. On steeply sloping
faces the bottom and top edges are well-separated. The dominant-axis sort is a
simple but effective way to impose order on what is otherwise an unordered cloud
of boundary cells.

Cross streets connect bottom to top with straight segments. Because the
corresponding-point interpolation is uniform, the streets are evenly spaced
along the face — exactly the desired regular-grid character.

Parallel streets fill the strips cleanly. The spacing (35 m) translates to
roughly 3–5 parallel streets per strip on a 90 m-wide strip, which matches a
realistic block depth for terraced housing.

## Next steps

- Replace the dominant-axis sort with a proper convex-hull or boundary-trace
  order so edge polylines wrap smoothly around concave face boundaries.
- Snap cross-street endpoints to the actual face boundary rather than the
  approximate sorted polyline.
- Promote face-boundary cells to road segments so face edges become formal
  roads connecting to the arterial skeleton.
- Add per-face steepness detection: very steep faces (> 0.35 avgSlope) skip
  development and show as undeveloped hillside.
