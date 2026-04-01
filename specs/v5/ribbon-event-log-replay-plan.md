# Ribbon Event Log And Replay Plan

## Status

Deferred. This is a debugging and observability improvement for the incremental
street / ribbon experiments, not an immediate layout change.

## Relationship to Pipeline Event Log

This spec covers ribbon-specific event types and replay mechanics. The shared
`EventSink` primitive, NDJSON output format, and general replay model are
defined in `pipeline-event-log.md`. The ribbon event log is an instance of
that general pattern — same sink interface, same file format, ribbon-specific
event types layered on top.

The `EventSink` primitive is already built (`src/core/EventSink.js`) and
ribbon events are already being emitted by `src/city/incremental/ribbons.js`.
Cross-street events are similarly instrumented in
`src/city/incremental/crossStreets.js`. What this spec describes as future
work is the replay tooling and viewer integration, not the emission
infrastructure.

## Why

The current ribbon debugging tools are useful but still lossy:

- PNG and SVG outputs show the final accepted rows and some rejected attempts
- JSON debug dumps capture failures after the fact
- tooltips explain a single failure record

What we still do not have is a faithful history of **what the algorithm did in
order**, or a clean way to **replay one step or one family branch** with the
same inputs and decisions.

That makes it hard to answer questions like:

- Why did this family terminate here?
- Why was this row accepted before that one?
- Did the row actually hit the next cross street and later fail validation?
- Which prior row caused a `parallel-cross` rejection?
- What changed between two nearby variants?

## Goal

Add an append-only event stream for ribbon generation so that:

1. every meaningful decision is recorded in order
2. the history can be inspected in the viewer
3. individual attempts can be replayed deterministically
4. future tooling can scrub through the layout process step by step

## Core Idea

Treat ribbon generation as an event-producing process rather than only a
function that returns final rows plus failures.

Instead of only writing:

- accepted ribbons
- rejected attempts
- seed anchors

we also write the sequence of operations that led there.

## Proposed Event Model

Each event should include:

- `eventId`
- `sequence`
- `zoneIdx`
- `sectorIdx`
- `familyKey`
- `rowIdAttempt`
- `parentRowId`
- `anchor`
- `type`
- `payload`

The stream should be strictly ordered and append-only for a single render.

### Likely event types

- `anchor-enqueued`
- `anchor-dequeued`
- `row-build-start`
- `inherit-chain-start`
- `inherit-junction`
- `explore-extension-start`
- `street-hit`
- `landing-chosen`
- `landing-repaired`
- `row-accepted`
- `row-rejected`
- `relation-check-failed`
- `family-slot-derived`
- `gap-seed-created`

### Important payload fields

Depending on event type, payload may include:

- street ids
- arc-length `t`
- world point
- guide line
- attempt path
- projected point
- chosen sample index
- failure reason
- conflicting row id
- generation / slot index
- parameter snapshot or parameter hash

## Replay Requirements

Replay should not depend on reading the rendered SVG back in.

Instead, a replay record should reference:

- the seed
- experiment id / variant name
- zone and sector
- the relevant parameter set
- the ordered events up to the chosen step

There are two useful replay modes:

### 1. Full replay

Re-run the whole ribbon layout for a zone or sector and verify that the same
event stream is produced.

### 2. Local replay

Resume from a chosen anchor or row attempt and replay only:

- one attempted row
- one family branch
- one failed landing or relation check

This is the more valuable debugging mode.

## Storage Shape

Use a newline-delimited JSON event log alongside the current debug artifacts.

Suggested outputs:

- `ribbon-events-zone0-seed884469.ndjson`
- `ribbon-events-zone1-seed884469.ndjson`

Keep the existing summary JSON as a derived artifact for easy inspection:

- `ribbon-debug-zone0-seed884469.json`

The summary JSON can reference event ids instead of trying to duplicate all
intermediate state.

## Integration Plan

### Phase 1: Event sink abstraction

Add a lightweight event sink passed into ribbon generation:

- no-op by default
- append-to-array sink for tests
- file-backed sink for experiment renders

This should sit in the incremental ribbon layer rather than inside the viewer.

### Phase 2: Instrument the major operations

Emit events for:

- anchor queue activity
- row build start/end
- chosen landings
- accepted rows
- rejected rows and reasons

Start with coarse events first. We do not need every tiny march step
immediately.

### Phase 3: Local replay helper

Add a small script that takes:

- event log path
- event id or row attempt id

and reconstructs the local context needed to replay that attempt.

### Phase 4: Viewer support

Extend the experiment viewer so that:

- clicking a row / anchor / failure can show related events
- a timeline can be scrubbed
- a selected event can highlight the relevant geometry

## Constraints

- The event log must not change layout behavior.
- Logging should be optional and cheap to disable.
- Event payloads should be stable enough for diffs across variants.
- The log should record enough context for replay without serializing the
  entire world on every event.

## Recommended Minimum Viable Version

If we build a small first version, it should do only this:

1. emit ordered events for anchor dequeue, row build start, row accepted, and
   row rejected
2. include row ids, family ids, anchor source, street ids, points, and failure
   reason
3. write NDJSON next to the existing ribbon debug JSON
4. add a tiny script to filter events for one family or one failed attempt

That would already make the current SVG/JSON workflow much easier to reason
about.

## Relationship To Existing Debug Outputs

This plan does not replace:

- PNG renders
- SVG debug overlays
- summary JSON

It complements them:

- SVG shows geometry
- summary JSON shows compact structured state
- event log shows history
- replay reconstructs causality

## Open Questions

- How much march-step detail is worth logging before files become too large?
- Should replay consume a compact parameter hash or a full parameter object?
- Should the event stream live only in experiment renders, or also in tests?
- Do we want a generic pipeline event model later, or keep this ribbon-specific
  first?

## Decision

When we return to ribbon debugging infrastructure, prefer building this as a
small event-sink plus NDJSON pipeline first, not as a viewer-only feature.
