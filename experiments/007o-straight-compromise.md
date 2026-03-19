---
title: "007o — Straight Compromise"
experiment: "007o"
date: "2026-03-19"
seed: 884469
script: render-ribbon-straight-compromise.js
tags: [streets, terrain, gridBias, compromise, anchor-road]
---

## Goal

Test the "straight compromise" approach from the `street-direction-compromise` wiki page. Each face picks one blended cross-street direction and keeps all streets in that face straight. The blend is:

```
crossDir = normalize(GRID_BIAS * roadPerp + (1 - GRID_BIAS) * gradientDir)
```

Three images are rendered at bias 0.0, 0.5, and 1.0 to show the spectrum from pure terrain to pure grid.

## Method

Based on 007i's face segmentation + gradient cross streets, with modifications:

1. Pre-compute terrain gradient per face (same as 007i).
2. Find the nearest arterial/collector road segment to the face centroid.
3. Compute road perpendicular: rotate road direction 90°. Flip to align with gradient (avoid anti-gradient).
4. Blend: `crossDir = normalize(GRID_BIAS * roadPerp + (1 - GRID_BIAS) * gradientDir)`.
5. Use 007k3's distance-indexed junction approach (35m arc-length spacing, sequential index key) for parallel streets.

The gradient and nearest road lookup are computed once per face; only the blend changes between runs.

## Results

Seed 884469, 6 terrain faces, 79 anchor roads (30 041 segments).

| Bias | Cross streets | Parallel streets |
|------|--------------|-----------------|
| 0.0  | 72           | 230             |
| 0.5  | 69           | 219             |
| 1.0  | 62           | 204             |

At bias 0.0 cross streets run along the terrain gradient (uphill), producing the most streets because the direction is best aligned with the face geometry. At bias 1.0 cross streets are perpendicular to the nearest road; coverage drops slightly because the fixed road-perpendicular direction clips fewer cells per sweep line.

## Images

- `ribbon-zone-bias0-seed884469.png` — pure terrain (magenta cross streets follow uphill gradient)
- `ribbon-zone-bias05-seed884469.png` — balanced blend
- `ribbon-zone-bias10-seed884469.png` — pure grid (cross streets perpendicular to nearest road)

Rendering key: face tints (coloured zones), cross streets magenta (1px), parallel streets cyan (1px), nearest anchor road white (2px), zone boundary yellow (1px).

## Observations

- The direction shift is clearly visible when comparing bias 0 vs bias 1: at bias 0 streets run perpendicular to contours; at bias 1 they rotate to align with road perpendiculars.
- At bias 0.5, directions are intermediate — the compromise is visible as a slight rotation from pure terrain but not fully snapped to road orientation.
- Street count decreases with higher bias because road-perpendicular directions are less well-aligned with face shapes, producing shorter sweep intersections.
- The white anchor road lines reveal which road each face is being pulled toward.

## Next

- 007p: smooth curve — direction varies continuously along street length, blending toward road perpendicular near junctions.
- 007q: local kink — follow terrain interior, bend sharply only within ~50m of road.
