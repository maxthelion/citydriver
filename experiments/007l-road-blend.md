# Experiment 007l — Blend Gradient with Road Perpendicular for Cross Street Direction

## Problem

Experiments 007i/j/k drive cross streets along the steepest gradient direction. While this
produces topographically sensible streets, they meet anchor roads (arterials/collectors) at
arbitrary angles instead of right angles. Real street networks strongly prefer perpendicular
junctions with main roads.

## Approach

For each terrain face:

1. Compute the average gradient direction (uphill) from elevation finite differences — same as 007i.
2. Find the nearest arterial or collector road segment to the face centroid (`map.roads` filtered by `hierarchy`).
3. Compute the road segment direction from its polyline, then rotate 90° to get the road perpendicular.
4. Align the road perpendicular so it points in the same half-space as the gradient (dot product sign check).
5. Blend: `crossDir = normalize(0.7 * gradientDir + 0.3 * roadPerpendicularDir)`
6. Use `crossDir` for cross streets; contour direction = perpendicular to `crossDir`.
7. Sweep, mark points, connect parallels — same as 007i.

## Render

- Magenta (1px): cross streets (blended direction)
- Cyan (1px): parallel streets (contour of blended direction)
- Yellow (1px): zone boundary
- Bright white (3px): nearest anchor road segment for each face

## Results (seed 884469:27:95)

- 6 terrain faces detected
- 70 cross streets, 229 parallel streets
- All faces found anchor roads (collector hierarchy)
- Nearest road distances: 47–292 m
- Blend values show cross streets tilted partially toward road perpendicular

## Observations

The blended cross street directions are pulled toward perpendicularity with nearby roads.
Faces close to anchor roads (dist ~47 m) show stronger correction than distant faces
(dist ~292 m) due to the fixed 0.7/0.3 weighting. The white anchor segments are visible
in the render allowing visual verification of the blending.

## Parameters

| Parameter | Value |
|-----------|-------|
| `BLEND_GRADIENT` | 0.7 |
| `BLEND_ROAD` | 0.3 |
| `CROSS_SPACING` | 90 m |
| `PARALLEL_SPACING` | 35 m |
| Anchor road hierarchy | arterial, collector |
