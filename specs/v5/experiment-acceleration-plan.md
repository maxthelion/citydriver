# Experiment Acceleration Plan

## The Problem

Experimenting with land allocation strategies, archetype growth patterns, and
the ideas in `functionality-overview.md` is currently slow because every
experiment runs the full pipeline from scratch — region generation, city setup,
skeleton roads, zone extraction — before reaching the growth step you actually
want to vary. The feedback loop is too long to iterate quickly.

The goal is to reach a state where:
- A growth experiment starts from a pre-computed map state in milliseconds
- Multiple variants of the same experiment run in parallel
- Output renders are immediately comparable in the experiment viewer
- New strategies can be prototyped against mocked inputs before being tested
  against real terrain

---

## The Central Dependency: FeatureMap Serialisation

Everything else in this plan depends on being able to save and reload map
state at a specific pipeline step. This is the unlock.

The serialisation format should be **road-model agnostic** — roads are
serialised as polylines regardless of whether the internal representation is
the current `RoadNetwork`/`PlanarGraph` or the incoming OSM `OsmWay`/`OsmNode`
model. Structured data (zones, roads, nuclei) serialises as JSON. Grid layers
use a binary format.

```js
// save — writes two files
await saveMapFixture(map, 'test/fixtures/seed-42-after-zones');
// → test/fixtures/seed-42-after-zones.json  (metadata + structured data)
// → test/fixtures/seed-42-after-zones.bin   (packed binary grid layers)

// load
const map = await loadMapFixture('test/fixtures/seed-42-after-zones');
```

### Why binary for grids

A 1200×1200 float32 grid is 5.76MB as raw bytes. As JSON text it is ~50MB.
With 15+ layers per fixture the total grid data is ~80MB. At that scale JSON
parsing is a meaningful bottleneck — especially when parallel experiments load
the same fixture into multiple workers simultaneously, and when fixtures feed
character hash comparisons that require float32 precision (JSON float
serialisation loses bits in the text round-trip).

For small synthetic mock fixtures (100×100, used in tests) JSON is fine — the
parse cost is negligible and JSON is easier to construct by hand.

### The two-file format

**`seed-42-after-zones.json`** — readable, diffable, inspectable with `jq`:

```json
{
  "meta": {
    "seed": 42, "afterStep": "zones-refine",
    "width": 240, "height": 240, "cellSize": 5,
    "originX": 1200, "originZ": 4800, "seaLevel": 0
  },
  "layers": [
    { "name": "elevation",    "type": "float32", "offset": 0,      "bytes": 230400 },
    { "name": "slope",        "type": "float32", "offset": 230400, "bytes": 230400 },
    { "name": "waterMask",    "type": "uint8",   "offset": 460800, "bytes": 57600  },
    { "name": "landValue",    "type": "float32", "offset": 518400, "bytes": 230400 },
    { "name": "roadGrid",     "type": "uint8",   "offset": 748800, "bytes": 57600  },
    { "name": "zoneGrid",     "type": "uint8",   "offset": 806400, "bytes": 57600  }
  ],
  "data": {
    "developmentZones": [ ... ],
    "nuclei": [ ... ]
  },
  "roads": [
    { "polyline": [...], "width": 6, "hierarchy": "arterial" }
  ],
  "rivers": [ ... ]
}
```

**`seed-42-after-zones.bin`** — packed binary, one typed array buffer per
layer in the order defined by the JSON index. No encoding overhead.

Loading a layer:
```js
const { offset, bytes, type } = layerMeta;
const ArrayType = type === 'float32' ? Float32Array : Uint8Array;
const grid = new ArrayType(binBuffer, offset, bytes / ArrayType.BYTES_PER_ELEMENT);
```

This is a memcpy, not a parse. No dependencies beyond the Node.js `fs` module.
The implementation is ~50 lines.

`FeatureMap.clone()` already handles deep-copying everything in memory. The
serialisation layer is the missing piece.

---

## Recommended Order

### Phase 1 — The Unlock (do now, before OSM lands)

**1a. FeatureMap serialisation**

