# Road Merge & Bridge Splice Fix — Design

## Problem

The road pipeline produces duplicate overlapping roads and disconnected bridges due to two bugs:

1. **Merge bug:** `mergeRoadPaths` walks each path independently and deduplicates by segment key (first+last cell). When two paths share cells but split at different points, the overlap point extends one segment past the other, producing a different key. Both segments get emitted — two overlapping polylines through the same corridor, rendered as grey + black ribbons.

2. **Bridge bug:** `placeBridges` creates a standalone 2-point `[bankA, bankB]` feature perpendicular to the river but never modifies the original road. The original road still crosses the river at its original angle. The bridge is a disconnected stub.

These bugs cascade into graph issues (crossing edges, shallow angles) that ~400 lines of symptom-patching code tries to resolve (`resolveShallowAngles`, `resolveCrossingEdges`, `compactRoads` parallel detection).

## Fix 1: Cell-graph merge (replace `mergeRoadPaths`)

Replace the walk-each-path approach with a cell-graph approach:

1. Build a combined cell graph from all paths:
   - Each cell used by any path is a node
   - Two cells get an edge if they appear consecutively in any path
   - Each node stores which paths use it (membership set)

2. Identify junction nodes — any node where:
   - Degree ≠ 2 (endpoints, branches)
   - Membership set differs from a neighbor's membership set

3. Walk between junctions to extract segments:
   - Start at each junction, walk along edges until hitting another junction
   - Each segment emitted exactly once (mark edges as visited)
   - Hierarchy derived from best path using those cells (same as current)

This eliminates duplicate segments by construction. The `_snapPaths` step in `buildRoadNetwork` stays as-is.

## Fix 2: Bridge splice into triggering road

When a road-water crossing is detected:

1. Find the triggering road's polyline and locate the water entry/exit points (closest polyline points to the crossing entry/exit)
2. Compute perpendicular bridge banks (existing `findBridgeBanks` logic)
3. Split the road polyline into three parts:
   - **Before water:** `[...originalPoints, entryPoint]`
   - **Bridge:** `[entryPoint, bankA, bankB, exitPoint]`
   - **After water:** `[exitPoint, ...originalPoints]`
4. Replace the single road feature with the reassembled polyline
5. No separate bridge feature, no landing spur pathfinding

Spacing enforcement and scoring stay the same.

## Fix 3: Remove symptom-patching code

With proper merge and bridge splicing, remove:

- `compactRoads` parallel-road detection (pass 2a endpoint-duplicate + pass 2b near-parallel) — ~70 lines
- `resolveShallowAngles` + all helpers (`_orientedPoly`, `_polyLenCalc`, `_pointAtDist`, `_projectOntoPolyline`, `_trimWeakPoly`) — ~200 lines
- `resolveCrossingEdges` — ~30 lines
- Multi-pass resolver loop in `buildSkeletonRoads` — ~10 lines
- `connectLandingToRoads` + `_gridPathToPolyline` + `_simplifyRDP` + `_ptSegDistSq` in bridges.js — ~100 lines

Keep: `compactRoads` pass 1 (endpoint snapping + short-road removal), `rebuildGraphFromRoads`.

## Testing

1. **mergeRoadPaths unit tests:**
   - Two paths sharing a middle section → no duplicate segments
   - Three paths forming a Y-junction → 3 segments meeting at junction
   - Path that's a subset of another → single segment
   - No shared cells → separate segments preserved

2. **Bridge splicing tests:**
   - Road crossing water → polyline modified with perpendicular detour
   - Bridge bank positions on land
   - Multiple crossings on same road → both spliced

3. **Integration:** Existing skeleton tests still pass
