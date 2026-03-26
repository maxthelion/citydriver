# Experiment 013: Incremental Street Layout Skeleton

## Previous state
Contour street algorithm (007k3 approach) generates all streets in a batch then post-processes. Quality issues with junction matching, face gaps, and crossing violations.

## Hypothesis
An incremental approach — lay one street, validate, create parcel, repeat — should produce cleaner output with no post-processing gaps.

## Changes
New render script `render-incremental-streets.js` implementing the incremental layout:
1. Construction lines placed along gradient direction at 90m intervals
2. Parallel streets placed incrementally between construction lines at 35m intervals
3. Per-street validation: minimum length, no water crossing, no road crossing, angle check
4. Per-parcel validation: minimum dimensions, not a sliver

## Results

| Seed | Zone | Construction | Parallels | Parcels | Failed |
|------|------|-------------|-----------|---------|--------|
| 884469 | 0 | 20 | 263 | 245 | 0 |
| 884469 | 1 | 8 | 36 | 31 | 0 |
| 884469 | 2 | 18 | 47 | 44 | 0 |
| 42 | 0 | 11 | 80 | 76 | 0 |
| 42 | 1 | 16 | 97 | 91 | 1 |
| 42 | 2 | 11 | 16 | 15 | 0 |
| 12345 | 0 | 11 | 145 | 139 | 0 |
| 12345 | 1 | 16 | 395 | 381 | 0 |
| 12345 | 2 | 17 | 235 | 219 | 0 |

Only 1 failed parcel across all seeds. Good coverage on most zones, though some zones have areas with construction lines but no parallels (coverage issue to iterate on).

This is the skeleton for petri loop iteration. Known areas for improvement:
- Perpendicular anchor road blend (currently not implemented)
- Coverage of irregular zone shapes
- Dynamic spacing based on angle
- Contour-following street curves (currently straight)

## Decision
KEEP — working skeleton ready for petri iteration
