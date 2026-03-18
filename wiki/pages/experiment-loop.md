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
3. **Render** — run `bun scripts/render-reservations.js` for 2-3 seeds
4. **Evaluate** — look at the output, update the experiment file with results
5. **Decide** — KEEP (commit) or REVERT (`git checkout -- .`)
6. **Next** — increment the experiment number, describe remaining problems

## Rules

- One commit per experiment (if kept)
- Always render the same seeds for comparability
- Always link to the previous experiment's output for comparison
- If reverting, still keep the experiment file documenting what was tried and why it didn't work
- Use the [[pipeline-observability|bitmap logger]] for detailed tracing when needed

## Standard Seeds

For consistency, always render these seeds:
- `884469 27 95` — the primary test city
- `42 15 50` — secondary
- `12345 20 60` — tertiary
