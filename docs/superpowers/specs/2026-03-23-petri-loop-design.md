# Petri Loop: Autonomous Experiment Evolution

## Overview

A behaviour-tree-driven autonomous loop that evolves the city generator's street layout algorithms through Darwinian selection. Inspired by the Shoemaker system's architecture (deterministic routing, one action per tick, filesystem state), adapted for visual/generative experiment iteration.

The immediate scope: merge the two overlaid street systems from experiments 007s3-s8 — organic terrain-following streets (k3) and geometric construction lines between anchor roads (s2) — into a unified street network. The system tries mutations, evaluates them through a three-tier pyramid, and keeps or kills each attempt.

## Core Principles

1. **One tick, one action.** Each invocation evaluates the behaviour tree, does one thing, exits. No internal loops.
2. **Deterministic routing.** The tree uses boolean conditions on filesystem state. No LLM calls in routing. Intelligence lives in the actions.
3. **Filesystem is state.** The `.petri/` directory and git branch are all the state. No database, no server. Delete `.petri/state/` to reset.
4. **Separate judge.** A different agent with a fresh context evaluates each mutation. It sees evidence, not reasoning.
5. **Human corrections accumulate.** The fitness log records verdicts and human overrides. Both the hypothesiser and judge read these to calibrate over time.

## Behaviour Tree

```
Selector
├── Sequence: [seeds regressed?]         → fix-regression
├── Sequence: [no baseline established?] → establish-baseline
├── Sequence: [evidence awaiting judge?] → spawn-judge
├── Sequence: [verdict pending?]         → apply-verdict
├── Sequence: [work-item exists?]        → execute-mutation
├── Sequence: [always true]              → hypothesise
```

Conditions are pure functions against a `WorldState` snapshot read at tick start. The tree evaluates top-to-bottom; the first matching condition's action runs.

### Conditions

| Condition | Check |
|-----------|-------|
| seeds regressed? | Render standard seeds, check if any fail to produce usable zones or crash |
| no baseline established? | `.petri/baseline/` directory missing or empty |
| evidence awaiting judge? | `.petri/evidence/` exists and `.petri/verdict.md` does not |
| verdict pending? | `.petri/verdict.md` exists |
| work-item exists? | `.petri/state/work-item.md` exists |
| always true | Fallback |

### Actions

**fix-regression** — Triggered when standard seeds fail to produce usable output. Reads the error, git log of recent changes, and last-known-good experiment notes (007s7). Makes a targeted fix and commits. The immediate first task: seed 884469 no longer produces usable zones after the v5 refactor (noted in experiment 007s8).

**establish-baseline** — Renders all standard seeds (884469, 42, 12345) using the 007s7 overlay approach (k3 organic + s2 geometric). Runs tier 1 and tier 2 metrics. Saves PNGs and metric scores to `.petri/baseline/`. This becomes the benchmark all mutations are measured against.

**hypothesise** — Reads the fitness log (including human corrections), experiment history (007-series markdown), inbox messages, and current baseline metrics. Decides what to try next. Writes `.petri/state/work-item.md` with: what to change, why, expected improvement. Applies the 80/20 exploration budget — 80% of the time mutates from current best, 20% tries something deliberately unconventional (different approach, wild parameter swing, reverting to an earlier strategy).

**execute-mutation** — Reads `work-item.md`. Makes the code change and commits on branch. Runs `run-experiment.js` on standard seeds. Computes tier 1 and tier 2 metrics. If tier 1 fails (invariants, tests, render errors), immediately rejects — writes a "failed at tier 1" verdict to `.petri/verdict.md`, skipping the expensive judge. Otherwise saves renders and metrics to `.petri/evidence/` for the judge.

**spawn-judge** — Launches a separate agent with a fresh context. Passes it: baseline PNGs, evidence PNGs, tier 2 metric comparison, evaluation rubric, and fitness log with human corrections. Does NOT pass the mutation reasoning or code diff. The judge writes `.petri/verdict.md` with per-criterion scores and a keep/reject decision.

**apply-verdict** — Reads `verdict.md`. If keep: promotes evidence to new baseline, logs success with scores. If reject: reverts the commit, logs failure with judge's reasoning. Either way, cleans up `work-item.md`, `evidence/`, and `verdict.md` so the tree falls through to `hypothesise` on next tick.

## Evaluation Pyramid

Three tiers, each gating the next. Failure at any tier is an instant reject.

### Tier 1: Invariants (automated, seconds)

- Existing bitmap invariant tests pass (water/road overlap, water/zone overlap, etc.)
- Unit tests pass
- Render completes without errors on all standard seeds
- Each seed produces usable zones (specifically: seed 884469 must produce zones)

### Tier 2: Heuristics (automated, seconds)

Computed from rendered output and map state:

- **Zone count** — must not collapse below threshold
- **Street connectivity ratio** — percentage of streets reachable from skeleton
- **Dead-end percentage** — lower is generally better for residential
- **Block size distribution** — median and variance, should cluster around realistic ranges
- **k3 line count** — organic street count must not collapse to zero
- **s2 line count** — geometric construction line count must not collapse to zero
- **Plot-to-road adjacency** — every plot connected to road network

Each metric has a baseline value from the current best. Regression below a threshold rejects the mutation before reaching the expensive visual evaluation.

New heuristics can be added over time as the system learns what matters.

### Tier 3: Visual (multimodal judge agent, expensive)

Only reached if tiers 1 and 2 pass. The judge agent examines rendered PNGs against the rubric:

