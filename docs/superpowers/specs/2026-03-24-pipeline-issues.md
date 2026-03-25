# Pipeline Issues — 2026-03-24

Found during zone extraction investigation and petri loop experimentation.

## Pipeline Issues

### 1. Graph-face extraction only has road edges — needs all boundary types (ROOT CAUSE)
The `specs/v5/land-model.md` spec defines graph faces bounded by roads, water, map edges, railways, and planning lines. Currently only roads are in the planar graph. A tree-like skeleton (MST) has no cycles, so `facesWithEdges()` finds no enclosed faces. Adding water edges and map boundary edges to the graph would create enough faces even from a tree skeleton — each face bounded by a mix of roads and natural edges.

This is the root cause of issues 2 and 3. The land-model migration step 2 ("unify zones and graph faces") was done without step 5 ("introduce boundary types"), which it depends on.

**Fix:** Add coastline/river polylines and map boundary edges to the planar graph as non-road boundary edges. `facesWithEdges()` then produces full face coverage.

### 2. Zone-boundary roads don't fire on small zones (CONSEQUENCE OF #1)
`createZoneBoundaryRoads` requires zones >= 1000 cells. But without boundary types in the graph, graph-face zones are often tiny or empty. So no zone-boundary roads are added, no cycles are created, and zones-refine has to do all the work via flood-fill.

### 3. `forceFloodFill` workaround still in pipeline (CONSEQUENCE OF #1)
`zones-refine` explicitly uses flood-fill because graph faces are unreliable without boundary types. Once #1 is fixed and the graph produces full face coverage, the flood-fill path can be removed.

### Land-model migration incomplete
From `specs/v5/land-model.md`, the 5-step migration was partially completed:

| Step | Description | Status |
|------|-------------|--------|
| 1. Add invariant checks | Bitmap/polyline/block invariants | Partial — land-model invariants (face coverage, cell exclusivity) not done |
| 2. Unify zones and graph faces | Graph-face extraction as primary | Partial — works only when graph has cycles (needs step 5 first) |
| 3. Add bidirectional references | Road↔block O(1) lookups | Not done |
| 4. Add inset polygons | Width accounting | Not done |
| 5. Introduce boundary types | Water, map edge, rail, planning lines | Not done — **prerequisite for step 2** |

### 4. Duplicate edges — FIXED
`RoadNetwork.#addToGraph()` was adding duplicate edges with a warning. `PlanarGraph.mergeNodes()` created duplicates during skeleton-walk merge. Fixed in commit 73cc620. Seed 979728 went from 2 zones to 101.

## Testing Issues

### 5. No property tests existed — FIXED
No tests validated that the pipeline produces reasonable quantities of zones/roads. Seed 884469 regressed from 53 zones to 2 months ago with no test catching it. Level 2 property tests now written across 20 random seeds — 18/20 fail (mostly duplicate edges, now fixed, needs re-run).

### 6. Graph integrity not checked in invariants — FIXED
Duplicate edges and dangling edges weren't part of the invariant checkers. Now added to `polylineInvariants.js`.

## Experiment/Tooling Issues

### 7. `run-experiment.js` didn't pass `--step` flag — FIXED
Experiments always ran to completion. Now passes `--step` through to `render-pipeline.js`.

### 8. Zones layer rendering is confusing
Road grid, skeleton roads, zone boundaries, and zone polygon outlines all render in similar grey/white. Can't distinguish them visually. Needs colour/thickness differentiation.

## Petri Loop Issues

### 9. Fitness log grows unbounded
Subagents timeout reading 17KB+ of history. Needs auto-trimming to last ~5 entries.

### 10. Judge can't distinguish changes at current zoom
Parameter tweaks are "visually imperceptible" at the rendered zoom level. Needs either higher-zoom rendering or a metric-only promotion path.

### 11. Subagent timeouts on structural changes
10-minute timeout insufficient for large code changes to a 26KB file. Structural mutations need either longer sessions or human assist.

## Priority

Issue 1 is the root cause. The fix is NOT "add more roads" or "revert to flood-fill" — it's completing the land-model migration by adding boundary types to the graph:

1. **Add water edges and map boundary to the planar graph** (land-model step 5, partially) — this creates enough face coverage for graph-face extraction to work on any skeleton
2. **Remove `forceFloodFill`** — once face coverage is solid, one extraction method
3. **Add face coverage invariant test** — "every non-road, non-water cell belongs to exactly one graph face"
4. **Add bidirectional references** (land-model step 3) — road↔block lookups
5. **Add inset polygons** (land-model step 4) — width accounting
