# Experiment Acceleration Completion Plan

This is the concrete completion plan for finishing
[`experiment-acceleration-plan.md`](./experiment-acceleration-plan.md) from the
current shared-node worktree state.

## Current state

Already done:

- `saveMapFixture(...)` / `loadMapFixture(...)` exist in
  [`src/core/featureMapFixture.js`](../../src/core/featureMapFixture.js)
- [`scripts/save-fixture.js`](../../scripts/save-fixture.js) writes fixtures
- [`scripts/render-sector-ribbons.js`](../../scripts/render-sector-ribbons.js)
  can run from `--fixture`
- shared-node `RoadNetwork` snapshots round-trip through fixtures
- `031j` reproduces scratch vs fixture semantically, while fixture-backed runs
  are much faster than full rebuilds

Useful measured baseline:

- full `031j` from scratch: ~68s
- save `spatial` fixture once: ~56s
- `031j` from saved `spatial` fixture: ~18s

So the fixture MVP works, but most of the wider acceleration plan is still open.

## Remaining work

### 1. Cropped fixtures

Implement crop support in fixture save/load workflows.

Required:

- `--crop-zone <id> --margin <cells>` in `save-fixture.js`
- `--crop minGx,minGz,maxGx,maxGz` in `save-fixture.js`
- grid slicing
- road / river clipping to the crop bounds
- zone / reservation / nuclei / active seed filtering to the crop
- crop metadata recorded in the fixture JSON

Tests:

- fixture round-trip for a cropped map
- zone-centric crop keeps the target zone intact
- clipped road network still loads and stamps correctly

Why first:

- this is the biggest remaining speed win for single-zone experiment work
- it is still Phase 1 work and builds directly on the current fixture path

### 2. Shared fixture bootstrap helper

Factor the current “seed or fixture” startup logic into a shared helper.

Targets:

- `render-sector-ribbons.js`
- `render-sector-cross-streets.js`
- later any growth / allocation render script

Goal:

- avoid re-implementing CLI parsing and map bootstrap in every script

### 3. Fixture-aware experiment runners

Teach the experiment runner to use fixtures directly.

Required:

- `run-experiment.js --fixture <path>`
- optionally `--fixture-dir <dir>` for one fixture per seed
- manifest fields for:
  - fixture path
  - fixture step
  - git commit
  - explicit experiment params

Goal:

- make fixture-backed experiments first-class, not a one-off script path

### 4. Parallel variants

Add a dedicated runner for multiple variants from one shared fixture.

New script:

- `scripts/run-variants.js`

Inputs:

- one fixture
- one variants JSON file
- one experiment number / output directory

Outputs:

- one experiment directory containing all variant renders
- one manifest the viewer can compare side-by-side

Goal:

- allow rapid iteration on parameter / strategy variants without repeated setup

### 5. Mock fixture builder

Add a controlled mock-fixture generator for fast, deterministic experiments.

New script:

- `scripts/make-mock-fixture.js`

First useful templates:

- flat
- sloped
- coastal
- cross-road
- grid-road

Goal:

- prototype against controlled geometry before validating on real terrain

### 6. Reproducibility and characterization hardening

Keep the acceleration path trustworthy.

Required:

- preserve both requested coords and resolved settlement coords in fixture meta
- include git commit in fixture / experiment manifests
- add a reusable semantic comparison helper for scratch vs fixture outputs
- add at least one pinned characterization path for `031j`

Goal:

- fixture-backed experiments should be trusted, not just faster

### 7. Lightweight benchmark support

Add a small benchmark path for the fixture workflow itself.

Measure:

- fixture save time
- fixture load time
- fixture-backed render time

Goal:

- catch regressions in the acceleration path early

## Recommended order

1. Cropped fixtures
2. Shared fixture bootstrap helper
3. Fixture-aware `run-experiment.js`
4. `run-variants.js`
5. Mock fixture builder
6. Reproducibility / characterization hardening
7. Benchmark polish

## Done definition

The plan is complete when:

- fixtures can be saved full-map or cropped
- relevant experiment renderers can load fixtures directly
- experiment runners can launch multiple variants from one fixture
- manifests record enough provenance to reproduce a run later
- at least one important experiment (`031j`) is characterized across scratch
  and fixture-backed execution
