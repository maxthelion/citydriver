# Road Network Abstraction — Bypass Violations and Fix Plan

## The Intended Contract

`RoadNetwork` (`src/core/RoadNetwork.js`) is designed as the **single mutation point** for roads, graph, and grids. Its JSDoc states this explicitly. It keeps three representations in sync:

- **`Road` objects** — canonical polylines with id, width, hierarchy, source, bridges
- **`PlanarGraph`** — topological representation: nodes at intersections, edges along roads
- **`roadGrid`** — rasterised bitmap: which cells are covered by a road

All mutations are meant to go through its public API:

| Method | Purpose |
|--------|---------|
| `add(polyline, attrs)` | Add a road, stamp grid, add graph edge |
| `addFromCells(cells, attrs)` | Same, from grid cells |
| `remove(id)` | Remove road, unstamp grid, remove graph edge |
| `updatePolyline(id, newPolyline)` | Replace polyline, re-stamp grid, update graph |
| `addBridge(roadId, ...)` | Add bridge, stamp bridgeGrid |
| `ensureGraphNodeOnRoad(roadId, x, z)` | Split graph edge at point, return node id |
| `connectRoadsAtPoint(roadIdA, roadIdB, x, z)` | Form junction at a point |

The invariants this supports (from `world-state-invariants.md`):
- "Road grid matches polylines — every road grid cell is explainable by walking the road's polyline"
- "No duplicate road grid stamps — only one code path stamps a given road into the grid"

## Current Violations

There are six sites in the pipeline that bypass `RoadNetwork` and write directly to the underlying structures.

---

### 1. `growRoads.js` — direct `roadGrid.set()` (5 sites)

**The bypass:**
```js
roadGrid.set(g.gx, g.gz, 1);
```

**Where:** `growRoads()` has a dual code path. When `roadNetwork` is passed as an option it uses `roadNetwork.addFromCells()` correctly. When it is not passed, it falls back to direct `roadGrid.set()` calls for ribbon gaps, cross streets, and path-closing connections.

**What breaks:** Cells appear in `roadGrid` with no corresponding `Road` object. The graph has no edges for them. `RoadNetwork._cellRefCounts` has no entry for them. If `RoadNetwork.remove()` is ever called for an overlapping road, it will clear those cells because the ref count is zero, silently destroying grid state it didn't create.

**Fix:** Remove the fallback path. `growRoads` should always receive `roadNetwork` and always call `addFromCells()`. All callers in `growthTick.js` already have access to `map.roadNetwork`. The `roadNetwork` parameter should become required.

---

### 2. `cityPipeline.js` — `road._replacePolyline()` in smooth-roads step

**The bypass:**
```js
road._replacePolyline(poly);
```

**Where:** The `smooth-roads` step at the end of `cityPipeline` iterates over `map.roads` and smooths each polyline using Chaikin subdivision, then calls `_replacePolyline` directly on the `Road` object.

**What breaks:** `_replacePolyline` is marked package-private — it is intended to be called only by `RoadNetwork.updatePolyline()`. Calling it directly updates the Road's stored polyline but does NOT re-stamp the grid or update the graph. After smoothing, the rendered road shape diverges from the rasterised `roadGrid` cells. The grid shows the pre-smoothing footprint; pathfinding and invariant checks use stale data.

**Fix:** Replace with `map.roadNetwork.updatePolyline(road.id, smoothedPolyline)`. This correctly unstamps the old geometry, updates the polyline, and re-stamps the new one.

---

### 3. `layoutRibbons.js` — `graph.splitEdge()` directly

**The bypass:**
```js
graph.splitEdge(edgeId, projX, projZ);
```

**Where:** The T-junction stitching pass at the end of `layoutRibbons` finds ribbon endpoints that land close to an existing graph edge, and splits that edge to create a proper junction node.

**What breaks:** `graph.splitEdge()` updates graph topology only. `RoadNetwork` is not notified. The split creates a new node in the graph, but no corresponding update happens to the Road object whose edge was split, and no re-stamping of the grid occurs. The road's polyline still covers the same cells, but the graph now describes a different connectivity. Downstream steps that read `road.id` from graph edge attrs will find the original road id, not the two new half-edges, because `splitEdge` doesn't know about Road objects.

**Fix:** Use `map.roadNetwork.ensureGraphNodeOnRoad(roadId, projX, projZ)` which does the same graph split but through the abstraction — it finds the road from the edge's `roadId` attr and handles the coordination. The `roadId` is already stored on graph edges as `edge.attrs.roadId`.

---

### 4. `zoneBoundaryRoads.js` — `graph.splitEdge()`, `graph.mergeNodes()`, `graph._adjacency.delete()`

**The bypass:**
```js
const splitNodeId = map.graph.splitEdge(edgeId, bestProjX, bestProjZ);
map.graph.mergeNodes(zbId, splitNodeId);

// and later, for cleanup:
map.graph._adjacency.delete(id);
```

**Where:** After adding zone boundary roads, this step tries to snap the new road endpoints onto the existing skeleton by splitting skeleton edges and merging the boundary road's node into the split point. The cleanup loop then removes degree-0 nodes by directly deleting from `_adjacency`.

**What breaks:** Same as above for `splitEdge` and `mergeNodes`. Additionally, `map.graph._adjacency.delete(id)` reaches into a private field of `PlanarGraph`. `PlanarGraph` has no public `removeNode` method that also cleans up adjacency entries, so the workaround goes directly to the internals. This creates graph state that `RoadNetwork` cannot reason about and that will corrupt subsequent graph operations if those nodes had pending entries elsewhere.

