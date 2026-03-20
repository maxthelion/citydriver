# Road Network Abstraction

## Status: Implemented (pipeline refactor complete)

## Problem Statement

Roads are currently represented in three independent structures that can drift out of sync:

| Structure | Location | Purpose |
|---|---|---|
| `map.roads[]` / `map.features[]` | `FeatureMap` | Plain JS objects, polylines for rendering |
| `map.graph` | `PlanarGraph` | Topology — junctions, faces, pathfinding |
| `map.roadGrid` | `Grid2D` uint8 | Rasterised cells for path cost and block extraction |

Nothing enforces that they agree. Mutations to one don't propagate to the others. The concrete bugs this produces:

1. **`growRoads()` writes only to `roadGrid`** — ribbon roads and cross streets stamped during growth ticks never appear in `map.roads` or `map.graph`. The graph is structurally incomplete after any growth tick. Block extraction, shortest-path queries, and face traversal all miss these roads.

2. **`roadGrid` is never cleared when roads are removed** — `compactRoads()` filters roads out of `map.roads` but the cells those roads stamped remain in `roadGrid`. Ghost corridors persist: pathfinding gives a 99% reuse discount to cells with no corresponding road feature, block boundaries are wrong, and zone subdivision splits blocks that no longer have roads between them.

3. **Bridge splice mutates the polyline destructively** — `_spliceBridge` replaces part of a road's `polyline[]` array in place. The bridge geometry becomes invisible to anything that held a reference to the original polyline. The graph edge's `points[]` no longer matches the road's actual geometry. There is no way to query "does this road have a bridge, and where?"

4. **Alternate routes silently dropped** — `addRoadToGraph` skips a road if `graph.neighbors(startNodeId).includes(endNodeId)` is already true. A road that takes a genuinely different path between two already-connected junctions is discarded without warning.

5. **`_snapPaths` can produce non-adjacent cell sequences** — cells are snapped up to 2 grid cells away from their original position. `mergeRoadPaths` then treats snapped-but-non-adjacent consecutive cells as connected, producing segments with physical discontinuities.

6. **Minor dead code** — `_stampRoadValue()` is called on every `addFeature('road', …)` but is permanently empty. `findNearestRoad()` in `connectIslandZones.js` is defined but never called.

The root cause is **scattered mutation**: adding, removing, or modifying a road means touching three data structures independently, and every code path is responsible for updating all of them correctly. Getting this wrong produces bugs that are hard to detect because the structures look internally consistent — they're just not consistent with each other.

---

## Proposed Design

Two new classes fix the synchronisation problem. The pure functions that currently do the heavy lifting (`mergeRoadPaths`, `buildRoadNetwork`, `_snapPaths`, `PlanarGraph`) are kept intact — they're well-tested and their functional nature is an asset.

### `Road` — replace plain feature object

The main change from a plain object is:

- The polyline is private and not directly mutable.
- Bridges are a **first-class collection** on the road, not a destructive splice into the polyline array.
- `resolvedPolyline()` returns the full geometry (base + bridges) for rendering; the underlying `polyline` is never mutated.

```js
class Road {
  #id;
  #polyline;    // [{x, z}] — base geometry, set once at construction
  #bridges;     // [{bankA, bankB, entryT, exitT}] — parametric, not spliced

  constructor(polyline, { width = 6, hierarchy = 'local', importance = 0.45, source } = {}) {
    this.#id       = Road.#nextId++;
    this.#polyline = polyline.map(p => ({ x: p.x, z: p.z })); // defensive copy
    this.#bridges  = [];
    this.width      = width;
    this.hierarchy  = hierarchy;
    this.importance = importance;
    this.source     = source;
  }

  get id()       { return this.#id; }
  get polyline() { return this.#polyline; }           // read-only access
  get start()    { return this.#polyline[0]; }
  get end()      { return this.#polyline[this.#polyline.length - 1]; }
  get bridges()  { return [...this.#bridges]; }        // snapshot

  /**
   * Record a bridge crossing. entryT and exitT are parametric positions
   * along the polyline (0..1), computed from the water-entry/exit world coords.
   * bankA and bankB are the perpendicular landing positions on each bank.
   * No polyline mutation occurs.
   */
  addBridge(bankA, bankB, entryT, exitT) {
    this.#bridges.push({ bankA, bankB, entryT, exitT });
  }

  /**
   * Full geometry for rendering: base polyline with bridge segments
   * substituted in for water-crossing portions.
   */
  resolvedPolyline() {
    if (this.#bridges.length === 0) return this.#polyline;
    // Merge base polyline with bridge segments ordered by entryT
    // Returns [{x, z}] with bridge bank points spliced at correct positions
    // (implementation detail — kept off the class for clarity here)
    return _resolvePolylineWithBridges(this.#polyline, this.#bridges);
  }

  toJSON() {
    return {
      id: this.#id, polyline: this.#polyline, bridges: this.#bridges,
      width: this.width, hierarchy: this.hierarchy,
      importance: this.importance, source: this.source,
    };
  }

  static fromJSON(data) {
    const road = new Road(data.polyline, data);
    for (const b of data.bridges) road.addBridge(b.bankA, b.bankB, b.entryT, b.exitT);
    return road;
  }

  static #nextId = 0;
}
```

