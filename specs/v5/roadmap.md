# Roadmap

A sequenced plan tying together the architecture and experimentation specs
written in March 2026. Each phase has explicit dependencies on what comes
before it.

---

## Currently Running (Parallel Track)

**OSM / shared-node road cutover** — `shared-node-road-cutover.md`

In progress on the `feature/incremental-streets` worktree. Replaces the
`RoadNetwork`/`PlanarGraph` dual-representation with shared-node `OsmWay`/
`OsmNode`. This is the fix for the topology problems in the current seam and
junction work, and also resolves the six bypass violations in
`road-network-abstraction.md` as a side effect.

All other phases below run independently of this unless noted.

---

## Phase 1 — Experiment Acceleration

**Spec:** `experiment-acceleration-plan.md`
**Depends on:** nothing (can start now)
**Blocks:** Phase 3 (land allocation petri), Phase 4 (characterization tests)

The unlock for rapid iteration on the ideas in `functionality-overview.md`.
Can be started before the OSM cutover lands.

### 1a — Grid serialisation

Implement `saveMapFixture` / `loadMapFixture` for grid layers only. Two-file
format: binary grid data (`.bin`) + JSON index and metadata (`.json`). Roads
serialised as polylines — road-model agnostic, valid before and after OSM
cutover.

**Done when:** can save and reload a complete map state from disk.

### 1b — Fixture generation script

`scripts/save-fixture.js --seed N --step zones-refine [--crop-zone Z --margin M]`

Generates fixture files for the standard seeds. Cropped zone fixtures are
the immediate win for ribbon and cross-street experiments — a ~150×150 cell
crop vs the full 1200×1200 grid is 64× smaller.

**Done when:** three reference fixtures exist for seeds 42, 99, 884469.

### 1c — Growth experiment scripts load fixtures

Update `render-pipeline.js` (and growth-specific render scripts) to accept
`--fixture path` as an alternative to `--seed`. Skips `generateRegion` and
`setupCity`, loads fixture, runs only the requested steps.

**Done when:** `render-growth.js --fixture ... --archetype marketTown` works
end-to-end and renders output.

### 1d — Parallel variant execution

`scripts/run-variants.js` — loads one fixture, runs N variant configs in
parallel (worker processes or Promise.all), collects all outputs into one
experiment directory. Viewer shows them side by side.

**Done when:** can compare three archetype variants for the same seed in one
command.

---

## Phase 2 — Land Allocation Experiments

**Spec:** `functionality-overview.md` (ideas), `experiment-acceleration-plan.md` (infrastructure)
**Depends on:** Phase 1c (fixtures in growth scripts)
**Blocks:** Phase 3 (petri loop needs a working baseline to evaluate against)

With fixtures in place, start experimenting with the land allocation ideas:

- Archetype tick ordering (`agentPriority` arrays)
- Budget granularity (cells claimed per tick)
- Industrial downwind weighting
- Commercial anchoring to roads
- Residential as late fill vs progressive

Each experiment is a variants config run against the post-zones-refine fixture.
Output goes into the standard experiment directory and viewer.

**No new infrastructure needed** — this phase is about running experiments,
not building tools. Use the experiment loop discipline from `experiment-loop.md`.

**Done when:** a working baseline exists for each of the five archetypes in
`functionality-overview.md` (harbour, port, market town, industrial, civic)
that produces plausible land use distribution.

---

## Phase 3 — Land Allocation Petri Loop

**Spec:** `experiment-acceleration-plan.md` §Phase 4
**Depends on:** Phase 1d (parallel variants), Phase 2 (working baseline)

Write a petri rubric for land allocation quality — land use coverage,
distribution balance, spatial coherence, density gradient, artifact freedom.
Hook into the existing petri infrastructure (`citygenerator-petri`) with a new
rubric file and baseline renders.

The petri loop then runs variant configs automatically, evaluates against the
rubric, and promotes the best configuration as the new baseline.

**Done when:** petri loop can run a land allocation experiment overnight and
produce a scored verdict.

---

## Phase 4 — Characterization Hashes (Refactor Safety Net)

**Spec:** `characterization-tests.md`
**Depends on:** Phase 1a (serialisation, for fixture-based hash computation)
**Blocks:** Phase 5 (must exist before the structural refactor starts)
**Note:** Do this immediately before Phase 5, not before

