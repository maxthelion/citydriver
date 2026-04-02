# Pipeline Step Contracts

## Goal

Make each pipeline step's inputs and outputs machine-checkable rather than
advisory comments. Enable isolated development and testing of individual steps
by defining clear boundaries around what each step reads and writes.

This spec covers:
1. The pipeline context object — replacing inconsistent argument signatures
2. The `FeatureMap` state audit — what lives where
3. The contract format
4. The directory structure for enforced isolation
5. What the OSM road model work and the event log change about this

---

## Why Now

The current model has two problems.

**Inconsistent step signatures.** Steps take varying combinations of arguments
with no consistent pattern:

```js
buildSkeletonRoads(map)
computeLandValue(map)
reserveLandUse(map, archetype)
runAllocatePhase(map, archetype, state, valueLayers, devProximity)
growRoads({ roadGrid, waterMask, ribbonGaps, ..., roadNetwork })
```

**`FeatureMap` is a god object.** Every step can read or write anything on it.
Reads/writes are documented in comments but not enforced:

```js
// Reads: slope, waterMask, waterDist, terrainSuitability, nuclei
// Writes: landValue
export function computeLandValue(map) { ... }
```

This means:
- A step can silently read state it hasn't declared
- A step can silently write state another step expects to own
- You can't run a step in isolation without a full `FeatureMap` populated by
  all previous steps
- Agents working on one step can accidentally break another

---

## Part 1: The Pipeline Context Object

All steps should take a single `ctx` object as their argument. This eliminates
the inconsistent signatures and makes the boundary between world state,
configuration, and observability explicit.

### Shape

```js
const ctx = {
  // World state — checkpointable, serialisable to a fixture
  map,

  // Configuration — fixed for the whole run, needed to reproduce from a fixture
  archetype,
  seed,

  // Ephemeral inter-step state — valid only during a run, not part of a fixture
  growthState,       // growth tick progress across ticks
  influenceLayers,   // scratch passed between influence → value sub-steps
  valueLayers,       // scratch passed between value → allocate sub-steps

  // Observability — side channel, does not affect computation
  eventSink,
};
```

### Three distinct lifecycles

| Sub-object | Lifecycle | In fixture? |
|---|---|---|
| `ctx.map` | Modified by each step | Yes — the checkpoint |
| `ctx.archetype`, `ctx.seed` | Fixed for the whole run | Yes — needed to reproduce |
| `ctx.growthState`, `ctx.influenceLayers`, `ctx.valueLayers` | Valid only during a run | No |
| `ctx.eventSink` | Observer, cleared between runs | No |

A fixture is `{ map: serialisedMap, archetype, seed }`. Replay reconstructs
the full context from those three things.

### Step signature

```js
export function computeLandValue(ctx) {
  const { map } = ctx;
  const slope = map.getLayer('slope');
  // ...
  map.setLayer('landValue', grid);
}

export function runAllocatePhase(ctx) {
  const { map, archetype, growthState, influenceLayers, eventSink } = ctx;
  // ...
}

export function reserveLandUse(ctx) {
  const { map, archetype } = ctx;
  // ...
}
```

### PipelineRunner change

Steps are currently called as `descriptor.fn()` with no arguments — they close
over `map` and other state. To make steps properly injectable and testable in
isolation, `PipelineRunner` should pass `ctx` explicitly:

```js
// current
yield step('land-value', () => computeLandValue(map));

// proposed
yield step('land-value', (ctx) => computeLandValue(ctx));
```

`PipelineRunner.advance()` passes `ctx` to each step function:

```js
const result = descriptor.fn(this._ctx);
```

The generator receives `ctx` as a constructor argument and closes over it for
the `yield step(...)` calls. Steps themselves receive it explicitly, which
makes them pure functions that can be called directly in tests:

```js
// test
const ctx = { map: fixtureMap, archetype: ARCHETYPES.marketTown, seed: 42, eventSink: new ArrayEventSink() };
computeLandValue(ctx);
expect(ctx.map.getLayer('landValue')).toBeDefined();
```

### What moves off `FeatureMap`

The ephemeral category D state (`_influenceLayers`, `_valueLayers`,
`growthState`) moves from `FeatureMap` direct properties onto `ctx`. The event
sink moves from the proposed `map.runContext` onto `ctx.eventSink`. The map
itself becomes purely spatial world state.

---

## Part 2: FeatureMap State Audit

With the context object handling ephemeral and observability state, `FeatureMap`
needs to be cleaned up to hold only world state. Currently it mixes four
categories.

### Category A: Setup context (read-only, set once in `setup.js`)

These are never written by pipeline steps. They describe what the map
represents, not what has been computed. They stay as direct properties —
they are permanent context about the city, not pipeline outputs.

