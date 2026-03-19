# V5 Next Steps

## Status: Active — March 2026

This document records the agreed next sequence of work, with rationale and dependencies.
Update it as steps complete or priorities shift.

---

## Where We Are

The pipeline refactor is done:

- **Road Network Abstraction** — `RoadNetwork` owns roads, graph, roadGrid, bridgeGrid. Single mutation point.
- **Pipeline Functions Extracted** — every tick is a standalone `(map) → map` function in `src/city/pipeline/`.
- **FeatureMap Cleaned** — layer bag only. No `addFeature`, no `buildability`, no `setTerrain`. Rivers and railways stamped directly.
- **`LandFirstDevelopment` is a thin sequencer** — calls pipeline functions in order via a state machine.
- **Zones = graph faces** — `extractZones` uses `PlanarGraph.facesWithEdges()` as primary source. Each zone has `polygon`, `boundingEdgeIds`, `boundingNodeIds` in addition to the old `cells`/metadata.

The GPU work (computeInfluenceLayers, composeAllValueLayers) is done for large-grid performance.
The archived strategies (frontagePressure, faceSubdivision, offsetInfill, etc.) are deleted.

---

## Step 1: PipelineRunner + Generator Pipeline

**Why first:** Everything else depends on it. Invariant testing, timing hooks, sub-step observability, and multi-strategy composition all require a pipeline with named steps and a hook mechanism. The current state machine in `LandFirstDevelopment` has no step identity and can't be hooked without modification.

**What to build:**

```js
// src/city/pipeline/PipelineRunner.js
export class PipelineRunner {
  constructor(gen) {
    this._gen = gen;
    this._done = false;
    this._lastResult = null;
    this.hooks = [];
  }

  advance() {
    if (this._done) return false;
    const { value: descriptor, done } = this._gen.next(this._lastResult);
    if (done) { this._done = true; return false; }
    const t0 = performance.now();
    for (const h of this.hooks) h.onBefore?.(descriptor.id);
    this._lastResult = descriptor.fn();
    const ms = performance.now() - t0;
    for (const h of this.hooks) h.onAfter?.(descriptor.id, this._lastResult, ms);
    return true;
  }

  runToCompletion() { while (this.advance()) {} }
  addHook(hook) { this.hooks.push(hook); return this; }
}

export function step(id, fn) { return { id, fn }; }
```

```js
// src/city/pipeline/cityPipeline.js
export function* cityPipeline(map, archetype) {
  yield step('skeleton',   () => buildSkeletonRoads(map));
  yield step('land-value', () => computeLandValue(map));
  yield step('zones',      () => extractZones(map));
  yield step('spatial',    () => computeSpatialLayers(map));
  yield* resolveGrowthStrategy(archetype)(map, archetype);
  yield step('connect',    () => connectToNetwork(map));
}
```

**`LandFirstDevelopment` becomes a thin wrapper** around `PipelineRunner`. Its `tick()` method calls `runner.advance()`. No logic changes — same functions, same order, different control structure.

**Spec:** `wiki/pages/pipeline-abstraction.md`

**Files:**
- New: `src/city/pipeline/PipelineRunner.js`
- New: `src/city/pipeline/cityPipeline.js`
- Modify: `src/city/strategies/landFirstDevelopment.js` (state machine → runner wrapper)

---

## Step 2: Pipeline Invariant Testing

**Why now:** The main deliverable this infrastructure was built for. With named steps and hooks, invariant checking drops in as a hook without touching pipeline code.

**Three categories:**

### Bitmap invariants (per-cell, O(n), GPU-able)

Run after every step via a `'*'` wildcard hook. Single pass over all cells:

| Invariant | Layers | When |
|-----------|--------|------|
| `noRoadOnWater` | roadGrid ∩ waterMask = ∅ | after skeleton+ |
| `noRailOnWater` | railwayGrid ∩ waterMask = ∅ | after setup |
| `noZoneOnWater` | zoneGrid ∩ waterMask = ∅ | after zones+ |
| `noZoneOnRoad` | zoneGrid ∩ roadGrid = ∅ | after zones+ |
| `noResOutsideZone` | reservationGrid ≤ zoneGrid | after reservation+ |
| `bridgesOnlyOnWater` | bridgeGrid ⊆ waterMask | after skeleton+ |

