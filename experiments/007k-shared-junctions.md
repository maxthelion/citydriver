# 007k — Shared junction points on cross streets — continuous contour lines

## Goal

Fix contour streets so they pass straight through cross street junctions instead
of jogging. Mark junction points on each cross street **once** at fixed elevation
intervals, then both sides of the junction use the same pre-committed points.

## Problem with 007j

In 007j, each adjacent cross street pair (A, B) generated its endpoint independently:

- The parallel from A placed a source point at, say, elevation 14.3 m and then
  found the closest elevation-matched point on B.
- The parallel from B found a *different* starting point on B when generating
  the segment B→C at the same nominal contour level.

Because the two operations sampled the cross street B independently, the landing
point of A→B and the departure point of B→C were at different positions on B.
The contour line **jogged** at every cross street junction rather than passing
straight through.

## New approach

### Step 1 — Generate cross streets (same as 007i)

Gradient-direction sweep lines clipped to the face, at `CROSS_SPACING` intervals
along the contour axis.

### Step 2 — Mark shared junction points on every cross street

Walk each cross street at `ELEV_SAMPLE = 1 m` steps and build a dense elevation
profile. At every consecutive sample pair, detect crossings of integer multiples
of `ELEV_INTERVAL` (e.g. 2 m, 4 m, 6 m …). For each elevation key the **first**
crossing position is recorded; subsequent crossings for the same key are ignored.

The result is a `junctionMap: elevKey → {x, z}` for each cross street.

### Step 3 — Connect matching elevation keys between adjacent cross streets

For each adjacent pair (A, B):
```
for each elevKey in A.junctionMap that also exists in B.junctionMap:
  draw parallel from A.junctionMap[key] to B.junctionMap[key]
```

Because both endpoints are the same pre-committed points on each cross street,
the outgoing end of segment A→B is exactly the same pixel as the incoming end of
segment B→C. The contour line is **continuous** — no jogs.

### Why this works

The elevation key is a shared global integer (`Math.floor(elevation / ELEV_INTERVAL)`).
Any two cross streets that span the same elevation will independently produce a
junction at that key. The key is the identity — no per-pair negotiation required.

## Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CROSS_SPACING` | 90 m | Spacing between cross streets along the contour axis |
| `ELEV_INTERVAL` | 2 m | Elevation difference between adjacent junction levels |
| `ELEV_SAMPLE` | 1 m | Walk step size for the elevation profile |
| `MIN_FACE_CELLS` | 500 | Minimum cells to retain a face |
| `MIN_STREET_LEN` | 20 m | Skip degenerate segments shorter than this |

## Results (seed 884469:27:95)

- Zone: 40 421 cells, avgSlope = 0.163
- Elevation quartiles: q25 = 16.7 m, q50 = 39.4 m, q75 = 67.4 m
- **6 terrain faces** (same segmentation as 007i/007j)
- **71 cross streets** (same as 007i/007j — cross street logic unchanged)
- **693 parallel streets** generated (vs 269 in 007j — more because 2 m elevation
  intervals give more junction levels per face than 35 m gradient-offset spacing)
- **801 junction points** recorded across all cross streets
- Runtime: ~9.0 s

Face breakdown:

| Face | Band | Cells | Cross streets | Parallel streets |
|------|------|-------|---------------|-----------------|
| 0 | 1 | 2 604 | 6 | 45 |
| 1 | 0 | 10 105 | 20 | 116 |
| 2 | 2 | 1 150 | 4 | 24 |
| 3 | 1 | 7 501 | 15 | 138 |
| 4 | 2 | 8 955 | 14 | 162 |
| 5 | 3 | 9 974 | 12 | 208 |

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
| Cyan (1 px) | Parallel streets — contour followers via shared elevation keys |
| Red dot (1 px) | Junction points — elevation-level crossings on each cross street |
| Yellow (1 px) | Zone boundary |
| Grey | Existing road skeleton |

## Observations

Contour lines now pass straight through cross street junctions because both the
incoming and outgoing parallel meet at the **same pre-committed red dot** on the
cross street. Where the two segments visually meet, they are at exactly the same
pixel — no jog.

The 2 m elevation interval produces more parallel streets than 007j (693 vs 269)
because it responds to absolute terrain height rather than a fixed gradient-axis
spacing. Steep faces with tight contours generate many closely-spaced parallels;
gentle faces generate fewer, more widely spaced ones.

Street density automatically scales with slope gradient — this matches how real
hillside terracing works.

## Next steps

- Tune `ELEV_INTERVAL`: try 3–4 m if the dense terracing is too fine for
  buildable plots.
- Extend parallels that dead-end at zone boundaries by connecting the last
  junction on the outermost cross street directly to the boundary.
- Merge adjacent parallel street segments that share endpoints into polylines
  for the road graph.
- Apply a minimum block-length filter to avoid very short inter-junction segments
  (visible when contours are nearly parallel to a cross street).
