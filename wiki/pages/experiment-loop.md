---
title: "Experiment Loop"
category: "observability"
tags: [experiments, iteration, debugging, pipeline, methodology]
summary: "A structured approach to iterating on pipeline output: each experiment documents problems, hypothesises changes, generates output, and either keeps or reverts."
last-modified-by: user
---

## Overview

When tuning the city generation pipeline, changes often have unpredictable visual results. The experiment loop is a structured way to iterate: each experiment is a numbered file that documents the problem, proposes a change, and links to generated output. If the experiment improves things, we keep it. If not, we revert to the previous commit.

## Structure

```
experiments/
  001-baseline.md
  001-output/
    reservations-seed884469.png
    reservations-seed42.png
  002-throttled-ribbons.md
  002-output/
    reservations-seed884469.png
    reservations-seed42.png
  ...
```

Each experiment file follows a template:

```markdown
# Experiment NNN: [title]

## Previous state
Link to previous experiment output and description of what it looks like.

## Problems
What's wrong with the current output.

## Hypothesis
What change might improve it and why.

## Changes
What code/config was modified.

## Results
Link to output images. Did it improve? What's better, what's worse?

## Decision
KEEP or REVERT. If KEEP, this becomes the baseline for the next experiment.
```

## Workflow

1. **Document** — write the experiment file describing problems and hypothesis
2. **Change** — make the code/config change
3. **Render** — run through `run-experiment.js` (see below). **Never run render scripts directly** — only `run-experiment.js` updates the manifests needed by the experiment viewer.
4. **Evaluate** — look at the output, update the experiment file with results
5. **Decide** — KEEP (commit) or REVERT (`git checkout -- .`)
6. **Next** — increment the experiment number, describe remaining problems

## Rendering

**Always use `run-experiment.js`** to render experiments. This script runs the render, converts PPM to PNG, writes per-experiment manifests, and updates the root `experiments/manifest.json` so experiments appear in the viewer.

For pipeline-layer experiments:
```bash
bun scripts/run-experiment.js --experiment 004 \
  --seeds "884469:27:95,42:15:50,12345:20:60" \
  --ticks 28 --layers reservations,zones \
  --archetype marketTown
```

For custom render scripts (most 007-series experiments):
```bash
bun scripts/run-experiment.js --experiment 007p \
  --script render-ribbon-smooth-curve.js \
  --seeds "884469:27:95"
```

Custom render scripts must accept `seed gx gz outDir` as command-line arguments and write output as `outDir/layer-seedNNN.ppm` (with optional PNG conversion via ImageMagick `convert`).

## Experiment Viewer

The viewer (`experiments/index.html`) reads from two manifest files:

- **`experiments/manifest.json`** — root index listing all experiments with their images, slugs, and markdown filenames
- **`experiments/NNN-output/manifest.json`** — per-experiment manifest with image metadata (layer, seed, tick)

Both are written automatically by `run-experiment.js`. If an experiment doesn't appear in the viewer, re-run it through `run-experiment.js`.

## Variants

When iterating on a single hypothesis, use **letter suffixes** (e.g. 022a, 022b, 022c) rather than new experiment numbers. Each variant gets its own output directory and preserves the previous variant's results for comparison.

**Never overwrite a previous variant's output** — always create a new variant so the progression is visible.

```
experiments/
  022-output/         ← first attempt (baseline for this hypothesis)
  022a-output/        ← angle checks added
  022b-output/        ← invariant audit
  022c-output/        ← tryAddRoad transaction pattern
  ...
```

Use a new experiment number (023, 024) when moving to a different hypothesis or feature. Use variants (022a, 022b) when iterating on the same feature.

## Test Fixtures

When an algorithm isn't producing expected results on real data, create **synthetic test fixtures** with known geometry to debug in isolation. This is faster than running the full pipeline and makes it easy to identify exactly which geometric configuration breaks.

Example: `scripts/test-ribbons.js` creates synthetic cross street pairs (parallel, offset, converging, different lengths) and runs the ribbon algorithm on each, rendering the results. This revealed that the axis projection was failing on nearly-horizontal gradient directions — a bug invisible in full pipeline output.

Test fixtures should:
- Cover the simple case first (two parallel lines, same length)
- Add complexity incrementally (offset starts, different lengths, slight angle differences)
- Include a mock map/zone so validity checks pass
- Render results as images for visual inspection
- Report counts and per-ribbon geometry for comparison

## Rules

- One commit per experiment (if kept)
- Never overwrite previous experiment or variant output
- Always render the same seeds for comparability
- Always link to the previous experiment's output for comparison
- If reverting, still keep the experiment file documenting what was tried and why it didn't work
- Use the [[pipeline-observability|bitmap logger]] for detailed tracing when needed

## Standard Seeds

For consistency, always render these seeds:
- `884469 27 95` — the primary test city
- `42 15 50` — secondary
- `12345 20 60` — tertiary