All six in one cell loop (~1.44M cells × 6 conditions). CPU: ~15ms. GPU: ~1ms.

### Polyline/graph invariants (per-road)

| Invariant | What it catches |
|-----------|----------------|
| Every road has ≥ 2 polyline points | Degenerate roads |
| Every polyline point within map bounds | Polylines leaking outside world |
| `graph.edges.size` matches `roadNetwork.roads.length` | Graph/network desync |
| Every graph node degree ≥ 1 | Orphan nodes from compaction |
| Bridge bankA/bankB on dry land | Bridge placement on wrong side |
| `roadGrid` agrees with polyline re-stamp | Grid drift from source |

The last one (re-stamp agreement) is expensive — re-stamp all roads into a fresh grid and diff. Run only on named checkpoints, not every step.

### Block/zone invariants (per-block)

| Invariant | What it catches |
|-----------|----------------|
| `boundingEdgeIds` all exist in `graph.edges` | Stale edge refs after road removal |
| No cell overlap between blocks | Rasterization bug |
| Every block has ≥ 1 bounding edge | Disconnected block |

**Test structure:**

```js
// test/integration/pipelineInvariants.test.js
describe('pipeline invariants', () => {
  for (const seed of [42, 99, 751119]) {
    describe(`seed ${seed}`, () => {
      const violations = runPipelineWithInvariants(seed);

      it('no road on water', () => expect(violations.noRoadOnWater).toBe(0));
      it('no zone on water', () => expect(violations.noZoneOnWater).toBe(0));
      it('no zone on road',  () => expect(violations.noZoneOnRoad).toBe(0));
      it('graph matches roads', () => expect(violations.graphEdgesMismatch).toBe(0));
      // etc.
    });
  }
});
```

**GPU path:** Bitmap invariants have identical CPU and GPU implementations behind the same interface. CPU is the default (no WebGPU dependency in tests). GPU drops in as an optimisation when running invariants every growth tick.

**Files:**
- New: `src/city/invariants/bitmapInvariants.js`
- New: `src/city/invariants/polylineInvariants.js`
- New: `src/city/invariants/blockInvariants.js`
- New: `test/integration/pipelineInvariants.test.js`

---

## Step 3: Zone Re-extraction Feedback Loop

**Why:** The wiki (`city-growth-model.md`) is explicit: after skeleton roads are placed, zone boundary roads should be added along zone edges, then zones re-extracted. The new secondary roads split large zones into finer parcels. Currently zones are extracted once (tick 3) and never updated.

**What to change:**

Add zone boundary roads as a step between skeleton and zone extraction:

```
tick 1: skeleton roads
tick 2: land value
tick 3: zone boundary roads  ← NEW: roads along edges of coarse zones
tick 4: re-extract zones      ← secondary roads now split the coarse zones
tick 5: spatial layers
tick 6+: growth
```

With graph faces, re-extraction is correct automatically — adding zone boundary roads to the graph creates new face edges, and the next `extractZones(map)` call picks them up.

**`zoneBoundaryRoads.js` already exists** in `src/city/pipeline/`. It's not currently called from `LandFirstDevelopment`. Wire it in.

**Files:**
- Modify: `src/city/pipeline/cityPipeline.js` (add zone-boundary step)
- No new files — `zoneBoundaryRoads.js` is already written

---

## Step 4: Street Connectivity

**Why:** From `urban-economics-and-connectivity.md` — cross streets within zones don't form proper T-junctions in the graph. Individual ribbon streets are disconnected from each other. After `connectToNetwork`, zone spines connect to skeleton but individual parallel streets may not.

**Two fixes:**

### 4a: Cross street T-junctions

When a cross street endpoint lands on a parallel street, call `graph.splitEdge(edgeId, x, z)` to insert a proper junction node. Currently endpoints land near parallels but aren't topologically connected.

### 4b: Full zone connectivity

After `connectToNetwork`, verify: every local road node has a path through the graph to a skeleton node. For any disconnected component, pathfind a connector road to the nearest skeleton node.

Add as an invariant check (step 2 above): `allLocalRoadsReachSkeleton`.

**Files:**
- Modify: `src/city/pipeline/layoutRibbons.js` (T-junction splitting)
- Modify: `src/city/pipeline/connectToNetwork.js` (multi-point connection for large zones)

