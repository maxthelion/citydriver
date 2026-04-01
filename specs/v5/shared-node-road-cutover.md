# Shared-Node Road Cutover

## Purpose

Adopt the **internal alignment** part of the OSM road model now, because it
directly helps the current cross-street and ribbon work.

This is not an export project. Export can come later.

The immediate goal is to stop representing “roads that should meet” as:

- two separate polylines
- plus a mutable `PlanarGraph`
- plus a stamped `roadGrid`
- plus a series of snapping/retry heuristics

and instead represent them as:

- shared nodes
- ordered road ways
- derived graph
- derived grid

That should make boundary seam joining, ribbon junction sharing, and
cross-street continuation much simpler and much less heuristic.

## Why This Helps The Current Work

The current seam work keeps running into the same class of problem:

- a cross street in one sector is clearly the continuation of a cross street in
  the next sector
- but they exist as separate polylines
- so we try to repair the seam with:
  - phase borrowing
  - endpoint snapping
  - `txn-parallel` retries
  - pre-commit joins

That is treating a topology problem as a geometry problem.

The same thing shows up in ribbons:

- a ribbon hit on a cross street is “visually at the junction”
- but unless we explicitly split and connect, it is still only geometry

With shared nodes, these become normal operations:

- “reuse that boundary node”
- “insert a node on this way at this point”
- “connect these two ways at a shared node”

instead of “alter a polyline and hope the validator accepts it”.

## Decision

Do a **hard internal cutover** to a shared-node road model.

Do **not** maintain:

- `Road` as one canonical model
- `OsmWay` as a second canonical model
- `PlanarGraph` as an independently editable source of truth

The new source of truth should be:

- shared `RoadNode`
- ordered `RoadWay`

Everything else should be derived from that.

This means deleting old code, not layering a compatibility bridge that lasts
for months.

## Non-Goals

- OSM export
- GeoJSON export
- preserving the current internal representation for old call sites
- supporting both `Road` and `RoadWay` in parallel

## Target Model

```js
class RoadNode {
  id
  x
  z
  attrs
}

class RoadWay {
  id
  nodes        // RoadNode[] shared references in order
  width
  hierarchy
  importance
  source
  bridges
}
```

A junction is any `RoadNode` referenced by more than one `RoadWay`.

`RoadNetwork` remains the mutation surface, but internally it owns:

- `Map<number, RoadNode>`
- `Map<number, RoadWay>`

and derives:

- `roadGrid`
- `bridgeGrid`
- `PlanarGraph`

## What Gets Deleted

Delete, not deprecate:

- [Road.js](/Users/maxwilliams/dev/citygenerator/src/core/Road.js)
- `road._replacePolyline()`
- the idea that `PlanarGraph` is a canonical mutable representation of roads
- direct graph edits for real road mutations where a way/node operation exists
- direct `roadGrid.set()` fallback road creation paths

After the cutover:

- `RoadNetwork.roads` becomes `RoadNetwork.ways`
- call sites stop depending on `Road` instances
- graph edges with `roadId` become graph edges with `wayId`
- `PlanarGraph` is rebuilt or incrementally refreshed from ways, but is not the
  canonical source of topology

## Specific Capabilities Needed For Current Work

These are the operations that should exist before we move more seam logic:

### 1. Reuse a nearby node as an endpoint

Given a candidate cross street endpoint and a neighboring boundary node:

- if within tolerance
- and angle-compatible

then the candidate should end on that exact existing node.

This is the direct replacement for the current “prejoin” and retry hacks.

### 2. Insert a node on a way at an arbitrary point

Needed for:

- ribbon hits on cross streets
- T-junction stitching
- zone boundary stitching

This is the shared-node version of `splitEdge`.

### 3. Connect two ways at a point

Needed when:

- two ways should form a junction
- neither already has a node there

This should:

1. split each way if needed
2. create or reuse one shared node
3. update both ways to reference it

### 4. Replace a way’s geometry by replacing its node sequence

Needed for:

- smoothing
- snapping
- seam joining

This replaces `_replacePolyline`.

### 5. Rebuild derived representations

Given the current ways:

- stamp `roadGrid`
- stamp `bridgeGrid`
- rebuild or refresh `PlanarGraph`

These must be derived only from ways/nodes.

## Migration Strategy

This should be done as a focused branch with a short transition, not a prolonged
dual-model phase.

### Phase 0: Characterization Tests First

Before changing internals, add characterization tests that freeze the behavior
we care about.

#### A. Road-network mutation characterization

Add tests around:

- adding two roads that should share an endpoint produces one shared endpoint,
  not two nearby ones
- inserting a junction node on an existing road preserves road-grid coverage
- connecting two roads at a point creates one shared node and expected topology
- updating geometry does not leave stale grid stamps behind

These should live alongside
[RoadNetwork.test.js](/Users/maxwilliams/dev/citygenerator/test/core/RoadNetwork.test.js),
but can be rewritten around `RoadWay` once the cutover happens.

#### B. Cross-street characterization

For fixed seeds such as `884469`, capture coarse invariants, not exact pixels:

- per-zone committed cross-street counts for selected experiments
- count of `txn-parallel` rejections in known sectors
- count of borrowed-phase sectors
- count of prejoin/retry events in seam-heavy experiments