Generate MD5 hashes of each step's output layers for the reference seeds.
Commit as golden files. The purpose is purely to confirm that the structural
refactors in Phase 5 are behaviour-neutral.

```bash
bun scripts/generate-character.js --seeds 42,99,884469
```

Also render reference PNG outputs for each step, stored alongside the golden
files. When a hash changes during the refactor, the image comparison shows
what shifted.

**Done when:** golden files committed for all pipeline steps × 3 seeds.

---

## Phase 5 — Structural Refactors

**Spec:** `pipeline-step-contracts.md`
**Depends on:** Phase 4 (character hashes as safety net), OSM cutover landed
**Blocks:** Phase 6 (contracts need context object to be meaningful)

Do these after the OSM cutover lands so the road model doesn't need to change
twice during the refactor.

### 5a — PipelineContext object

Define the `PipelineContext` shape. Update `PipelineRunner` to pass `ctx` to
step functions. Update step signatures to take `ctx` instead of `map`.

Run character tests after each batch of step updates to confirm hashes are
unchanged.

### 5b — Move ephemeral state off FeatureMap

`_influenceLayers`, `_valueLayers`, `growthState` move to `ctx`. No downstream
impact beyond the growth steps.

### 5c — Add `setData/getData` to FeatureMap

`developmentZones`, `reservationZones`, `parcels` move from direct properties
to the data bag.

### 5d — Remove grid property duplication

`map.elevation`, `map.slope`, `map.waterMask` etc. exist as both direct
properties and named layers. Remove direct properties; use `getLayer` only.

**Checkpoint:** run character tests. All hashes should still match. If any
change, the refactor leaked.

---

## Phase 6 — Step Contracts and Isolation

**Spec:** `pipeline-step-contracts.md`
**Depends on:** Phase 5 (context object must exist)

### 6a — Write step contracts

Define `contracts/steps/*.js` for non-road steps first (unaffected by OSM):
`land-value`, `zones`, `spatial`, `growth-allocate`, `growth-influence`,
`growth-value`, `parcels`, `plots`. Road step contracts flagged provisional
until OSM cutover is confirmed stable.

### 6b — Per-step directories

Split flat `src/city/pipeline/` into per-step directories. Add `CLAUDE.md`
to each.

### 6c — Dependency-cruiser rules

Enforce no cross-step imports.

### 6d — Runtime contract enforcement

Optional invariant hook that proxies the layer/data bag and asserts no
undeclared reads or writes. Runs in tests, zero-cost in production.

---

## Phase 7 — OSM Export

**Spec:** `osm-road-model.md`
**Depends on:** OSM cutover stable, Phase 1a (serialisation exists)
**Independent of:** Phases 5–6

Add `src/core/exportGeoJSON.js` and `src/core/exportOSM.js`. A GeoJSON export
is the quick win — paste into geojson.io for instant visual validation. OSM
XML export enables JOSM and routing engine use.

Add a download button to the debug UI.

---

## Dependency Graph

```
OSM cutover (running) ──────────────────────────────────────┐
                                                             │
Phase 1a: grid serialisation ──┐                            │
Phase 1b: fixture scripts      │                            │
Phase 1c: growth loads fixtures┤                            │
Phase 1d: parallel variants    │                            │
                               │                            │
Phase 2: land alloc experiments┤                            │
                               │                            │
Phase 3: petri loop ───────────┘                            │
                                                            │
Phase 4: character hashes ──────────────────────────────────┤
                                                            │
Phase 5: structural refactors ──────────────────────────────┤
                                                            │
Phase 6: step contracts ────────────────────────────────────┘

Phase 7: OSM export (independent, after OSM cutover stable)
```

---

## What Is Not In This Roadmap

These specs exist but are not sequenced here — they are lower priority or
have unclear dependencies on current work:

- `ribbon-event-log-replay-plan.md` — replay tooling and viewer integration
  for event logs. The emission infrastructure exists; this is the debugging
  UI layer. Worthwhile but not blocking anything.
- `pipeline-event-log.md` — extending event emission to growth allocation and
  pathfinding steps. Can happen any time after Phase 5.
- `osm-road-model.md` Part 2 (internal alignment) — largely covered by the
  OSM cutover already running. Review after cutover lands.
- `characterization-tests.md` slow test replacement — reclassifying
  integration tests as fixture-based. A quality-of-life improvement that
  follows naturally from Phase 1 infrastructure being in place.