**Why parametric bridges (`entryT`, `exitT`) instead of index-based splicing?**

The current `_spliceBridge` finds the closest existing polyline *vertex* to the water edge and splices there. Because polylines are RDP-simplified, the nearest vertex may be far from the actual water edge — potentially hundreds of metres inland. The splice then removes the wrong portion of the polyline.

A parametric position (fraction 0..1 along the total polyline arc length) is computed from the actual world-coord crossing point, not from the nearest vertex. `resolvedPolyline()` can interpolate precisely to that point without any vertex needing to exist there. The base geometry stays correct regardless.

---

### `RoadNetwork` — single point of mutation

This class owns all three representations and ensures they stay in sync. All road mutations go through it.

```js
class RoadNetwork {
  #roads;         // Map<id, Road>
  #graph;         // PlanarGraph
  #roadGrid;      // Grid2D uint8
  #bridgeGrid;    // Grid2D uint8
  #cellRefCounts; // Grid2D uint16 — how many roads have stamped each cell

  // grid geometry (stored for stamping/unstamping)
  #width; #height; #cellSize; #originX; #originZ;

  constructor(width, height, cellSize, originX = 0, originZ = 0) {
    this.#roads        = new Map();
    this.#graph        = new PlanarGraph();
    this.#roadGrid     = new Grid2D(width, height, { type: 'uint8' });
    this.#bridgeGrid   = new Grid2D(width, height, { type: 'uint8' });
    this.#cellRefCounts = new Grid2D(width, height, { type: 'uint16' });
    this.#width = width; this.#height = height; this.#cellSize = cellSize;
    this.#originX = originX; this.#originZ = originZ;
  }

  // ---- Public API ----

  /**
   * Add a road from a world-coord polyline.
   * Stamps roadGrid, updates graph, returns the Road.
   */
  add(polyline, attrs = {}) {
    const road = new Road(polyline, attrs);
    this.#roads.set(road.id, road);
    this.#stampRoad(road);
    this.#addToGraph(road);
    return road;
  }

  /**
   * Add a road from grid cells (used by growRoads so growth roads get a
   * proper identity instead of only existing on roadGrid).
   * Converts cells → world polyline, then delegates to add().
   */
  addFromCells(cells, attrs = {}) {
    if (cells.length < 2) return null;
    const polyline = cells.map(c => ({
      x: this.#originX + c.gx * this.#cellSize,
      z: this.#originZ + c.gz * this.#cellSize,
    }));
    return this.add(polyline, attrs);
  }

  /**
   * Remove a road by id.
   * Decrements cell ref counts and clears roadGrid cells that reach zero.
   * Removes the corresponding graph edge.
   */
  remove(id) {
    const road = this.#roads.get(id);
    if (!road) return;
    this.#unstampRoad(road);
    this.#removeFromGraph(road);
    this.#roads.delete(id);
  }

  /**
   * Record a bridge on an existing road.
   * Stamps bridgeGrid for water cells between the banks.
   */
  addBridge(roadId, bankA, bankB, entryT, exitT) {
    const road = this.#roads.get(roadId);
    if (!road) return;
    road.addBridge(bankA, bankB, entryT, exitT);
    this.#stampBridge(bankA, bankB);
  }

  /**
   * Replace a road's polyline (e.g. after compaction).
   * Unstamps old geometry, re-stamps new, updates graph.
   */
  updatePolyline(id, newPolyline) {
    const road = this.#roads.get(id);
    if (!road) return;
    this.#unstampRoad(road);
    this.#removeFromGraph(road);
    road.#polyline = newPolyline.map(p => ({ x: p.x, z: p.z })); // only RoadNetwork can do this
    this.#stampRoad(road);
    this.#addToGraph(road);
  }

  /** Keep the best-hierarchy road when two roads have the same snapped endpoints. */
  deduplicateByEndpoints(snapDist) {
    // groups roads by endpoint pair, removes lower-hierarchy duplicates
    // calls this.remove() so grid + graph stay in sync
    // (replaces compactRoads Pass 2)
  }

  // ---- Read-only accessors ----

  get roads()      { return [...this.#roads.values()]; }
  get roadCount()  { return this.#roads.size; }
  get graph()      { return this.#graph; }            // PlanarGraph (read)
  get roadGrid()   { return this.#roadGrid; }         // Grid2D (read)
  get bridgeGrid() { return this.#bridgeGrid; }

  getRoad(id)      { return this.#roads.get(id); }

  // ---- Private stamping ----

  #stampRoad(road) {
    // Walk polyline, stamp roadGrid, increment cellRefCounts
    // (same geometry as current _stampRoad in FeatureMap)
  }

  #unstampRoad(road) {
    // Walk polyline, decrement cellRefCounts
    // Clear roadGrid cell only when ref count reaches 0
    // This correctly handles overlapping roads — removing one doesn't
    // clear cells it shares with another
  }

  #stampBridge(bankA, bankB) {
    // Walk bankA→bankB, stamp bridgeGrid for water cells
    // (same as current _stampBridgeGrid)
  }

  #addToGraph(road) {
    // Find-or-create nodes for start/end with snapDist = cellSize * 3
    // Only add edge if nodes are distinct AND not already connected
    // Log a warning (don't silently discard) if alternate route is dropped
  }

  #removeFromGraph(road) {
    // Find edge(s) between start/end node pair and remove
    // If a node reaches degree 0, optionally remove it too
  }
}
```