Use the event log as the characterization artifact, not the exact polyline
points.

#### C. Ribbon characterization

Freeze:

- accepted row counts for baseline seeds
- presence of shared junction creation events
- row truncation behavior on known conflict cases

Again, prefer event sequences and counts over exact geometry.

### Phase 1: Introduce Shared Nodes And Ways Inside RoadNetwork

Add:

- `src/core/RoadNode.js`
- `src/core/RoadWay.js`

Then change [RoadNetwork.js](/Users/maxwilliams/dev/citygenerator/src/core/RoadNetwork.js)
to store nodes/ways as the only canonical state.

During this phase:

- do **not** keep `Road` objects in sync
- do **not** add a parallel `osmWays` mirror
- update call sites in the same branch

If needed for incremental edits, method names like `add()` / `remove()` may
stay, but they should return and operate on `RoadWay`, not `Road`.

### Phase 2: Make Grid And Graph Derived

Change [RoadNetwork.js](/Users/maxwilliams/dev/citygenerator/src/core/RoadNetwork.js)
so:

- `roadGrid` is stamped from ways
- `bridgeGrid` is stamped from ways/bridge annotations
- `PlanarGraph` is built from the current nodes/ways

At this point, `PlanarGraph` should no longer be treated as a source of truth.

### Phase 3: Replace The Current Junction Operations

Rewrite:

- `ensureGraphNodeOnRoad(...)`
- `connectRoadsAtPoint(...)`

as:

- `ensureNodeOnWay(...)`
- `connectWaysAtPoint(...)`

and update callers to use the new semantics.

This is the phase that should directly improve:

- ribbon hit handling
- shared-boundary cross-street joining
- zone-boundary stitching

### Phase 4: Remove The Old Model Completely

Delete:

- [Road.js](/Users/maxwilliams/dev/citygenerator/src/core/Road.js)
- old tests that assert `Road`-specific behavior
- `roadId` assumptions where the new object is a `wayId`
- any compatibility shims added during the cutover branch

If some call site still depends on the old shape at this point, update it.
Do not preserve a compatibility facade.

## First Call Sites To Rewrite

These should move early because they are directly related to the current work.

### Highest priority

- [src/city/incremental/roadTransaction.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/roadTransaction.js)
- [scripts/render-sector-ribbons.js](/Users/maxwilliams/dev/citygenerator/scripts/render-sector-ribbons.js)
- [src/city/incremental/ribbons.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/ribbons.js)
- [src/city/incremental/crossStreets.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/crossStreets.js)

These are where seam joining and ribbon junction formation are currently being
patched with geometry heuristics.

### Next

- [src/city/pipeline/layoutRibbons.js](/Users/maxwilliams/dev/citygenerator/src/city/pipeline/layoutRibbons.js)
- [src/city/pipeline/zoneBoundaryRoads.js](/Users/maxwilliams/dev/citygenerator/src/city/pipeline/zoneBoundaryRoads.js)
- [src/city/pipeline/cityPipeline.js](/Users/maxwilliams/dev/citygenerator/src/city/pipeline/cityPipeline.js)
- [src/city/pipeline/growRoads.js](/Users/maxwilliams/dev/citygenerator/src/city/pipeline/growRoads.js)

These are the abstraction-violation sites called out in
[road-network-abstraction.md](/Users/maxwilliams/dev/citygenerator/specs/v5/road-network-abstraction.md).

## Seam-Specific Acceptance Criteria

The cutover is only worth it if it helps the current pain points.

We should consider this successful when:

1. Borrowed-phase cross streets near a neighboring boundary continuation reuse
   the existing boundary node directly, instead of relying on retry after
   `txn-parallel`.

2. A ribbon hit on a cross street creates a real shared node as part of the
   normal way mutation path, not a sidecar geometric marker.

3. The number of “visually obvious near-miss seams” in the debug renders for
   seed `884469` is materially reduced without adding a new seam-specific
   heuristic layer.

4. The event log becomes more semantic:
   - `way-node-reused`
   - `node-inserted-on-way`
   - `ways-connected-at-node`
   instead of only geometric retry events.

## Characterization Test Strategy

The Feathers-style characterization tests are important here because we are
changing a deep model, not just one heuristic.

### Protect these behaviors

- known seeds still render end-to-end
- event ordering remains sane
- shared-boundary experiments still produce broadly similar committed/rejected
  counts
- road-grid coverage remains explainable from way geometry

### Do not over-freeze these behaviors

- exact polyline vertices
- exact SVG coordinates
- exact `seq` values for all events

The tests should protect workflow and invariants, not lock in every current
quirk.

## Recommended Branch Shape

Do this in one dedicated branch and land it as a concentrated refactor, not as
many tiny compatibility commits.

Suggested sequence:

1. characterization tests
2. introduce `RoadNode` and `RoadWay`
3. cut `RoadNetwork` over internally
4. update seam/ribbon/cross-street call sites
5. delete `Road.js` and remaining compatibility paths
6. rerender the key experiments and compare

## Explicit Tradeoff

This is a larger refactor than another seam heuristic.

But the current seam work is already telling us the same thing repeatedly:

- we know when roads *should* meet
- the model makes joining them awkward

This proposal changes the model so the correct operation is natural.
