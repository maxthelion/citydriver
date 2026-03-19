# 007g — Contour-line streets

## Goal

Generate parallel streets by tracing actual elevation contour lines through a
zone. Contour lines are level surfaces by definition, making this the most
terrain-authentic approach to street layout.

## Approach

1. Find the elevation range within the selected zone (min → max).
2. At every 2 m of elevation gain, trace the contour line through the zone.
3. For each contour level `h`: scan all zone cells, collect cells where the
   elevation crosses that level (cell elevation ≥ h with at least one
   4-connected zone-neighbour whose elevation < h).
4. Chain crossing cells into polylines using BFS over 8-connected neighbours.
5. Simplify each polyline with Ramer-Douglas-Peucker (tolerance 15 m).
6. Discard segments shorter than 40 m.
7. Generate cross streets by sampling the lower contour at 90 m intervals,
   then connecting each sample to the nearest point on the upper contour
   (if within 200 m).

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CONTOUR_INTERVAL` | 2 m | Elevation step between contour levels |
| `RDP_TOLERANCE` | 15 m | Simplification tolerance |
| `MIN_SEGMENT_LEN` | 40 m | Minimum useful contour segment |
| `CROSS_SPACING` | 90 m | Interval between cross-street samples |
| `MAX_CROSS_DIST` | 200 m | Maximum reach for a cross-street connection |

## Results (seed 884469:27:95)

- Zone: 40 421 cells, elevation range 0.4 – 155.6 m (155 m total)
- 75 contour levels with valid segments, 110 total simplified segments
- 20 856 cross-street connections generated
- Runtime: ~9.3 s

## Rendering legend

| Colour | Meaning |
|--------|---------|
| Cyan (3 px) | Contour streets |
| Magenta (2 px) | Cross streets connecting adjacent contours |
| Yellow (1 px) | Selected zone boundary |
| White | Existing road skeleton |
| Green tint | Selected zone |

## Observations

The contour-tracing approach produces streets that sit exactly on level ground,
which is physically accurate. With a 155 m elevation range and 2 m intervals
the zone generates 75 populated contour levels, giving dense coverage on steep
terrain and sparser coverage on gentler slopes.

The BFS chaining of contour cells can produce fragmented segments on wide, gently
sloping terrain because many cells simultaneously straddle a level — the BFS
naturally groups them, but the RDP step is critical to keep the resulting
polylines manageable. The 40 m minimum-length filter removes isolated noise
cells at the zone margin.

Cross-street density is driven purely by the CROSS_SPACING parameter and the
elevation step: with 2 m intervals nearly every pair of adjacent contour levels
is connected, which can produce a very dense cross-street network on shallow
slopes. Increasing CONTOUR_INTERVAL to 5–10 m, or filtering cross streets to
every Nth contour pair, would thin the network to a more realistic grid.

## Next steps

- Filter cross streets to every 2nd or 3rd contour pair to reduce density.
- Snap contour-street endpoints to the zone boundary so streets read as
  continuous through-routes rather than floating segments.
- Merge nearly-coincident parallel segments (same elevation band, < 5 m apart).
