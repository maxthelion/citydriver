---
title: "Pipeline Abstraction"
category: "pipeline"
tags: [pipeline, architecture, design, generators, declarative, growth, composition]
summary: "Audit of the current implied pipeline structure, the problems it creates, and a design for an explicit composeable pipeline where the outer structure is fixed, growth strategies are archetype-selected, and sub-phase ordering within each strategy is algorithmic."
last-modified-by: user
---

## The Current Situation: An Implied Pipeline

There is no `Pipeline` concept in the code. The pipeline is an emergent property of a manually-written state machine in `LandFirstDevelopment`:

```js
tick() {
  this._tick++;

  if (this._phase === 'pipeline') {
    switch (this._tick) {
      case 1: this.map = buildSkeletonRoads(this.map); return true;
      case 2: this.map = computeLandValue(this.map);   return true;
      // ...
      case 5:
        if (this.archetype && this.archetype.growth) {
          this._phase = 'growth';
          // ...
        } else {
          this._phase = 'finish';
          // ...
        }
    }
  }

  if (this._phase === 'growth') { /* ... */ }
  if (this._phase === 'finish') { /* another switch */ }
}
```

The "pipeline" is the comment at the top of the file. The structure has no reifiable form — you can't inspect it, enumerate its steps, or hook into it without modifying the class.

### The growth tick sub-pipeline has the same problem

`runGrowthTick` in `growthTick.js` is itself a four-phase pipeline wired together imperatively in a 250-line function:

```
Phase 1 INFLUENCE → computeInfluenceLayers
Phase 2 VALUE     → composeAllValueLayers
Phase 2.5 ROADS   → throttled layoutRibbons (conditional)
Phase 3 ALLOCATE  → loop over agents (3 different allocator types)
Phase 4 ROADS     → growRoads (only if ribbon gaps produced)
                  → agriculture fill
```

Phases pass data between them informally — `devProximity` from phase 1 is used as a filter in phase 3, `allRibbonGaps` collected in phase 3 is consumed by phase 4. No named boundaries, no external hookability.

### Multiple strategies already exist, but don't compose

`skeletonStrategies.js` has three alternative skeleton algorithms (A*, straight-line, topology-first). These show the pattern exists, but there's no structural mechanism for composing or selecting between them — they're standalone functions with no shared infrastructure and no way for an archetype to choose between them.

---

## What Problems This Creates

### 1. Observability requires bespoke code

To time or log a specific step, you have to either wrap `tick()` as a whole (coarse) or modify the interior of the strategy class (invasive). The [[pipeline-performance|benchmark profiler]] can only attach at outer tick boundaries; it can't see inside a growth tick without changes to `runGrowthTick`.

### 2. Step identity is fragile

Step names like `'growth-3'` are computed externally by inspecting `_growthState.tick`. If the state machine changes, the profiler's label logic silently breaks. Step identity isn't an owned concept.

### 3. New strategies can't share infrastructure

`DesireLines` and `LandFirstDevelopment` share nothing despite both needing skeleton roads, observability hooks, and a `PipelineRunner`. Each reimplements its own state machine from scratch.

### 4. Growth tick sub-steps aren't individually steppable

The debug screen advances one outer tick at a time. A single growth tick runs all four sub-phases synchronously. There's no way to stop after "influence computed, before allocation" to inspect the value layers — even though that's exactly what you want when diagnosing why a land use zone grew in the wrong direction.

---

## The Right JavaScript Primitive: Generators

The core requirement is **pauseable, resumeable execution with named steps**. JavaScript generators satisfy this without a framework. A generator function *is* the pipeline definition; `generator.next()` is a tick.

```js
function step(id, fn) {
  return { id, fn };  // yielded value — the runner executes fn() and records timing
}
```

The runner interprets yielded descriptors:

