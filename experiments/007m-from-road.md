# 007m — Cross streets from anchor road junctions

## Goal

Cross streets should leave anchor roads at right angles, then curve to follow
terrain as they penetrate deeper into the face. Current experiments produced
cross streets that met anchor roads at steep arbitrary angles.

## Problem with 007i

In 007i cross streets were swept along the contour axis at CROSS_SPACING
intervals without any relation to the existing road network. The street grid
had no geometric connection to the anchor roads — streets could emerge from
the middle of a face at any angle to adjacent roads.

## Approach

For each terrain face:

### 1 — Face gradient

Same as 007i: accumulate per-cell elevation gradients, average and normalise
to get the face's dominant uphill unit vector `(gradX, gradZ)`. Contour axis
`(ctX, ctZ) = (-gradZ, gradX)`.

### 2 — Find nearest anchor road

Search `map.roads` for arterial and collector roads within `ANCHOR_RADIUS`
(400m) of the face centroid. Select the single nearest road (by centroid
distance) and collect all of its segments within the radius. Orient each
segment's perpendicular toward the face centroid.

### 3 — Sample starting points on the road

Sample the road at `CROSS_SPACING` (90m) intervals. Deduplicate samples by
contour-axis bucket (one bucket per 90m slot) so that closely-spaced segments
of the same road don't produce overlapping walks.

### 4 — Find face entry point

For each road sample point, march along the road-perpendicular direction
(half-cell steps, up to `ANCHOR_RADIUS` distance) until a face cell is
reached. This is the actual walk start.

### 5 — Walk into the face with blended direction

From the face entry point, walk step-by-step:

```
blend = min(1, distFromEntry / BLEND_DIST)   // 0→1 over first 200m
dir   = normalize((1 - blend) * roadPerp + blend * gradientDir)
```

At each step, pick the 8-connected in-face neighbour with the best dot
product against `dir`. Stop when no valid neighbour remains or `MAX_STEPS`
(600) is reached. A visited-cell set prevents cycling.

Near the road the street runs perpendicular to the road. Beyond 200m it
follows the terrain gradient.

### 6 — Junction points and parallel streets

Mark junction points at `PARALLEL_SPACING` (35m) intervals along each walk
(measured from the entry point). Sort walks by contour-axis projection of
their entry point. Connect matching junction offsets between adjacent walks
(contour-projection gap ≤ `CROSS_SPACING * 2`) → parallel streets.

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CROSS_SPACING` | 90 m | Spacing between walks along anchor road |
| `PARALLEL_SPACING` | 35 m | Spacing between parallel streets along walk |
| `BLEND_DIST` | 200 m | Distance over which direction transitions from road-perp to gradient |
| `ANCHOR_RADIUS` | 400 m | Max distance from face centroid to road to qualify |
| `MAX_STEPS` | 600 | Safety cap on walk length |
| `MIN_STREET_LEN` | 15 m | Skip degenerate segments |

## Results (seed 884469:27:95)

- Zone: ~40 400 cells, avgSlope = 0.163
- 6 terrain faces, 79 anchor roads (arterial/collector)
- 39 starting points on roads
- ~2 200 cross street segments
- ~256 parallel streets

Face breakdown:

| Face | Band | Cells | Walks | Parallel |
|------|------|-------|-------|----------|
| 0 | 1 | 2 924 | 6 | 23 |
| 1 | 0 | 10 100 | 7 | 86 |
| 2 | 2 | 1 246 | 4 | 9 |
| 3 | 1 | 7 176 | 9 | 35 |
| 4 | 2 | 8 853 | 6 | 28 |
| 5 | 3 | 9 960 | 7 | 75 |

Runtime: ~9s

## Rendering legend

| Colour | Meaning |
|--------|---------|
| Green/blue/etc tint | Terrain face (same bands as 007i) |
| White pixels | Face boundary cells |
| White (3px) | Anchor road segments near each face |
| Red dots | Starting points on anchor roads |
| Magenta (1px) | Cross streets — perpendicular to road at start, curving to gradient |
| Cyan (1px) | Parallel streets — connecting corresponding junction points |
| Yellow (1px) | Zone boundary |
| Grey | Existing road skeleton |

## Observations

Cross streets now originate at measurable intervals along the anchor road and
leave perpendicular to it. The `findFaceEntry` march correctly handles faces
that are set back from their anchor road (up to ~300m away in this seed).

The blended direction walk produces noticeably curved streets: they run
straight off the road for the first 50-100m, then gradually bend to follow
the terrain's steepest ascent. This matches the real-world pattern of
suburban streets leaving a highway.

Parallel streets form closed grid cells where adjacent walks have sufficient
overlap. Sparser faces (Face 2, small) produce fewer parallels as expected.

Contour-bucket deduplication (`Math.round(contourProj / CROSS_SPACING)`)
effectively prevents multiple road segments in the same area from spawning
redundant walks.

## Next steps

- Incorporate walk polylines as actual road features in the city graph.
- Apply the algorithm to all zones, not just the selected candidate.
- Allow secondary roads (not just arterials/collectors) to be anchor sources
  once the primary road grid is established.
- Investigate smoothing the blend transition with a cubic ease rather than
  a linear ramp.