---

## Step 5: Terrain Face Streets

**Why:** From `wiki/pages/terrain-face-streets.md` — the current ribbon layout picks one orientation per zone (slope direction or nucleus direction). On zones with varying terrain — a mix of slope directions, ridges, valleys — this produces inconsistent streets.

**What it does:**

1. Segment each zone into terrain faces (cells with consistent slope direction, within ~30°)
2. Each face gets its own ribbon layout:
   - Flat faces → regular grid toward nearest road
   - Moderate slope → contour ribbons with uphill cross streets
   - Steep → tighter terraces
3. Face boundaries → roads (ridgelines, valley floors become natural street corridors)

**Dependency:** Requires PipelineRunner (step 1) so terrain face segmentation can be a named sub-step. Requires clean zone polygons (done — Phase 5 gives us polygon + cells per zone).

**Files:**
- New: `src/city/pipeline/segmentTerrainFaces.js`
- Modify: `src/city/pipeline/layoutRibbons.js` (per-face layout within zones)

---

## Step 6: Generator Growth Strategies

**Why:** From `pipeline-abstraction.md` — the growth tick is currently one monolithic function in `growthTick.js`. Converting it to a generator unlocks: sub-step observability (inspect state between influence and allocation), sub-step invariant checks, and eventually the planned/haussmann growth strategies.

**What to build:**

```js
function* organicGrowthPipeline(map, archetype) {
  const state = initGrowthState(map, archetype);
  while (state.tick < archetype.growth.maxGrowthTicks) {
    state.tick++;
    yield step(`growth-${state.tick}:influence`, () => computeInfluenceLayers(...));
    yield step(`growth-${state.tick}:value`,     () => composeAllValueLayers(...));
    yield step(`growth-${state.tick}:allocate`,  () => allocateFromValueBitmap(...));
    yield step(`growth-${state.tick}:roads`,     () => growRoads(...));
    if (isDone(state)) break;
  }
}
```

This unlocks: stopping the pipeline at `growth-3:influence` to inspect value layers before allocation — the primary debugging use case from `pipeline-observability.md`.

**Files:**
- New: `src/city/pipeline/organicGrowthPipeline.js`
- Modify: `src/city/pipeline/cityPipeline.js` (use generator for growth)
- Modify: `src/city/pipeline/growthTick.js` (keep as compatibility wrapper)

---

## Step 7: Update Stale Documentation

Several docs describe the old state:

| File | What's stale |
|------|-------------|
| `wiki/pages/city-generation-pipeline.md` | Tick 3 still described as bitmap flood-fill; Phase 5 changed this to graph faces |
| `wiki/pages/bitmap-pipeline-model.md` | Lists `buildability` as a static layer; removed, replaced by `terrainSuitability` |
| `wiki/pages/pipeline-invariant-tests.md` | Target `<30s` suite — update with actual timings |
| `specs/v5/road-network-abstraction.md` | Says "Status: Proposal (not implemented)" — done |
| `specs/v5/feature-map-architecture.md` | Says "Status: Proposal (not implemented)" — done |

---

## Dependency Order

```
Step 1: PipelineRunner + generator
    │
    ├── Step 2: Invariant testing (hooks on runner)
    │
    ├── Step 3: Zone re-extraction loop (new step in pipeline)
    │
    ├── Step 4: Street connectivity (uses graph split, adds connectivity invariant)
    │
    ├── Step 5: Terrain face streets (sub-steps within layoutRibbons)
    │
    └── Step 6: Generator growth strategies (growth tick becomes generator)
```

Step 7 (docs) can happen any time — no code dependency.

---

## What We're Not Doing Yet

These are real ambitions in the wiki but out of scope for this sequence:

- **Planned growth strategy** (`plannedGrowthPipeline`) — needs step 6 first
- **Haussmann hybrid strategy** — needs step 6 first
- **Commercial as pure road frontage** — needs zone re-extraction loop (step 3) first
- **Zone-level coarse allocation** — current cell-BFS works; refine later
- **Per-use-type land value** — generic `landValue` works; `bitmap-pipeline-model.md` suggests retiring it eventually
- **Building instancing** — visual optimisation, separate concern
- **River generation rethink** — still broken at regional scale; large separate effort
