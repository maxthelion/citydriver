# Plan: Component-Aware Road Connectivity

Implements the approach described in `observations-road-connectivity.md`.

## Summary

Replace the flat K-nearest-neighbor connection logic in `generateRoads.js` with
a phased algorithm that guarantees full connectivity using Union-Find and
inter-cluster bridging. Add `track` hierarchy for tier 5 farm connections.

## Current State

`buildConnections()` in `generateRoads.js`:
- K-nearest per tier with hard `maxDistForTier` limits
- Proximity guarantee (pairs within 15 cells)
- Pair deduplication
- No connectivity verification — can produce disconnected components
- Tier 5 farms excluded entirely (`tier <= 4`)

## Implementation Steps

### Step 1: Add Union-Find utility

**File**: `src/core/UnionFind.js` (new)

A simple Union-Find (disjoint set) with path compression and union by rank.

```js
export class UnionFind {
  constructor(n) { ... }
  find(x) { ... }       // with path compression
  union(x, y) { ... }   // by rank, returns true if merged
  connected(x, y) { ... }
  componentCount() { ... }
  components() { ... }   // returns Map<root, [members]>
}
```

Small, self-contained, no dependencies. Used by `buildConnections()` to track
which settlements can reach each other.

### Step 2: Rewrite `buildConnections()` as phased algorithm

**File**: `src/regional/generateRoads.js`

Replace the current `buildConnections()` with a new version that runs in phases.
Each phase calls `addConnection(a, b)` which handles deduplication and hierarchy
assignment as before.

#### Phase 1 — Nearest neighbor guarantee

For every routable settlement (now tier <= 5), connect to its single nearest
routable neighbor. This guarantees zero isolates.

```
for each settlement s:
  nearest = closest other settlement by Euclidean distance
  addConnection(s, nearest)
```

After this phase, update the Union-Find with all connections so far.

#### Phase 2 — Local neighborhood

Same as current logic:
- Proximity guarantee: all pairs within 15 cells.
- K-nearest per tier (neighborsForTier: {1:5, 2:4, 3:3, 4:2, 5:1}).
- maxDistForTier: {1: 0.8*width, 2: 0.5*width, 3: 0.3*width, 4: 30, 5: 12}.

Update Union-Find after this phase.

#### Phase 3 — Cluster identification and characterization

After phases 1-2, use the Union-Find to identify connected components.
Characterize each cluster:

```js
{
  id,               // Union-Find root
  members,          // array of settlement refs
  count,            // number of settlements
  highestTier,      // min tier number (1 = most important)
  importance,       // weighted score: tier1=10, tier2=5, tier3=3, tier4=1, tier5=0.5
  centroid: {gx, gz},
}
```

If there's only one component, skip to phase 6.

#### Phase 4 — Inter-cluster bridging

Build a minimum spanning tree across clusters using Kruskal's algorithm.

For each pair of clusters (i, j):
- Find the **best crossing pair**: the pair of settlements (one from each
  cluster) that minimizes estimated path difficulty.
- Path difficulty estimate: not just Euclidean distance, but a cheap heuristic
  that accounts for terrain. Sample elevation along the straight line between
  the two settlements, compute max elevation and total ascent. Score =
  `euclideanDist * (1 + maxElevation/100 + totalAscent/200)`.
- This heuristic favours pairs that cross through passes/valleys over pairs
  that cross ridgelines.