- Do streets form coherent blocks?
- Are streets grid-like near anchor roads and organic in terrain?
- Is there a visible transition between the two systems?
- Are there obvious artifacts (overlapping lines, orphaned segments, impossible intersections)?
- Does the overall layout look more like a real neighbourhood than the baseline?
- Is the character consistent across the seed (not random noise)?

Scores 1-10 per criterion, overall weighted score. Written to `.petri/verdict.md` with reasoning.

## Feedback Calibration

The fitness log (`.petri/fitness-log.md`) is an append-only ledger. Each entry records:

```markdown
## Attempt 003 — 2026-03-24T02:15:00Z
**Hypothesis**: Increase grid bias near anchor roads from 0.5 to 0.8
**Tier 2 scores**: zones=24, connectivity=0.91, dead-ends=8%, block-size-median=1200m²
**Judge verdict**: KEEP (7.2/10) — "Grid structure more visible near anchor roads, organic transition still present"
**Baseline updated**: yes
**Human correction**: _(none yet)_
```

When the human reviews and disagrees, they annotate:

```markdown
**Human correction**: DISAGREE — score should be ~4. The grid lines are cutting through terrain contours unnaturally. The judge is overweighting grid regularity and underweighting terrain harmony.
```

Corrections serve two purposes:

1. **Steer hypotheses** — The hypothesise action reads all corrections. "My last attempt to increase grid bias was rejected by the human because terrain harmony suffered."
2. **Calibrate the judge** — The judge receives all past corrections in its context. Over time this builds case-law of "when the human disagreed and why."

This is in-context learning from accumulated examples, not formal retraining.

## Morning Review

When the user opens a new conversation and asks to review petri results, Claude follows the review protocol in `.petri/review-guide.md`:

1. **Summary** — Tick count, hypotheses tested, promotions, rejections. Baseline fitness delta.
2. **Walk through each attempt** — For each hypothesis in order: what was tried, why, rendered PNGs (baseline vs attempt), tier 2 metric deltas, judge's verdict with reasoning. "Do you agree with this verdict?"
3. **Collect corrections** — If the user disagrees, Claude writes the correction into the fitness log entry.
4. **Recalibrate** — If a promoted baseline was actually bad, revert to previous. If a rejected attempt was actually good, resurrect from git history.
5. **Steer next run** — User can drop hints into `.petri/inbox/` for the hypothesise action to read with priority.

## Exploration Budget

80% of hypothesise ticks mutate from the current best baseline — incremental improvements to what's working.

20% deliberately try something different:
- A fundamentally different approach to the same problem
- Reverting to an earlier ancestor and branching from there
- Wild parameter swings outside the normal range
- Ideas inspired by the experiment history that were never tried

This prevents getting stuck in local optima while still primarily exploiting proven improvements.

## Filesystem Layout

```
.petri/
├── fitness-log.md          # Append-only ledger of all attempts + verdicts + corrections
├── review-guide.md         # Protocol for interactive morning review
├── inbox/                  # Human messages read by hypothesise with priority
├── baseline/               # Current best: PNGs + metrics snapshot
│   ├── metrics.json
│   ├── seed-884469.png
│   ├── seed-42.png
│   └── seed-12345.png
├── evidence/               # Latest mutation output awaiting judgment
│   ├── metrics.json
│   └── *.png
├── state/
│   ├── work-item.md        # Current mutation plan
│   └── verdict.md          # Judge's decision
└── rubric.md               # Evaluation criteria for the judge
```

`.petri/` is gitignored except `fitness-log.md` and `inbox/`.

## Source Layout

```
src/petri/
├── tree.js                 # Behaviour tree definition (conditions + structure)
├── evaluate.js             # Pure tree evaluation engine
├── conditions.js           # Condition functions (read world state, return boolean)
├── actions/
│   ├── fix-regression.js
│   ├── establish-baseline.js
│   ├── hypothesise.js
│   ├── execute-mutation.js
│   ├── spawn-judge.js
│   └── apply-verdict.js
└── metrics.js              # Tier 2 heuristic computation

scripts/
└── petri-tick.js           # Entry point: read state → evaluate tree → dispatch action
```

## Standard Seeds

Consistent across all renders for comparability:
- `884469 27 95` — primary test city
- `42 15 50` — secondary
- `12345 20 60` — tertiary

## Bootstrapping Sequence

1. First tick: `fix-regression` — fix seed 884469 zone output
2. Second tick: `establish-baseline` — render s7-quality overlay, save as benchmark
3. Third tick onwards: `hypothesise → execute → judge → decide` cycle

## Running

```bash
/loop 5m scripts/petri-tick.js   # in a worktree
```

Each tick takes 1-2 minutes for renders plus token cost for tier 3 visual evaluation. Exits cleanly after one action.

**Stopping:** Stop the loop. Resume anytime — filesystem state persists.
**Resetting:** Delete `.petri/state/` to restart from regression detection.

## Relationship to Shoemakers

This borrows Shoemaker's architecture (behaviour tree, one-action-per-tick, filesystem state, deterministic routing) but is scoped and simplified:

- No roles or role-based permissions
- No adversarial review (the separate judge serves this purpose more simply)
- No invariants.md (bitmap invariants are code-level, not prose claims)
- No shift logs (fitness-log.md serves this purpose)
- No wiki-as-spec (experiment markdown serves this purpose)
- No creative Wikipedia lensing (the 20% exploration budget serves this purpose)

If the petri loop proves the principle, it could later be generalised or folded into a full Shoemaker deployment on the citygenerator.