---

## How This Fixes the Audit Problems

| Problem | Fix |
|---|---|
| `growRoads()` roads invisible to graph | Call `network.addFromCells()` instead of stamping `roadGrid` directly |
| Ghost corridors after compaction | `network.remove(id)` decrements ref counts; cells at zero get cleared |
| Bridge splice corrupts polyline | `Road.addBridge()` stores parametric bridge data; `resolvedPolyline()` computes geometry on demand without mutation |
| Alternate routes silently dropped | `#addToGraph` logs a warning instead of silently returning |
| `_stampRoadValue` no-op | Deleted — it only existed as a hook that was never implemented |
| `findNearestRoad` dead code | Deleted |

---

## What Doesn't Change

The pure functions that implement the heavy algorithms are kept exactly as they are:

- `mergeRoadPaths(paths)` — cell-graph merge, no road objects involved
- `buildRoadNetwork(options)` — pathfind + snap + merge + simplify pipeline
- `PlanarGraph` — topology structure, unchanged

`RoadNetwork` calls these functions and then uses the results to call `add()`. The functions' testability and correctness are preserved.

---

## Integration with `FeatureMap`

`FeatureMap` currently holds `this.roads`, `this.graph`, `this.roadGrid`, and `this.bridgeGrid` as separate fields. After this change:

```js
// Before
this.roads    = [];
this.graph    = new PlanarGraph();
this.roadGrid = new Grid2D(…);

// After
this.roadNetwork = new RoadNetwork(width, height, cellSize, originX, originZ);

// Convenience getters for backward compatibility during migration
get roads()     { return this.roadNetwork.roads; }
get graph()     { return this.roadNetwork.graph; }
get roadGrid()  { return this.roadNetwork.roadGrid; }
get bridgeGrid(){ return this.roadNetwork.bridgeGrid; }
```

`addFeature('road', …)` delegates to `this.roadNetwork.add(data.polyline, data)`.

Callers that currently write to `roadGrid` directly (e.g. `growRoads`, `_connectDisconnectedNuclei`) are updated to call `roadNetwork.addFromCells()` or `roadNetwork.add()`.

---

## Tradeoffs

### Where this clearly wins
- **Invariant enforcement**: impossible to update one representation without the others
- **Bridges as data**: queryable, serialisable, not a destructive edit to geometry
- **Correct removal**: ref-counted unstamping makes `remove()` safe without a full grid rebuild
- **Growth roads get an identity**: block extraction and face traversal see the complete network

### Genuine costs
- **Serialisation**: `Road` needs `toJSON()` / `fromJSON()` (outlined above); plain objects serialised for free
- **The graph snap problem**: `addRoadToGraph` snaps road endpoints to nearby nodes. When a snapped node is later removed via `remove()`, it may be shared with other roads — `#removeFromGraph` needs to check degree before deleting a node. The snapping makes road identity and node identity non-injective; this was true before and OOP doesn't dissolve it, it just forces the decision to be named.
- **Testing setup**: `RoadNetwork` needs more scaffolding to test than pure functions. Keep the pure functions pure; test them directly; test `RoadNetwork` through its public API with a minimal grid.

### What OOP doesn't fix
- The `_snapPaths` non-adjacent-cell problem — this is a geometry bug independent of object model. The fix is to verify adjacency after snapping, or reduce snap radius, or switch to a different deduplication strategy.
- The node-snap ambiguity in `addRoadToGraph` — whether to keep or warn about alternate routes between connected nodes is a product decision, not an architecture one.

---

## Migration Path

1. Add `Road` class alongside plain objects; update `bridges.js` to call `road.addBridge()` instead of `_spliceBridge`.
2. Add `RoadNetwork` with `add()` and read-only accessors; wire `FeatureMap.addFeature('road', …)` through it.
3. Update `growRoads()` to call `roadNetwork.addFromCells()`.
4. Add `remove()` with ref-counted unstamping; update `compactRoads` to use it.
5. Add backward-compat getters on `FeatureMap`; remove them once all call sites are updated.
6. Delete `_stampRoadValue`, `findNearestRoad`, the `feature.bridge` branch in `_stampRoad` (replaced by `#stampBridge` in `RoadNetwork`).