Implement `saveMapFixture(map, path)` and `loadMapFixture(path)`. Keep it
road-model agnostic — roads as polylines only. The OSM cutover changes the
internal representation but not the format.

**1b. Fixture generation script**

```bash
bun scripts/save-fixture.js --seed 42 --step zones-refine
# writes test/fixtures/seed-42-after-zones-refine.json + .bin
```

Runs the pipeline to the named step and writes a fixture. Run once per seed,
commit the fixtures. These become the starting point for all growth experiments.

### Cropped fixtures

For experiments focused on a specific zone or area — ribbon layout, cross-street
generation, plot subdivision — saving the entire 1200×1200 map is wasteful. A
zone of 5000 cells typically has a ~150×150 cell bounding box. With margin,
that's 22,500 cells vs 1.44M — 64× smaller. Each float32 layer drops from
5.76MB to ~90KB. An 80MB fixture becomes ~1.5MB and loads imperceptibly fast.

Two crop modes:

**Zone-centric** — expand the target zone's bounding box by a margin and crop
to that. The margin preserves surrounding road context needed for anchor road
detection and cross-street snapping:

```bash
bun scripts/save-fixture.js --seed 42 --step zones-refine \
  --crop-zone 7 --margin 50
# fixture contains zone 7 + 50-cell margin of surrounding context
```

**Area crop** — explicit bounding box in grid cells:

```bash
bun scripts/save-fixture.js --seed 42 --step zones-refine \
  --crop 400,200,600,400
```

What the crop does to each data type:

| Data | Crop behaviour |
|------|---------------|
| Grids | Sliced to bounding box, `originX`/`originZ` adjusted |
| Roads | Polylines clipped to bounds; segments straddling boundary truncated |
| Rivers | Same as roads |
| Zones | Only zones with cells inside the crop are kept; boundary zones lose cells |
| Planar graph | Nodes and edges outside the crop dropped |
| Nuclei | Only nuclei within the crop kept |

Partial boundary zones are the main awkward case. In practice the zone of
interest sits well inside the crop, so its cells are intact. The surrounding
zones are incomplete but irrelevant to the experiment.

Cropped fixtures are useful for single-zone algorithm work. For experiments
testing cross-zone behaviour — commercial spreading between zones, connectivity
between disconnected components — use a larger crop or the full fixture.

**1c. Growth experiment scripts that load fixtures**

Convert the growth experiment render scripts to optionally accept a fixture
path instead of running from scratch:

```bash
# current — full pipeline, slow
bun scripts/render-pipeline.js --seed 42 --archetype marketTown

# new — load fixture, run only growth steps, fast
bun scripts/render-growth.js --fixture test/fixtures/seed-42-after-zones-refine.json \
  --archetype marketTown --out experiments/NNN-output
```

The render-growth script loads the fixture, runs `spatial` → `growth-N` →
`connect`, and renders the result. The full pipeline overhead disappears.

At this point experimentation is already significantly faster.

---

### Phase 2 — Parallel Variants (after Phase 1)

With fixtures, the same starting state can be run through N variants
simultaneously. The experiment runner extends to accept multiple variant
configs:

```bash
bun scripts/run-variants.js \
  --fixture test/fixtures/seed-42-after-zones-refine.json \
  --variants variants/land-allocation-experiment.json \
  --experiment 040 \
  --out experiments/040-output
```

Where the variants file describes each run:
```json
[
  { "name": "baseline",      "archetype": "marketTown", "growth": { "agentPriority": ["residential", "commercial", "industrial"] } },
  { "name": "commercial-first", "archetype": "marketTown", "growth": { "agentPriority": ["commercial", "residential", "industrial"] } },
  { "name": "industrial-lead",  "archetype": "industrialTown" }
]
```

Each variant runs in a separate worker (or child process). Outputs land in the
same experiment directory and are all visible in the viewer side by side.

This is the setup for experimenting with the ideas in
`functionality-overview.md` — archetype tick ordering, land use priority,
budget sizes — without running the full pipeline for each hypothesis.

---

### Phase 3 — Mocked Fixtures (parallel with Phase 2)