Sort all cluster pairs by their best crossing difficulty. Walk through in
order (Kruskal's): if the two clusters are still in different components,
add the connection. This bridges them.

**Cluster size thresholds for outbound connections**:
- Cluster with 1-2 members: 1 outbound bridge
- Cluster with 3-5 members: up to 2 outbound bridges
- Cluster with 6+ members or tier 1-2 present: up to 3 outbound bridges

After the MST pass (which guarantees all clusters are connected), do a second
pass for the extra bridges based on cluster size. Sort remaining cross-cluster
pairs by difficulty and add bridges until each cluster has reached its limit.

**Hierarchy for bridge roads**:
- Bridge between clusters both containing tier 1-2: `arterial`
- Bridge between clusters with combined importance >= 6: `collector`
- All other bridges: at least `collector` (strategic connectivity role)

#### Phase 5 — Backbone verification

Assert that all tier 1-2 settlements are now in a single component. If not
(shouldn't happen after phase 4 unless a cluster was missed), add direct
connections between the disconnected tier 1-2 settlements.

#### Phase 6 — Tier 5 farm tracks

For each tier 5 farm, if it has no connection yet (shouldn't happen after
phase 1, but defensive), connect to nearest settlement. All tier 5 connections
use hierarchy `track`.

Override: any connection where **both** endpoints are tier 5 uses `track`.
Any connection where one endpoint is tier 5 and the other is tier 4 uses
`track`. If a tier 5 connects to tier 3 or above, use `local`.

### Step 3: Add `track` hierarchy support

**Files to update**:

- `src/regional/generateRoads.js`: Add `track` to the hierarchy sort order
  (`{ arterial: 0, collector: 1, local: 2, track: 3 }`). Track roads are
  processed last.

- `src/rendering/debugTiles.js`: Add color for `track` roads — very faint,
  e.g. `[100, 90, 70]` (pale brown).

- `src/rendering/regionPreview3D.js`: Add `track` to `hierarchyColors` — e.g.
  `0x997755` (brown). Render as thinner lines.

- `src/city/generateAnchorRoutes.js`: Decide whether `track` roads become
  anchor routes at city scale. Probably yes but as narrow unpaved paths, not
  as proper roads. This is a future concern — for now, include them.

### Step 4: Mountain pass heuristic

**File**: `src/regional/generateRoads.js` (new helper function)

```js
function estimateCrossingDifficulty(a, b, elevation) {
  // Sample elevation along straight line from a to b
  const steps = Math.ceil(distance2D(a.gx, a.gz, b.gx, b.gz));
  let maxElev = 0;
  let totalAscent = 0;
  let prevElev = elevation.get(a.gx, a.gz);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const gx = Math.round(a.gx + (b.gx - a.gx) * t);
    const gz = Math.round(a.gz + (b.gz - a.gz) * t);
    const elev = elevation.get(gx, gz);
    maxElev = Math.max(maxElev, elev);
    if (elev > prevElev) totalAscent += elev - prevElev;
    prevElev = elev;
  }

  const dist = distance2D(a.gx, a.gz, b.gx, b.gz);
  return dist * (1 + maxElev / 100 + totalAscent / 200);
}
```

Used in phase 4 to find the best settlement pair for bridging two clusters.
This naturally prefers mountain passes — the pair of settlements on either
side of the lowest saddle will have the lowest `maxElev` and `totalAscent`.

### Step 5: Update pipeline orchestration

**File**: `src/regional/pipeline.js`

Minimal change: the pipeline already calls `generateRoads()` twice (A7a and
A7b). The phased connection logic is internal to `buildConnections()`, so
the pipeline doesn't need structural changes.

However, pass `elevation` grid to `generateRoads()` — it's already passed
for A* cost, but the new `estimateCrossingDifficulty` helper also needs it
for the crossing heuristic. This is already available since `elevation` is
already a parameter.

### Step 6: Tunnel markers (stretch goal)

**File**: `src/regional/generateRoads.js`

After A* pathfinding for a bridge road, analyze the result:
- Compute flat-terrain equivalent cost: `pathLength * baseCostPerCell`
- If actual cost > 3x flat equivalent, and both clusters have importance >= 8,
  mark the road with `tunnel: true`
- Find the difficult section: the contiguous run of path cells where per-cell
  cost exceeds 2x average. Store `tunnelStart` and `tunnelEnd`.

This is metadata only — rendering and city-scale tunnel generation are
separate future tasks.

## Execution Order

1. **Step 1** — UnionFind.js (standalone, testable independently)
2. **Step 2** — Rewrite buildConnections() (the core change)
3. **Step 3** — Track hierarchy support (rendering updates)
4. **Step 4** — Mountain pass heuristic (called by step 2)
5. **Step 5** — Pipeline tweaks if needed
6. **Step 6** — Tunnel markers (defer, stretch goal)

Steps 1 + 4 have no dependencies and can be built first. Step 2 depends on
both. Step 3 is independent. Step 5 is verification.

## Testing

Run the analysis script (`/tmp/analyze-roads.js`) before and after to compare:
- Total roads, unique pairs, duplicates
- Connected vs unconnected settlements (should be 0 unconnected)
- Connections per settlement (min should be >= 1)
- Component count (should be 1 after phase 4)

Add a component count check to the analysis script.

Visual verification with the 3D preview:
- All settlements should have at least one visible road
- Mountain ranges should show roads crossing through passes, not over peaks
- Farm tracks should be visible as faint lines to isolated farms
- No obviously disconnected clusters

## Risk Mitigation

- **Performance**: The all-pairs heuristic for cluster bridging is O(C² * S²)
  where C = cluster count and S = avg cluster size. With ~150 settlements and
  ~5 clusters, this is at most a few thousand distance calculations — trivial.
  The expensive part is A* pathfinding, but bridge roads are few (< 10).

- **Over-connection**: The cluster bridge limits (1-3 outbound per cluster)
  prevent spaghetti. The MST pass adds exactly (clusters - 1) roads.

- **Regression**: The existing K-nearest and proximity logic (phase 2) is
  preserved. Phases 1, 3-6 are purely additive.

- **Farm track volume**: With ~120 farms each getting 1 track road, that's
  ~120 extra A* paths. These are short (farms are near other settlements),
  so each A* is fast. But if performance is a concern, farm tracks could use
  straight-line paths instead of A* (they're unpaved tracks, they don't need
  to follow terrain as carefully).
