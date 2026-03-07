# Shortcut Roads Between Neighborhoods

## Problem

`connectNuclei` only creates inter-nucleus roads when the road graph has
disconnected components. If the arterial skeleton already connects all
nuclei into one component (the common case), no inter-nucleus roads are
added. Two adjacent neighborhoods may be connected only via a long detour
through the arterial network.

Real cities have direct roads between nearby neighborhoods.

## Implemented algorithm

### Overview

After the MST connectivity phase, we run a multi-pass closest-neighbor
search. Each nucleus finds its nearest neighbor (by straight-line
distance), checks the detour ratio, and if it's high enough, pathfinds a
new road between them. Three passes allow each nucleus to connect to
multiple neighbors.

### Candidate selection (per-nucleus closest-neighbor)

For each nucleus, find its closest neighbor by euclidean distance,
excluding already-attempted pairs. Check:

1. `straightDist > minShortcutDist` (5 cells * cellSize) -- not already
   sharing an intersection
2. `straightDist < maxShortcutDist` (40% of map diagonal) -- reasonably
   close
3. `detourRatio > 2.0` -- graph distance is at least 2x straight-line

This is O(n^2) per pass but n < 50 nuclei so it's fine.

### Multi-pass approach

Three passes, each finding the next-closest untried neighbor per nucleus:

- **Pass 1**: Each nucleus connects to its closest high-detour neighbor
- **Pass 2**: Each nucleus tries its next-closest neighbor (skipping
  pairs attempted in pass 1, whether they succeeded or not)
- **Pass 3**: One more round for additional connectivity

All attempted pairs are tracked across passes so we always advance to
new neighbors. All accepted paths are collected and merged in one batch.

### Pathfinding: dedicated cost function

**Key design decision**: Shortcuts use `shortcutRoadCost`, NOT
`nucleusConnectionCost`. The critical difference is `reuseDiscount: 1.0`
(no discount for existing roads) vs `0.1` (90% discount).

The original approach used the same cost function as MST connections,
which strongly favors following existing roads. This caused shortcuts to
route along existing arterials instead of cutting through open space --
defeating the purpose. The paths existed in the graph but overlapped
existing roads, adding no new connectivity.

`shortcutRoadCost` settings:
- `slopePenalty: 8` -- terrain-aware but not prohibitive
- `unbuildableCost: 20` -- water/cliffs are expensive but not infinite
- `reuseDiscount: 1.0` -- no benefit from following existing roads
- `plotPenalty: 3.0` -- avoid cutting through developed plots

### Road merging

Paths go through `addMergedRoads` to deduplicate where they overlap with
existing roads. This is necessary to avoid double-rendered roads, but has
a side effect: the merge pipeline can create orphaned graph fragments
(degree-0 nodes, small disconnected components). This is handled by
running the safety-net `connectGraphComponents` after shortcuts.

### Importance / hierarchy

Shortcut importance uses the same `computeImportance` function as MST
connections. Higher-tier nucleus pairs produce collector-grade roads;
lower-tier pairs produce local roads.

## Pipeline phases in connectNuclei

```
Phase 1: Attach each nucleus to nearest road node
Phase 2: BFS component discovery + Union-Find
Phase 3: MST crossings (only if multiple components)
Phase 4: Pathfind MST connections
Phase 5: Merge MST roads via addMergedRoads
Phase 6: Safety net (connectGraphComponents -- direct edge addition)
Phase 7: Shortcut roads (multi-pass, addMergedRoads)
Phase 8: Post-shortcut safety net (cleans up merge fragments)
```

The safety net (Phases 6 and 8) uses direct `addEdge` calls instead of
`addMergedRoads` to avoid recursive fragmentation.

## Required infrastructure

### PlanarGraph.shortestPathLength(fromId, toId)

Simple Dijkstra with linear-scan priority queue. Returns total edge
polyline distance or `Infinity` if unreachable. Used to compute detour
ratios.

### shortcutRoadCost (pathCost.js)

Dedicated cost function preset with no reuse discount. See pathfinding
section above.

## Files changed

- `src/core/PlanarGraph.js` -- added `shortestPathLength(fromId, toId)`
- `src/city/connectNuclei.js` -- removed early exit, added shortcut
  phase (7) and post-shortcut safety net (8)
- `src/city/pathCost.js` -- added `shortcutRoadCost` preset
- `src/rendering/layerRenderers.js` -- connections layer shows shortcut
  candidates as red lines with detour ratio labels

## Debug visibility

The connections layer renders shortcut candidates as solid red lines with
detour ratio labels at midpoints. Nucleus positions shown as cyan dots.
Layer is visible by default at 70% opacity.

## Edge cases

- **River crossings**: `unbuildableCost: 20` makes water expensive but
  not impassable. Paths route to bridges or avoid water.
- **Steep terrain**: `slopePenalty: 8` discourages mountain crossings.
- **Merge fragmentation**: `addMergedRoads` can create orphaned nodes.
  Phase 8 safety net handles this with direct edge addition.
- **Small maps**: O(n^2) candidate search is fine for n < 50 nuclei.

## Lessons learned

1. **Reuse discount defeats shortcuts**: The biggest issue was shortcuts
   routing along existing roads instead of creating new ones. The fix was
   a separate cost function with no reuse discount.

2. **All-pairs vs closest-neighbor**: The initial O(n^2) all-pairs
   approach produced too many candidates (dense red lines everywhere).
   Per-nucleus closest-neighbor with multi-pass is more controlled.

3. **addMergedRoads creates fragments**: The merge pipeline splits and
   reconnects edges, sometimes leaving orphaned nodes. Any phase using
   `addMergedRoads` needs a follow-up connectivity check. Safety-net
   phases must use direct `addEdge` to avoid the same problem.

4. **Track attempted pairs, not just accepted**: In multi-pass, if pass 1
   rejects a pair (pathfinding failed), pass 2 must skip it too.
   Otherwise pass 2 retries the same closest neighbor forever.
