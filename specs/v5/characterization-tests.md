# Characterization Tests for Pipeline Steps

## When This Is Useful

This is not primarily a day-to-day regression testing tool. It is most
valuable as **scaffolding around a structural refactor** — a safety net you
put up before making large wiring changes, use to confirm the refactor was
behaviour-neutral, then take down or archive.

The canonical use cases:

- **The `PipelineContext` refactor** (`pipeline-step-contracts.md`) — changing
  how steps receive arguments, moving state off `FeatureMap`, restructuring
  how data flows between steps. The intended output of every step is unchanged.
  Hashes confirm that nothing silently shifted during the rewiring.

- **The OSM road model cutover** (`shared-node-road-cutover.md`) — replacing
  `RoadNetwork`/`PlanarGraph` with shared-node `OsmWay`/`OsmNode`. Again, all
  step outputs should be identical before and after.

In both cases the workflow is:

1. Generate golden hashes before the refactor — commit them
2. Do the structural work
3. Run character tests — all green means the refactor was behaviour-neutral
4. Archive or delete the golden files when no longer needed

Without this, confirming a structural refactor was invisible to outputs means
visually inspecting city renders across seeds. The hashes give you that
confirmation precisely and cheaply.

**For algorithm changes** (improving land value weighting, tuning zone
extraction, better growth allocation), character tests are less useful because
you *want* the outputs to change. The right tools there are invariant checks,
visual review, and the petri loop.

---

## The Problem With The Current Slow Tests

The test suite has two tiers with a gap between them:

**Fast** — unit tests using hand-built map stubs (e.g. `growthTick.test.js`).
Small synthetic grids, no pipeline setup, run in milliseconds. But they test
behaviour against artificial inputs that may not represent what the algorithm
actually encounters.

**Slow** — integration tests that call `generateRegion` + `setupCity` + all
preceding pipeline steps before testing the step they actually care about
(e.g. `pipelinePostconditions.test.js` runs to `zones-refine` across 6 seeds,
`pipelineInvariants.test.js` runs the full pipeline across 3 seeds). These
test against real inputs but pay the full pipeline setup cost every run.

The character hash approach addresses these too, but as a secondary benefit —
the slow tests can be replaced with fixture-based runs that are faster. The
primary motivation remains the refactor safety net.

## Characterization Testing

The approach is from Michael Feathers: rather than asserting what a step
*should* do, assert what it *currently does*. Capture the actual output as a
snapshot and fail if anything changes.

This is not about correctness. A character test does not tell you the output
is right. It tells you the output is the same as when the snapshot was taken.
Correctness is the job of invariant checks and targeted unit tests.

## The Hash Approach

The simplest and most actionable mechanism: **MD5 the raw output of each step,
compare against stored hashes**.

### Why hashing rather than statistical fingerprints

Statistical fingerprints (mean, stddev, percentiles) tell you *how* the output
changed. Hashes tell you that *anything at all* changed — with complete
sensitivity — and point you to the exact step where the deviation began.

For a deterministic pipeline (same seed always produces the same output), a
hash is the right primitive. The debugging path is:

1. Run pipeline on reference seeds, hash output after each step → store as golden file
2. Later run: re-hash each step, compare against golden
3. First mismatch = first step that deviated
4. Pull up the rendered output of that step from both runs side by side

That gives you precise step bisection cheaply, and the rendered images give
you a visual diff that's faster to understand than any statistical summary.

### What to hash

Hash the raw bytes of each grid layer the step writes, in a fixed canonical
order. Do not serialise to JSON first — hash the underlying typed array buffer
directly. This is fast, platform-stable for the same seed, and avoids float
formatting ambiguity.

For structured data (zones, roads, parcels), serialise to a canonical JSON
string with sorted keys before hashing. These are smaller and less
performance-sensitive than grids.

```js
import { createHash } from 'crypto';

function hashLayer(grid) {
  return createHash('md5').update(grid.data.buffer).digest('hex');
}

function hashData(value) {
  return createHash('md5')
    .update(JSON.stringify(value, sortedKeys))
    .digest('hex');
}
```

