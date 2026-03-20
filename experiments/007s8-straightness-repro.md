# Experiment 007s8: Straightness-weighted repro on current pipeline

## Previous state
007s7 produced straightness-weighted edge selection with k3 organic streets + s2 geometric construction overlaid. That was on an older pipeline state.

## Problem
Verifying that 007s7's approach still works identically on the current pipeline (post CityScreen refactor, smooth-roads step, buildCityMap factory).

## Hypothesis
The render script uses `runToStep(strategy, 'spatial')` which is pipeline-step-name based, so it should produce identical output regardless of downstream pipeline changes.

## Changes
No code changes to the render script. Using render-ribbon-overlay-v5.js as-is.

## Results

Seed 42 (884469 no longer produces usable zones with the current pipeline — see commit 19a8873).

- Zone: 42,360 cells, avgSlope=0.207
- 8 terrain faces
- k3: 62 cross streets, 176 parallel streets, 250 junction points
- s2: 2 anchor roads (straightness 0.87 and 0.95), 7 set A lines, 34 set B lines

Output matches the expected pattern: organic terrain-following streets from k3 with geometric construction line overlay from s2.

Also fixed `render-pipeline.js` to default to running the pipeline to completion instead of using a raw tick count (`--ticks` removed, `--step` is the only stop mechanism).

## Decision
KEEP — confirms s7's approach works on current pipeline with seed 42.