**Fix:**
- Replace `splitEdge` + `mergeNodes` with `map.roadNetwork.connectRoadsAtPoint(skeletonRoadId, zbRoadId, x, z)`.
- Add a `removeOrphanNodes()` method to `PlanarGraph` (or `RoadNetwork`) that safely removes degree-0 nodes through the public API, then use that instead of `_adjacency.delete`.

---

### 5. `connectToNetwork.js` — `graph._adjacency.get()` for BFS

**The bypass:**
```js
const adj = graph._adjacency.get(id);
```

**Where:** The connected-components BFS in `connectToNetwork` reads the adjacency map directly to walk the graph.

**What breaks:** This is read-only, so no state corruption. But it couples the implementation to `PlanarGraph`'s internal data structure. If the internal representation changes, this silently breaks.

**Fix:** `PlanarGraph` already has a `neighbors(nodeId)` public method. The BFS should use `graph.neighbors(id)` instead of reading `_adjacency` directly.

---

### 6. `addBoundaryEdges.js` — `graph.addNode()` and `graph.addEdge()` directly

**The bypass:**
```js
graph.addNode(ox, oz);
graph.addEdge(nw, ne, { type: 'boundary', hierarchy: 'boundary', width: 0 });
```

**Where:** The `addBoundaryEdges` step adds map perimeter corners and river polylines as graph edges so that `facesWithEdges()` can produce full face coverage.

**What breaks:** Unlike the other violations, this one is a **genuine API gap**. Boundary edges are not roads — they have no polyline, no physical width, and should never produce a `Road` object. `RoadNetwork.add()` is the wrong call here; it would create spurious Road objects in `map.roads` that renderers and exporters would try to draw as streets.

The issue is that `RoadNetwork` has no concept of non-road topology edges. So this code correctly bypasses it, but leaves the graph in a state where some edges have no corresponding Road — which breaks the assumption that `edge.attrs.roadId` always resolves.

**Fix:** `RoadNetwork` needs a separate method for topology-only edges:

```js
roadNetwork.addTopologyEdge(fromX, fromZ, toX, toZ, attrs)
```

This would add nodes and a graph edge but create no `Road` object and stamp no grid cells. Graph edges added this way would have `attrs.roadId = null` or a sentinel value. Code that resolves `roadId` from graph edge attrs must already handle this case (boundary edges don't have a road), which makes the invariant explicit rather than implicit.

---

## Summary Table

| File | Bypass | Root cause | Severity |
|------|--------|-----------|----------|
| `growRoads.js` | `roadGrid.set()` ×5 | Optional `roadNetwork` param — fallback path | High — orphan grid cells, no Road objects |
| `cityPipeline.js` | `road._replacePolyline()` | Missing `updatePolyline` call in smooth step | High — grid/polyline mismatch after smoothing |
| `layoutRibbons.js` | `graph.splitEdge()` | No road-aware split in public API used | Medium — graph/Road desync at T-junctions |
| `zoneBoundaryRoads.js` | `graph.splitEdge()`, `mergeNodes()`, `_adjacency.delete()` | Same + private field access for cleanup | High — private field access, graph corruption risk |
| `connectToNetwork.js` | `graph._adjacency.get()` | Read-only BFS using internal structure | Low — coupling only, no state corruption |
| `addBoundaryEdges.js` | `graph.addNode()`, `graph.addEdge()` | API gap — RoadNetwork has no topology-only edge | Medium — correct workaround but needs proper API |

## Fix Order

1. **`connectToNetwork.js`** — trivial, swap `_adjacency.get()` for `graph.neighbors()`. No behaviour change.
2. **`cityPipeline.js`** — swap `road._replacePolyline(poly)` for `map.roadNetwork.updatePolyline(road.id, poly)`. No behaviour change, fixes grid/polyline sync.
3. **`growRoads.js`** — make `roadNetwork` required, delete the fallback path. Verify callers all pass `map.roadNetwork`.
4. **`layoutRibbons.js`** — replace `graph.splitEdge()` with `map.roadNetwork.ensureGraphNodeOnRoad(roadId, x, z)`. Requires reading `roadId` from edge attrs (already present).
5. **`PlanarGraph`** — add `removeOrphanNodes()` public method.
6. **`zoneBoundaryRoads.js`** — replace `splitEdge`/`mergeNodes` pair with `roadNetwork.connectRoadsAtPoint()`, replace `_adjacency.delete` with `removeOrphanNodes()`.
7. **`RoadNetwork`** — add `addTopologyEdge()` method. Update `addBoundaryEdges.js` to use it.

Steps 1–3 are independent and can be done in any order. Steps 4 and 6 depend on the relevant `RoadNetwork` / `PlanarGraph` API existing. Step 7 is last because it requires the most careful API design.

## Invariant to Add

Once these fixes are in place, a new invariant can be checked after every pipeline step:

> **Graph/Road consistency** — every graph edge with a non-null `roadId` resolves to a Road in `map.roads`. Every Road in `map.roads` has at least one corresponding graph edge. No grid cell stamped as road is unexplained by a Road's polyline.

This can be a cheap `O(edges + roads)` check added to the existing invariant hook in `PipelineRunner`.
