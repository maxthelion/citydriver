# Pipeline Issues — 2026-03-24

Found during zone extraction investigation and petri loop experimentation.

## Pipeline Issues

### 1. Tree-skeleton produces no graph faces (DESIGN)
The skeleton is an MST — trees have no cycles, so `facesWithEdges()` finds no enclosed faces. Seeds 42 and 99 get 2 zones from graph-face extraction where flood-fill gets 70+. The initial `zones` step is useless for tree-like skeletons. Affects most seeds to some degree.

### 2. Zone-boundary roads don't fire on small zones (CHICKEN-AND-EGG)
`createZoneBoundaryRoads` requires zones >= 1000 cells. But graph-face zones are often tiny or empty (because no cycles). So no zone-boundary roads are added, no cycles are created, and zones-refine has to do all the work via flood-fill.

### 3. `forceFloodFill` workaround still in pipeline (TECH DEBT)
`zones-refine` explicitly uses flood-fill because graph faces are known to be unreliable after zone-boundary roads. The old flood-fill code path should be removable once graph integrity is solid. Currently two extraction methods coexist.

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

Issues 1 and 2 are the root cause of most zone extraction problems. Fix the skeleton to have cycles (or use flood-fill for initial zones), and everything downstream improves.