| Property | Type |
|----------|------|
| `map.width`, `map.height`, `map.cellSize` | scalar |
| `map.originX`, `map.originZ` | scalar |
| `map.seaLevel` | scalar |
| `map.settlement` | object |
| `map.regionalLayers` | LayerStack |
| `map.regionalSettlements` | array |
| `map.nuclei` | array — placed before pipeline runs, read-only thereafter |
| `map.station` | object — placed in setup |

### Category B: Grids duplicated as both direct property and named layer

Setup sets these as both `map.elevation = grid` and
`map.setLayer('elevation', grid)`. The duplication makes contracts ambiguous —
a step reading `map.slope` and one reading `map.getLayer('slope')` get the
same object but the access pattern is inconsistent.

| Property | Named layer | Action |
|----------|-------------|--------|
| `map.elevation` | `elevation` | Remove direct property, use layer only |
| `map.slope` | `slope` | Same |
| `map.waterMask` | `waterMask` | Same — `FeatureMap` internal methods must also use `getLayer` |
| `map.waterType` | `waterType` | Same |
| `map.waterDepth` | `waterDepth` | Same |
| `map.waterDist` | `waterDist` | Same |
| `map.landValue` | `landValue` | Same |
| `map.railwayGrid` | — | Add as named layer, remove direct property |

`setup.js` sets named layers only. All pipeline steps read via `map.getLayer()`.

### Category C: Structured pipeline outputs (move to data bag)

These are outputs of specific pipeline steps, read by downstream steps. They
are currently on direct properties.

| Property | Set by | Read by |
|----------|--------|---------|
| `map.developmentZones` | `extractZones` | ~10 downstream files |
| `map.reservationZones` | `reserveLandUse` | `collectParcels` |
| `map.parcels` | `collectParcels` | `subdividePlots`, rendering |

**Action:** Add `setData(name, value)` / `getData(name)` / `hasData(name)` to
`FeatureMap`, mirroring the `LayerStack` API. Move these to the data bag:

```js
// before
map.developmentZones = zones;
const zones = map.developmentZones;

// after
map.setData('developmentZones', zones);
const zones = map.getData('developmentZones');
```

This gives all pipeline outputs a single consistent access pattern.

Note: `growthState` was previously in this category, but moves to `ctx` instead
— it is ephemeral run state, not a persistent world output.

### Category D: Ephemeral scratch state (move to `ctx`)

These exist only to pass data between sub-steps within a single run. They are
not world state and should not be on `FeatureMap` at all.

| Property | Notes | Destination |
|----------|-------|-------------|
| `map._influenceLayers` | Passed influence → value | `ctx.influenceLayers` |
| `map._valueLayers` | Passed value → allocate | `ctx.valueLayers` |
| `map.growthState` | Growth tick progress | `ctx.growthState` |

With the context object, these are natural fields on `ctx` rather than map
mutations.

---

## Part 3: Contract Format

Once state is cleanly separated, each step's contract can be expressed as a JS
object in `src/city/pipeline/contracts/`:

```js
// src/city/pipeline/contracts/steps/land-value.js
export const landValueContract = {
  reads: {
    layers:  ['slope', 'waterMask', 'waterDist', 'terrainSuitability'],
    data:    [],
    ctx:     [],        // no ctx fields beyond map needed
  },
  writes: {
    layers:  ['landValue'],
    data:    [],
  },
  postconditions: [
    'landValue layer exists',
    'all water cells have landValue === 0',
    'all values in range [0, 1]',
  ],
};
```

```js
// src/city/pipeline/contracts/steps/extract-zones.js
export const extractZonesContract = {
  reads: {
    layers:  ['roadGrid', 'waterMask', 'landValue', 'terrainSuitability'],
    data:    [],
    ctx:     [],
    graph:   true,
  },
  writes: {
    layers:  ['zoneGrid'],
    data:    ['developmentZones'],
  },
  postconditions: [
    'developmentZones is non-empty array',
    'zoneGrid covers same cells as union of zone.cells',
    'no zone cell is a water cell',
  ],
};
```

```js
// src/city/pipeline/contracts/steps/growth-allocate.js
export const growthAllocateContract = {
  reads: {
    layers:  ['reservationGrid', 'zoneGrid', 'terrainSuitability'],
    data:    ['developmentZones'],
    ctx:     ['archetype', 'growthState', 'influenceLayers'],
  },
  writes: {
    layers:  ['reservationGrid'],
    data:    [],
    ctx:     ['growthState'],
  },
  postconditions: [
    'all reservationGrid values are valid RESERVATION enum values',
    'no water cell is reserved',
  ],
};
```

The `ctx` reads/writes track which context fields a step uses, making the full
dependency graph explicit.