```js
class PipelineRunner {
  constructor(gen) {
    this._gen = gen;
    this._done = false;
    this.hooks = [];
  }

  advance() {
    if (this._done) return false;
    const { value: descriptor, done } = this._gen.next(this._lastResult);
    if (done) { this._done = true; return false; }

    const t0 = performance.now();
    for (const h of this.hooks) h.onBefore?.(descriptor.id);
    this._lastResult = descriptor.fn();
    const durationMs = performance.now() - t0;
    for (const h of this.hooks) h.onAfter?.(descriptor.id, this._lastResult, durationMs);
    return true;
  }

  addHook(hook) { this.hooks.push(hook); return this; }
}
```

`yield*` composes generators transparently — the runner sees every `yield` at any nesting depth as a single `advance()` call.

---

## The Outer Pipeline: Fixed Structure

The outer sequence — terrain, skeleton, land value, zones, spatial layers, growth, finish — is the same for every city. All archetypes need these steps. The outer pipeline generator is not archetype-specific:

```js
function* cityPipeline(map, archetype, rng) {
  yield step('skeleton',   () => buildSkeletonRoads(map));
  yield step('land-value', () => computeLandValue(map));
  yield step('zones',      () => extractZones(map));
  yield step('spatial',    () => computeSpatialLayers(map));

  // Growth strategy: selected by archetype, not hardcoded
  const growthGen = resolveGrowthStrategy(archetype);
  yield* growthGen(map, archetype);

  yield step('connect', () => connectToNetwork(map));
}
```

`resolveGrowthStrategy` maps an archetype's `growthStrategy` field to a generator function. This is the point at which archetype data selects pipeline structure.

---

## Growth Strategies: Archetype-Selected, Not Hardcoded

This is where the earlier version of this page was wrong.

The claim was: "phase ordering within growth ticks is algorithmic, not archetype-specific, and shouldn't be configurable." That's correct for the sub-phase ordering *within* a strategy. But it missed that **planned and organic cities have genuinely different growth algorithms** — different enough to need different generator functions, not just different parameters.

### Organic growth (current model)

Land pressure drives road placement. Influence and value layers are computed, land is allocated, then roads grow to serve the claimed cells. Roads follow demand.

```
each tick:
  influence → value → [roads pre] → allocate agents → roads post → agriculture
```

### Planned growth (grid town, colonial)

Roads are imposed first. The master street grid is extended based on a plan (not demand), and land use fills in the resulting blocks. Roads create supply; allocation follows.

```
each tick:
  extend street grid → identify blocks from enclosed faces → assign uses to blocks
```

These two are not the same algorithm with different parameters — the ordering of road vs allocation is inverted between them. **The choice of growth strategy IS a structural pipeline decision, and it IS archetype-specific.**

### What goes in config, what goes in code

| | Config (archetype data) | Code (generator) |
|---|---|---|
| Which growth strategy | `growthStrategy: 'organic'` | `organicGrowthPipeline` generator function |
| Which skeleton strategy | `skeletonStrategy: 'astar'` | `astarSkeletonPipeline` generator function |
| Which agents run | `agentPriority: [...]` | Iteration inside `organicGrowthPipeline` |
| Agent parameters | `agents: { share, budgetPerTick, ... }` | Read by the generator |
| Phase ordering within a strategy | ✗ not configurable | Fixed in the generator |
| Whether roads precede or follow allocation | ✗ not configurable | Determined by which generator is selected |

The last row is the key distinction. The archetype says *which strategy* to use (data). The generator determines what that strategy does and in what order (code). You don't need a `phases: ['influence', 'value', ...]` array in the archetype config — that would expose implementation details as fake configuration.

---

## Growth Strategies as Composeable Generators

With generators, composition is `yield*`. Strategies can share sub-generators for common phases:

