# k3 Street Quality Issues

Found by visual inspection of experiment 012e output (seed 42 zone 1 in particular).

These are quality issues in the k3 organic street algorithm. The invariant test framework catches some but not all of them. They're good candidates for petri loop iteration — try variations and adversarially check with the visual judge.

## Issue 1: Junction matching fails on irregular cross streets

**Symptom:** Green face top-left of seed 42 zone 1 — cross streets exist but very few parallels connect them. Some faces have good parallels, others have almost none.

**Root cause:** Index-based matching connects junction N on cross street A to junction N on cross street B. But when adjacent cross streets have different lengths (because the face is irregularly shaped), index N on one may be at a completely different position than index N on the other. The result: either no match (indices don't exist on the shorter street) or a diagonal connection that doesn't follow contours.

**Why elevation matching didn't work either:** Pure elevation matching created long diagonal zigzags — connecting a junction at the left end of one cross street to one at the right end of the next, just because they were at the same height.

**What would work:** A hybrid approach. Match by index first. If the resulting connection would be too long (> 1.5× the expected CROSS_SPACING), try index ±1. If all candidates are too long or too steep, skip. The key constraint: the parallel must be roughly perpendicular to the cross streets (within ±30°), short (< 1.5× CROSS_SPACING), and not too steep (< 15% gradient).

**Invariant to test:** "Every face with >= 2 cross streets should produce at least 1 parallel per cross street pair." Currently some face pairs produce zero parallels.

## Issue 2: Gaps between elevation quartile faces

**Symptom:** Dark unfilled areas in the centre of zones where no streets are generated. These are areas between terrain faces that don't belong to any face.

**Root cause:** Elevation quartile boundaries are sharp thresholds (q25, q50, q75). Cells right at the threshold can end up assigned to one band by floating-point rounding but adjacent to a cell in a different band. When faces are flood-filled, thin strips of cells at band boundaries may not meet the minimum face size (500 cells) and get discarded.

**What would work:** After face extraction, assign orphan cells (cells in the zone but not in any face) to the nearest face. Or use overlapping bands with soft boundaries. Or reduce the minimum face size for cells adjacent to existing faces.

**Invariant to test:** "Every zone cell should be covered by a terrain face." Currently some cells are in no face.

## Issue 3: Streets crossing water/unbuildable terrain

**Symptom:** Cyan parallel streets crossing what appears to be a river or unbuildable area in the centre of seed 42 zone 1.

**Root cause:** k3 generates streets within a face's cells, but a face can contain cells adjacent to water or unbuildable terrain. The cross street sweep doesn't check individual cells along the street for water/road obstacles — it only checks if the endpoints are in the face. A street can bridge over a narrow water feature or unbuildable strip.

**What would work:** Walk each generated street segment cell by cell and split at water/unbuildable cells. Same approach as the road-clipping fix but checking waterMask and terrain suitability, not just roadGrid.

**Invariant to test:** "No k3 street segment passes through water or unbuildable cells." The current road-clipping check only looks at roadGrid, not waterMask.

## Issue 4: Parallel separation filter too weak

**Symptom:** Cyan streets running too close together on the right side and centre of seed 42 zone 1, despite the 5m separation filter.

**Root cause:** The filter checks midpoint-to-segment distance. Two streets that are close at one end but diverge can pass the midpoint check even though they're within 5m for part of their length. Also, the filter only runs on parallels — cross streets from different faces can also be too close.

**What would work:** Check multiple points along each segment (start, midpoint, end at minimum) against all other nearby segments. Or sample at regular intervals. Also extend the check to cross streets, not just parallels.

**Invariant to test:** "No two k3 street segments are within 5m of each other at any point along their length." The current test checks midpoint only.

## How Petri Could Help

These are quality-tuning problems — the algorithm works but the output isn't good enough. Each issue has multiple possible fixes with different trade-offs. This is exactly the petri loop's sweet spot:

1. **Baseline:** Current k3 output with 17/18 invariant tests passing
2. **Hypothesise:** Try a variation on junction matching, face coverage, water clipping, or separation
3. **Evaluate:** Run the strengthened invariant tests (tier 2) + visual judge (tier 3)
4. **Keep or reject:** Based on whether invariant violations decrease AND visual quality improves

The invariant tests need to be strengthened first (better separation check, water crossing check, face coverage check). Then petri can iterate against those tests.

## Strengthened Invariant Tests Needed

| Test | Currently | Should be |
|------|-----------|-----------|
| Parallel separation | Midpoint distance check | Multi-point distance check along full length |
| Water crossing | Not checked | Walk each segment, check waterMask |
| Face coverage | Not checked | Every zone cell in a face |
| Junction matching quality | Only elevation gradient | Also check parallel count per cross-street pair |
| Self-crossings | Checked | Working ✅ |
| Road crossings | Checked | Working (with road clipping) ✅ |
| Elevation consistency | Checked | Working (with gradient filter) ✅ |