### Runtime enforcement

A lightweight check wraps any step with a Proxy on `map.layers`, `map._data`,
and `ctx` that records accesses and asserts they match the declared contract.
Opt-in per step, zero-cost in production. Runs in tests and invariant hooks.

---

## Part 4: Directory Structure

```
src/city/pipeline/
  contracts/                    ← read-only, owned by architect
    steps/
      skeleton.js
      boundaries.js
      land-value.js
      zones.js
      zone-boundary.js
      spatial.js
      growth-influence.js
      growth-value.js
      growth-allocate.js
      growth-roads.js
      parcels.js
      plots.js
      connect.js
  skeleton/
    index.js
    CLAUDE.md
  land-value/
    index.js
    CLAUDE.md
  zones/
    index.js
    CLAUDE.md
  spatial/
    index.js
    CLAUDE.md
  growth/
    index.js
    allocate.js
    influence.js
    value.js
    ribbons.js
    roads.js
    CLAUDE.md
  parcels/
    index.js
    CLAUDE.md
  connect/
    index.js
    CLAUDE.md
  PipelineRunner.js
  cityPipeline.js
```

Each `CLAUDE.md`:
```markdown
# [Step name] pipeline step

Only modify files in this directory.
The contracts in `../contracts/` are read-only — never edit them.
Do not import from other step directories directly.
All world state access goes through ctx.map.getLayer() / ctx.map.getData().
All run state access goes through ctx.archetype, ctx.growthState etc.
```

Enforcement via dependency-cruiser:
```js
forbidden: [{
  name: 'no-cross-step-imports',
  from: { path: 'src/city/pipeline/skeleton' },
  to:   { path: 'src/city/pipeline/(?!contracts|skeleton|PipelineRunner|cityPipeline)' },
}]
```

---

## Part 5: Impact of OSM Road Model Work

The OSM alignment work (`shared-node-road-cutover.md`) changes road internals —
`OsmWay[]` + `OsmNode[]` replace `RoadNetwork` / `PlanarGraph` / `roadGrid`.

The context object shape is **unaffected** — road representation is internal to
`ctx.map`. Steps that currently read `map.getLayer('roadGrid')` continue to do
so; `roadGrid` stays as a derived raster regardless of how roads are stored.

Road-touching step contracts change:

| Step | Current ctx.map writes | After OSM alignment |
|------|----------------------|---------------------|
| `skeleton` | `roadGrid`, `graph`, `roads` | `osmWays`, `osmNodes`, derived `roadGrid` |
| `zone-boundary` | `roadGrid`, `graph`, `roads` | Same |
| `growth-N:roads` | `roadGrid` (bypassed) | `osmWays` only |
| `connect` | `roads` | `osmWays` |

**Recommendation:** Define contracts for non-road steps now. Flag road-related
step contracts as **provisional** — define against current model, expect update
when OSM cutover lands.

---

## Part 6: Impact of Event Log

`ctx.eventSink` replaces the previously proposed `map.runContext.eventSink`.
The sink is part of the context, not the world state:

```js
// before (proposed on map)
map.runContext = { eventSink: new NdjsonEventSink(path) };

// after (on ctx)
const ctx = { map, archetype, seed, eventSink: new NdjsonEventSink(path) };
```

Steps that emit events destructure `eventSink` from `ctx`. It does not appear
in `reads` or `writes` contract declarations — it is a side channel that does
not affect computation. A step that emits events has the same contract as one
that doesn't.

---

## Migration Order

1. **Define `PipelineContext`** — a plain JS object type, no class needed.
   Update `cityPipeline` generator to construct and close over it.

2. **Update `PipelineRunner`** to pass `ctx` to step functions:
   `descriptor.fn(ctx)`.

3. **Update step signatures** to take `ctx` — start with the steps that
   currently take extra arguments (`reserveLandUse`, `runAllocatePhase`) as
   these get the most immediate benefit.

4. **Move category D off `FeatureMap`** — `_influenceLayers`, `_valueLayers`,
   `growthState` onto `ctx`. No downstream impact beyond the growth steps.

5. **Add `setData/getData/hasData` to `FeatureMap`** — additive, no behaviour
   change.

6. **Move category C to data bag** — `developmentZones`, `reservationZones`,
   `parcels`. This is the most impactful change; `developmentZones` is read
   in ~10 files.

7. **Remove category B direct property duplication** — named layers only for
   `elevation`, `slope`, `waterMask` etc.

8. **Write contracts for non-road steps** in `contracts/steps/`.

9. **Split step files into per-step directories** with `CLAUDE.md`.

10. **Add dependency-cruiser rules**.

11. **Add runtime contract enforcement** as an optional invariant hook.

12. **Write provisional contracts for road steps**.