```js
// Shared by organic and planned: both need influence layers for scoring
function* influencePhase(map, archetype, state, tick) {
  return yield step(`growth-${tick}:influence`,
    () => computeInfluenceLayers(map.getLayer('reservationGrid'),
                                  map.width, map.height,
                                  archetype.growth.influenceRadii, map.nuclei)
  );
}

// Organic growth: allocation first, roads follow
function* organicGrowthPipeline(map, archetype) {
  const state = initGrowthState(map, archetype);
  while (true) {
    state.tick++;
    if (state.tick > archetype.growth.maxGrowthTicks) break;

    const influence = yield* influencePhase(map, archetype, state, state.tick);
    const value     = yield* valuePhase(map, archetype, state, state.tick, influence);

    yield step(`growth-${state.tick}:roads-pre`,
      () => throttledRibbonLayout(map, influence.developmentProximity, state));

    const { ribbonGaps, ribbonEndpoints, done } =
      yield* allocateAgents(map, archetype, state, state.tick, value);

    yield step(`growth-${state.tick}:roads-post`,
      () => growRoads({ roadGrid: map.getLayer('roadGrid'), ribbonGaps, ribbonEndpoints, ... }));

    if (done) break;
  }
}

// Planned growth: roads first, allocation fills blocks
function* plannedGrowthPipeline(map, archetype) {
  const state = initGrowthState(map, archetype);
  while (true) {
    state.tick++;
    if (state.tick > archetype.growth.maxGrowthTicks) break;

    // Roads first: extend the master street grid
    yield step(`growth-${state.tick}:extend-grid`,
      () => extendPlannedGrid(map, archetype, state));

    // Identify blocks created by the extended grid
    const blocks = yield step(`growth-${state.tick}:extract-blocks`,
      () => map.graph.facesWithEdges());

    // Assign land use to blocks (not cells)
    const influence = yield* influencePhase(map, archetype, state, state.tick);
    yield step(`growth-${state.tick}:assign-blocks`,
      () => assignUsesToBlocks(map, archetype, state, blocks, influence));

    if (allBlocksAssigned(state)) break;
  }
}

```

Notice that `influencePhase` is shared between `organicGrowthPipeline` and `plannedGrowthPipeline`. Both need influence layers (for scoring), but they use them differently — organic uses them to drive allocation, planned uses them to prioritise which blocks to assign first. Composition via `yield*` handles this without any special machinery.

### Hybrid strategies

A Hausmann-style city might run planned growth for the first few ticks (lay out the grands boulevards), then switch to organic fill within the resulting blocks:

```js
function* haussmannGrowthPipeline(map, archetype) {
  // Phase A: impose the boulevard framework (N ticks)
  const boulevardState = initPlannedState(map, archetype);
  for (let i = 0; i < archetype.growth.boulevardTicks; i++) {
    yield* plannedTick(map, archetype, boulevardState);
  }

  // Phase B: organic infill within established blocks
  const infillState = initGrowthState(map, archetype);
  while (true) {
    // ...organic ticks constrained to cells within the planned blocks...
    const done = yield* organicTick(map, archetype, infillState);
    if (done) break;
  }
}
```

This is not possible at all in the current state-machine model. With generators it's a few lines of control flow.

---

## Strategy Registry

The archetype config references a strategy by name. A registry maps names to generator functions:

```js
const GROWTH_STRATEGIES = {
  organic:   organicGrowthPipeline,
  planned:   plannedGrowthPipeline,
  haussmann: haussmannGrowthPipeline,
};

function resolveGrowthStrategy(archetype) {
  const name = archetype.growthStrategy ?? 'organic';
  const gen = GROWTH_STRATEGIES[name];
  if (!gen) throw new Error(`Unknown growth strategy: ${name}`);
  return gen;
}
```

Archetype config gains one field:

```js
marketTown: {
  growthStrategy: 'organic',    // new — was implied by having a 'growth' block
  growth: { ... },              // unchanged
},

gridTown: {
  growthStrategy: 'planned',
  growth: { ... },
},
```

The `DesireLines` class (`src/city/strategies/desireLines.js`) currently has its own state machine — it becomes `desireLinesPipeline`, registered in `GROWTH_STRATEGIES`.

---

## What the Outer Pipeline Can Also Compose

The same principle applies to the skeleton step. `skeletonStrategies.js` already has three skeleton algorithms. The outer pipeline can select one:

```js
function* cityPipeline(map, archetype) {
  const skeletonGen = resolveSkeletonStrategy(archetype);
  yield* skeletonGen(map, archetype);   // 'astar' | 'desireLines' | 'topology'

  yield step('land-value', () => computeLandValue(map));
  yield step('zones',      () => extractZones(map));
  yield step('spatial',    () => computeSpatialLayers(map));

  const growthGen = resolveGrowthStrategy(archetype);
  yield* growthGen(map, archetype);

  yield step('connect', () => connectToNetwork(map));
}
```

An archetype can pair any skeleton strategy with any growth strategy:

```
marketTown:  skeleton=astar,     growth=organic
gridTown:    skeleton=topology,  growth=planned
portCity:    skeleton=astar,     growth=organic   (with waterfront params)
```

This is not possible today — `DesireLines` has its own skeleton built in, and changing it would mean rewriting the class.

---

## Where the Line Is Drawn

Three levels. The distinction matters:

| Level | Controlled by | Examples |
|---|---|---|
| **Strategy selection** | Archetype config | `growthStrategy: 'planned'` |
| **Phase ordering within a strategy** | Generator code | Influence before value; roads after ribbon allocation |
| **Phase parameters** | Archetype config | Agent budgets, influence radii, grid spacing |

Level 1 is data. Level 2 is code. Level 3 is data. The middle level must stay in code — it encodes algorithmic constraints that can't be safely relaxed. For planned growth, roads must precede block extraction (you need the face graph to know what the blocks are). For organic growth, allocation must precede road growth (ribbon gaps are produced by allocation). Exposing these orderings as configurable arrays would let a config author violate them without any enforcement.

---

## How This Enables Observability

With named steps and a hook-based runner, all observability tools become hooks:

```js
const runner = new PipelineRunner(cityPipeline(map, archetype))
  .addHook({
    onAfter(id, _, durationMs) { timingLog.push({ id, durationMs }); }
  })
  .addHook({
    onAfter(id) {
      if (id.includes(':allocate:')) {
        bitmapLogger.log(id, 'reservationGrid',
          map.getLayer('reservationGrid'), 'reservation');
      }
    }
  });
```

Both the [[pipeline-performance|benchmark profiler]] and the [[pipeline-observability|bitmap tracer]] become hooks — no bespoke code, no strategy modification. Both work identically across `organicGrowthPipeline`, `plannedGrowthPipeline`, and `desireLinesPipeline` because they all emit the same `step(id, fn)` descriptors.

---

## Migration Path

1. **Extract `organicGrowthPipeline`** generator from `runGrowthTick`. Keep `runGrowthTick` as a wrapper for backward compatibility.
2. **Convert `DesireLines` class** to a `desireLinesPipeline` generator function. Register in `GROWTH_STRATEGIES`.
3. **Add `growthStrategy` field** to archetype configs. Default to `'organic'` to keep existing behaviour.
4. **Extract the outer `cityPipeline`** generator. Replace `LandFirstDevelopment`'s state machine with `PipelineRunner`.
5. **Add `skeletonStrategy` field** to archetypes. Convert `skeletonStrategies.js` functions to generators. Register in `SKELETON_STRATEGIES`.
6. **Implement `plannedGrowthPipeline`** for grid-town archetypes. This is the first genuinely new strategy; the infrastructure must exist before it can be built.

---

## Summary

| Aspect | Current | Proposed |
|---|---|---|
| Pipeline structure | Implied by state machine | Generator function |
| Growth strategy | Hardcoded organic logic | Archetype-selected generator from registry |
| Strategy composition | Not possible | `yield*` sub-generators |
| Shared sub-steps | None — each strategy reimplements | Shared generators (`influencePhase`, etc.) |
| Phase ordering within strategy | Hardcoded | Fixed in generator — correctly not configurable |
| Phase selection (organic vs planned) | Hardcoded if/else | Archetype data selects from registry |
| Observability | Bespoke wrapping per strategy | Hooks on `PipelineRunner`, strategy-agnostic |
| Hybrid strategies (boulevards then infill) | Not possible | Ordinary generator control flow |
