# Pipeline Event Log

## Status

Partially implemented. The infrastructure exists in layers:

**Built:**
- `src/core/EventSink.js` — `EventSink` (no-op), `ArrayEventSink`, `NdjsonEventSink`,
  `FanoutEventSink`, `FilteredEventSink`
- `src/city/incremental/ribbons.js` — emits ribbon events when a sink is passed in
- `src/city/incremental/crossStreets.js` — emits cross-street events when a sink is passed in
- `scripts/run-experiment.js` — experiment runner that executes render scripts, writes
  PNG outputs and a `manifest.json`
- `experiments/index.html` — viewer that reads the manifest, displays PNGs grouped by
  seed with markdown descriptions alongside

**Gap:** None of the render scripts currently instantiate a sink and pass it
into ribbon/cross-street layout. The emission infrastructure is wired up but
never triggered in experiment runs. The viewer has no event log panel.

**What remains:**
- Wire `NdjsonEventSink` into the render scripts so events are actually written
- Extend the experiment viewer to display event logs alongside PNGs
- Extend the pattern to growth allocation, pathfinding, and zone extraction
- Build replay and filter tooling

## Relationship to Existing Observability

The PipelineRunner hook system already provides coarse, step-level events:

```js
runner.addHook({
  onBefore(stepId) { ... },
  onAfter(stepId, result, ms) { ... },
});
```

This is enough for timing, bitmap logging, and postcondition checks. It is not
enough for understanding *why* a step produced a particular output — what
decisions were made inside it, in what order, and why alternatives were
rejected.

The event log fills that gap. It operates below the step level, inside the
decision logic of individual steps.

## Two Tiers

Not all steps benefit equally from fine-grained events.

**Tier 1 — coarse (PipelineRunner hooks, already exists)**

Step started, step finished, duration, postconditions passed/failed. Sufficient
for raster steps where the output is directly inspectable as a bitmap layer
(land value, spatial layers, terrain suitability). No changes needed.

**Tier 2 — fine-grained (this spec)**

Steps that make sequences of decisions which compound — where knowing the final
output is not enough to understand why it looks the way it does. Candidates:

- Growth tick allocation (`growth-N:allocate`) — why did cell X get claimed by
  industrial rather than residential?
- Road pathfinding (`skeleton`, `connect`, `growth-N:roads`) — why did the
  path go this way rather than that?
- Zone extraction (`zones`, `zones-refine`) — why did this face form with these
  boundaries?
- Ribbon layout (`growth-N:ribbons`, `ribbons`) — why did this family terminate
  here? (See `ribbon-event-log-replay-plan.md` for the full ribbon-specific design.)

The event log is optional, per-step, and zero-cost when disabled.

## Core Design

### EventSink — already built

`src/core/EventSink.js` exports four classes:

- **`EventSink`** — base class, no-op `emit()`, monotonic `next()` sequence counter
- **`ArrayEventSink`** — collects events into `this.events[]`, used in tests
- **`NdjsonEventSink`** — writes NDJSON to a file, used in experiment renders
- **`FanoutEventSink`** — broadcasts to multiple sinks simultaneously
- **`FilteredEventSink`** — wraps a sink with a predicate, passes matching events only

No-op by default — passing no sink to a step costs nothing. Tests pass an
`ArrayEventSink`. Experiment renders pass an `NdjsonEventSink`. Production
pipeline passes nothing.

### Event shape

The existing ribbon and cross-street implementations define the de-facto standard
envelope — all new steps should follow it:

```js
{
  seq:      number,        // monotonically increasing, from sink.next()
  stepId:   string,        // e.g. 'growth-3:allocate', 'ribbons', 'cross-streets'
  type:     string,        // event type, step-specific
  // ...context fields spread in (zone, sector, family, agent, etc.)
  payload:  object,        // event-specific data, compacted (nulls removed)
}
```

Context fields (zone index, sector index, family key, agent type) are spread
directly onto the event rather than nested, so they are filterable without
parsing the payload. Null/undefined context fields are stripped by
`compactObject` before emission.

### Passing the sink

Steps that support event logging accept an optional `sink` parameter:

```js
export function runAllocatePhase(map, archetype, state, valueLayers, devProximity, sink = new EventSink()) {
  // ...
  sink.emit({ seq: sink.next(), stepId: 'growth-N:allocate', type: 'cell-claimed', payload: { ... } });
}
```

The PipelineRunner creates and owns the sink for a run, passing it into steps
via the step descriptor if needed:

```js
yield step('growth-3:allocate', () => runAllocatePhase(map, archetype, state, valueLayers, devProximity, sink));
```

Or, more cleanly, steps read the sink from the map's run context:

```js
const sink = map.runContext?.eventSink ?? new EventSink();
```

The second approach avoids threading `sink` through every call chain. `runContext`
is a lightweight object set on the map at pipeline start and cleared at the end
— it holds run-scoped state that is not world state.

## Event Types by Step

### `ribbons` — already implemented

Events emitted by `src/city/incremental/ribbons.js`. See
`ribbon-event-log-replay-plan.md` for the full ribbon-specific event catalogue.