Real terrain fixtures are realistic but slow to generate and can vary in
unpredictable ways. Mocked fixtures are constructed programmatically for
controlled experimentation:

```js
// scripts/make-mock-fixture.js
const map = buildMockMap({
  width: 100, height: 100, cellSize: 5,
  terrain: 'flat',          // flat, sloped, coastal
  zones: 'four-quadrants',  // four-quadrants, single, ring
  roads: 'cross',           // cross, grid, arterial-only
  railway: true,
});
saveMapFixture(map, 'test/fixtures/mock-flat-cross.json');
```

A mock fixture sets up the spatial layers, zone grid, road network, and nuclei
without any region generation. It constructs a FeatureMap that is realistic
enough for growth algorithm experiments but fully controlled.

This is already partially done — `growthTick.test.js` builds a stub map
manually. The mock fixture builder formalises this into a reusable tool that
produces fixture files, not just in-memory objects.

Mock fixtures are particularly useful for testing conditions that are rare or
hard to reproduce in real seeds — a zone right next to a railway, a coastal
zone, a city where all routes inland are steep.

---

### Phase 4 — Petri Loop Integration (after Phase 2)

The existing petri loop (`citygenerator-petri`) is set up for incremental
street experiments. The same infrastructure applies to growth/allocation
experiments with a different rubric.

A land allocation petri rubric would score:
- **Land use coverage** — what fraction of zone cells are allocated to some use
- **Distribution balance** — does the archetype's intended mix match the actual output
- **Spatial coherence** — commercial clusters near roads, industrial downwind, civic distributed
- **Density gradient** — higher density near centres and anchor roads
- **Absence of artifacts** — industrial adjacent to residential without buffer, landlocked zones

The petri loop then runs the variant scripts automatically, evaluates against
the rubric, and promotes the best configuration as the new baseline.

---

### Phase 5 — Structural Refactors (after OSM lands)

The context object (`pipeline-step-contracts.md`), per-step directory
structure, and contract enforcement are important for long-term code health but
are not on the critical path for experimentation.

Do them after the OSM work lands, in this order:

1. **Generate character hashes** of the current pipeline — the safety net
2. **Context object refactor** — all steps take `ctx` instead of `map`
3. **Run character tests** to confirm the refactor was behaviour-neutral
4. **Move category C/D state** off FeatureMap, add `setData/getData`
5. **Write step contracts** in `contracts/steps/`
6. **Per-step directories** with `CLAUDE.md`

The character hashes must come before the context object refactor — that is
the primary use case for them (see `characterization-tests.md`).

---

## Summary

| Phase | What | Enables | When |
|-------|------|---------|------|
| 1a | FeatureMap serialisation | Everything | Now |
| 1b | Fixture generation script | Fast experiment starts | Now |
| 1c | Growth scripts load fixtures | Quick iteration on growth | Now |
| 2 | Parallel variants | Side-by-side hypothesis testing | After Phase 1 |
| 3 | Mock fixture builder | Controlled conditions, edge cases | Alongside Phase 2 |
| 4 | Land allocation petri loop | Automated evaluation | After Phase 2 |
| 5a | Character hashes | Safe structural refactoring | After OSM lands |
| 5b | Context object + contracts | Code health, agent isolation | After 5a |

The OSM work is independent and runs in parallel with Phases 1–3.

---

## What This Unlocks for Functionality Overview Experiments

Once Phase 1 and 2 are in place, the ideas in `functionality-overview.md`
can be tested directly:

- **Archetype growth tick ordering** — load a zones-refine fixture, run with
  different `agentPriority` arrays, compare outputs
- **Budget granularity** — same fixture, vary `budgetPerTick`, see whether
  allocations become more or less blocky
- **Industrial downwind placement** — load a fixture with known wind direction,
  vary how much `downwindness` is weighted in the industrial value layer
- **Commercial anchoring to roads** — vary `roadFrontage` weight for commercial
  agent, compare spatial distribution
- **Residential as late fill** — test whether moving residential to the final
  tick produces better surrounding of other reservations

Each of these is a variant config that the parallel experiment runner handles.
The fixture stays constant; only the growth parameters change. Results are
immediately visible side by side in the viewer.