### Hash storage

A golden file per seed — a flat map from step id to per-output hashes:

```json
{
  "seed": 42,
  "generated": "2026-03-30T12:00:00Z",
  "steps": {
    "skeleton": {
      "roadGrid":    "a3f2b8c9...",
      "bridgeGrid":  "11f4c2e8...",
      "graphEdges":  "9d3a1b7f..."
    },
    "land-value": {
      "landValue":   "4e8f2a1c..."
    },
    "zones": {
      "zoneGrid":         "b2c9d4e1...",
      "developmentZones": "7a3f8b2e..."
    },
    "spatial": {
      "centrality":     "c4d1e8f2...",
      "waterfrontness": "2b9f3a7c...",
      "edgeness":       "8e1c4d2b...",
      "roadFrontage":   "f3a8b9c1...",
      "downwindness":   "1d4e7f8a..."
    },
    "growth-1:allocate": {
      "reservationGrid": "5f2e9c1d..."
    }
  }
}
```

```
test/character/
  golden-seed-42.json
  golden-seed-99.json
  golden-seed-884469.json
```

Three seeds is enough. They should represent different settlement types and
terrain characters (coastal, inland, hilly).

### The test

```js
// test/character/pipeline.character.test.js

import { describe, it, expect } from 'vitest';
import { loadGolden, hashStepOutputs } from './characterHelpers.js';
import { runPipelineWithHooks } from './pipelineRunner.js';

const SEEDS = [42, 99, 884469];

describe.each(SEEDS)('pipeline character — seed %i', (seed) => {
  it('all step output hashes match golden', () => {
    const golden = loadGolden(seed);
    const actual = runPipelineWithHooks(seed, (stepId, map) => {
      return hashStepOutputs(stepId, map);
    });

    // Report first mismatch clearly
    for (const [stepId, outputs] of Object.entries(golden.steps)) {
      for (const [key, expectedHash] of Object.entries(outputs)) {
        const actualHash = actual.steps[stepId]?.[key];
        if (actualHash !== expectedHash) {
          throw new Error(
            `Character changed at step "${stepId}", output "${key}".\n` +
            `Expected: ${expectedHash}\n` +
            `Actual:   ${actualHash}\n` +
            `This is the first step that deviated — look at the rendered\n` +
            `output of this step to see what changed.`
          );
        }
      }
    }
  });
});
```

The test fails at the first mismatch and tells you exactly which step and
which output key changed. Everything downstream is irrelevant — only the
first deviation matters for debugging.

### Generating golden files

```bash
bun scripts/generate-character.js --seeds 42,99,884469
```

This runs the full pipeline for each seed, hashes outputs after each step,
and writes the golden JSON files. Run this deliberately:
- When first setting up the character tests
- When you intentionally change a step's behaviour (the diff in the
  committed golden file documents what changed and where)

### Rendered output alongside hashes

When a hash fails, you want to see the actual output. The existing experiment
runner already writes PNG renders for pipeline steps. The character test
workflow should write rendered PNGs for each step to a `character-output/`
directory alongside the golden files:

```
test/character/
  golden-seed-42.json
  golden-seed-99.json
  golden-seed-884469.json
  reference-output/              ← rendered at golden generation time
    seed-42-skeleton-roadGrid.png
    seed-42-land-value-landValue.png
    seed-42-zones-zoneGrid.png
    ...
```

On a failing run, the test script re-renders the failing step's outputs
alongside the reference images. You can open them side by side in any image
viewer.

This means you don't need statistical fingerprints to understand what changed
— the image diff is faster and more intuitive.

## Fixtures

The character tests as described above still require running the full pipeline
per seed (to collect hashes at each step). For isolated step testing, fixtures
allow running a single step against a pre-computed input.

A fixture is the serialised map state at a step boundary. With fixtures, a
character test for `computeLandValue` needs only:

```
load fixture[after-skeleton] → run computeLandValue → hash landValue layer → compare
```

No `generateRegion`. No `setupCity`. No preceding steps.

Fixtures are built from the same golden run:

```bash
bun scripts/generate-character.js --seeds 42,99,884469 --write-fixtures
```

This writes both the golden hash file and fixture snapshots at each step
boundary. Fixtures are committed to the repo and regenerated when upstream
steps change.

See `pipeline-step-contracts.md` for the fixture serialisation format — the
same infrastructure serves both the contract work and the character tests.

## What Replaces What

| Current test | Problem | Replacement |
|---|---|---|
| `pipelinePostconditions.test.js` (6 seeds, full pipeline to zones-refine) | Runs whole pipeline per seed | Character hash test (hashes computed from fixtures) |
| `pipelineInvariants.test.js` (3 seeds, full pipeline) | Full pipeline per seed | Invariant checks run against loaded fixtures |
| `k3StreetInvariants.test.js` | Runs k3 streets from scratch | Character test for incremental streets using fixture |

The full-pipeline integration tests become **golden/fixture generation
scripts** — they run deliberately before merging or when upstream changes, not
on every `vitest run`.

## Statistical Fingerprints as a Supplementary Tool

Statistical fingerprints (min, max, mean, stddev, percentiles, sampled point
values) are useful as a diagnostic supplement but not as the primary test
mechanism. When a hash changes and the image diff isn't enough to understand
why, a fingerprint diff can show whether the change was a global shift (mean
moved), a distribution change (stddev grew), or a local anomaly (sample point
changed but global stats didn't).

A `scripts/diff-character.js` script can compute and compare fingerprints
between two runs without storing them permanently:

```bash
bun scripts/diff-character.js --seed 42 --step land-value --layer landValue
```

Outputs:
```
landValue character diff (seed 42, after land-value):
  mean:   0.453 → 0.461  (+0.008)
  stddev: 0.178 → 0.192  (+0.014)
  p50:    0.444 → 0.451  (+0.007)
  sample (100,100): 0.623 → 0.641  (+0.018)
```

This is computed on demand, not stored, keeping the primary mechanism simple.

## Platform Determinism

Hashing raw typed array buffers requires that the pipeline be bit-for-bit
deterministic on the same platform for the same seed. This holds for the
current implementation — all spatial operations use fixed-precision integer
arithmetic or 32-bit float grids with deterministic access patterns.

If hashes differ between developers' machines (e.g. different SIMD
implementations of Math.sqrt), the golden files should be generated and
compared on CI only. Local runs would still report the failure location;
only the CI golden file is authoritative.

## Implementation Order

Do this immediately before the `PipelineContext` refactor, not before.

1. **`hashStepOutputs(stepId, map)`** — given a step id and a map, hash the
   layers and data that step writes (using the contract's `writes` declaration).

2. **`scripts/generate-character.js`** — run the full pipeline, call
   `hashStepOutputs` after each step via a PipelineRunner hook, write golden
   JSON files.

3. **Render reference outputs** as part of the golden generation — one PNG per
   step per seed, stored in `test/character/reference-output/`.

4. **`pipeline.character.test.js`** — the test itself. Runs full pipeline,
   compares hashes, fails with step-precise error message on first mismatch.

5. **Do the refactor** — run character tests at any point to check nothing has
   shifted.

6. **Archive golden files** once the refactor is complete and confirmed. Keep
   the tooling (`generate-character.js`, `hashStepOutputs`) for the next
   structural change.

**Fixture writing and the slow test replacement** are independent goals that
can follow later:

7. **Add fixture writing** to `generate-character.js` (`--write-fixtures`
   flag) once `FeatureMap` serialisation exists.

8. **`scripts/diff-character.js`** — on-demand statistical diff tool.

9. **Reclassify slow integration tests** — move to a `test/golden/` directory
   that is excluded from `vitest run` and included in a separate
   `bun test:golden` script.