### `cross-streets` — already implemented

Events emitted by `src/city/incremental/crossStreets.js`:

| Type | Key payload fields |
|------|--------------------|
| `sweep-plan` | anchor, direction, ct range |
| `scanline-start` | ctOffset, runCount |
| `scanline-runs` | runs[] |
| `scanline-break` | reason |
| `street-candidate` | startPt, endPt, length |
| `street-snapped` | originalEndPt, snappedEndPt |
| `street-rejected` | reason, conflictId |
| `street-accepted` | streetId, startPt, endPt |
| `street-pruned` | streetId, reason |
| `scanline-no-street` | ctOffset, reason |

### `growth-N:allocate`

| Type | Payload |
|------|---------|
| `cell-claimed` | `gx, gz, agentType, value, competing[]` |
| `cell-skipped` | `gx, gz, reason, agentType` |
| `agent-budget-exhausted` | `agentType, claimed, budget` |
| `allocation-round-complete` | `tick, claimedCounts` |

### `skeleton` / `connect` / `growth-N:roads` (pathfinding)

| Type | Payload |
|------|---------|
| `path-start` | `fromGx, fromGz, toGx, toGz, preset` |
| `path-found` | `length, cost, nodeCount` |
| `path-failed` | `reason, fromGx, fromGz, toGx, toGz` |
| `road-added` | `roadId, hierarchy, source, polylineLength` |

### `zones` / `zones-refine` (face extraction)

| Type | Payload |
|------|---------|
| `face-found` | `faceId, nodeCount, edgeCount, cellCount` |
| `face-rejected` | `reason, nodeCount, cellCount` |
| `zone-created` | `zoneId, faceId, cellCount, avgLandValue` |

### Ribbon layout

See `ribbon-event-log-replay-plan.md` for the full set of ribbon event types.
The ribbon sink is an `EventSink` instance — the same primitive, with
ribbon-specific event types layered on top.

## Output Files

When running experiment scripts, emit one NDJSON file per step that uses
fine-grained logging:

```
experiments/NNN-output/
  events-growth-1-allocate-seed42.ndjson
  events-growth-2-allocate-seed42.ndjson
  events-skeleton-seed42.ndjson
  events-ribbon-zone0-seed42.ndjson     ← ribbon uses same format
```

Existing summary JSON and PNG/SVG outputs are unchanged. Event logs complement
them:

| Artifact | Shows |
|----------|-------|
| PNG / SVG | Final geometry |
| Summary JSON | Compact structured state |
| Event log | Ordered decision history |
| Fixture (future) | World state at step boundary |

## Replay

Replay is discussed in full for the ribbon case in
`ribbon-event-log-replay-plan.md`. The general pattern applies to any step:

1. Load a fixture for the step's input (world state at step start)
2. Load the NDJSON event log for that step run
3. Re-run the step with the same inputs and verify the same event stream is
   produced

This gives deterministic, isolated reproduction of any pipeline decision.

The event log is the audit trail. The fixture is the starting point. Together
they make any step's behaviour reproducible from outside the full pipeline.

## Relationship to Pipeline Contracts

The event log is the runtime complement to the static contract (reads/writes
declarations). The contract says what a step *should* access. The event log
records what it *actually did*. Discrepancies — a step emitting a `cell-claimed`
event for a cell that its declared reads don't explain — are bugs made visible.

In the longer term, a contract validator could consume the event log to verify
that every decision a step makes is traceable to its declared inputs. This is
stronger enforcement than dependency-cruiser (which checks imports, not runtime
access) and more targeted than full property-based testing.

## Constraints

- The event log must not change pipeline behaviour.
- Logging must be optional and zero-cost when disabled (no-op sink).
- Event payloads must be JSON-serialisable.
- Events should be self-contained enough to filter by family/agent/zone without
  parsing the whole log.
- The log should not serialise the entire world state per event — reference ids
  and coordinates only.

## Implementation Order

`EventSink` and its variants are in `src/core/EventSink.js`. Ribbon and
cross-street emission is instrumented. The experiment runner and viewer exist.
Remaining work, roughly in order of value:

1. **Wire the sink into render scripts** — instantiate `NdjsonEventSink` in
   `render-incremental-streets.js` (and other ribbon render scripts) and pass
   it into `layoutIncrementalStreets`. This is a one-liner per script but
   makes events actually flow for the first time.

2. **Extend the experiment viewer** (`experiments/index.html`) to load and
   display the NDJSON event log alongside the PNG output — a collapsible event
   list per seed, filterable by type or family key.

3. **Add a filter script** — `scripts/filter-events.js --log path --type
   street-rejected --family 3:12` for quick CLI inspection without the viewer.

4. **Add `runContext` to `FeatureMap`** (or pass sink explicitly) so pipeline
   steps can access the sink without threading it through every call chain.

5. **Instrument `runAllocatePhase`** — highest diagnostic value for growth
   debugging, using the same emit pattern as cross-streets.

6. **Instrument pathfinding** (`skeleton`, `connect`, `growth-N:roads`).

7. **Replay tooling** — script that takes an event log path and a row/anchor
   id and reconstructs local context for that attempt.
