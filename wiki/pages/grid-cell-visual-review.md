---
title: "Grid Cell Visual Review"
category: "testing"
tags: [testing, visual, evaluation, petri, grid, review, LLM]
summary: "Split rendered output into grid cells for focused visual review — LLMs catch more problems examining zoomed-in sections than full-zoom overviews."
last-modified-by: user
---

## The Problem

When the [[experiment-loop|petri loop]] judge evaluates a rendered city zone at full zoom, it consistently scores changes as "visually imperceptible." Individual problems — streets too close together, crossings, gaps, streets through water — are invisible at the scale of a whole zone.

Humans do the same thing: a zoomed-out map looks plausible until you zoom in and notice a road running through a river.

## The Insight

Split the rendered output into a grid of cells (e.g. 2×4 = 8 cells) and have the evaluator examine each cell independently. At the cell level:

- Two streets running 3m apart become obviously wrong
- A street crossing a river is visible
- A gap where streets should be is noticeable
- A plot that's too shallow or too narrow is apparent

The evaluator looks at each cell in turn and raises an issue if it sees a problem. This catches more violations than looking at the whole image once.

## How It Works

### Rendering

For a zone rendered at (say) 500×300 pixels:
1. Split into 8 cells: 2 rows × 4 columns = 125×150 pixel cells
2. Each cell covers roughly 150m × 200m of terrain (at 5m/pixel)
3. At this zoom, a 5m road is 1 pixel — individual streets are distinguishable

### Per-Cell Evaluation

For each cell, the evaluator (LLM with image input) answers:

| Question | What it catches |
|----------|----------------|
| Are any streets too close to each other? | Parallel separation violations |
| Do any streets cross without a junction? | Unresolved crossings |
| Are there gaps where streets should be? | Face coverage gaps, missing parallels |
| Do any streets cross water or dark terrain? | Water/terrain violations |
| Are the blocks between streets a reasonable size? | Too-shallow plots, slivers |
| Do streets connect to other streets at both ends? | Dangling stubs, dead ends |

### Aggregation

Each cell gets a pass/fail per question. The zone overall fails if any cell fails. The specific cell and question identify where and what the problem is.

## Why Grid Cells Work Better

### Signal-to-noise ratio

A full zone image has thousands of street segments. The evaluator's attention is spread across all of them. A grid cell has maybe 10-20 segments — the evaluator can examine each one.

### Consistent scale

Every cell is at the same zoom level. A street-level problem looks the same whether it's in the dense centre or the sparse edge. Full-zone renders have variable density — the centre is visually busy, the edges are sparse, and the evaluator's attention goes to the busy area.

### Structured output

Instead of one holistic score (5.0/10), the evaluator produces a structured report:

```
Cell (0,0): PASS
Cell (1,0): FAIL — two parallel streets within 3m of each other at upper-right
Cell (2,0): PASS
Cell (3,0): FAIL — cyan street crosses dark terrain (possible water)
Cell (0,1): PASS
Cell (1,1): PASS
Cell (2,1): FAIL — large gap with no streets (face coverage issue)
Cell (3,1): PASS
```

This is actionable — the developer (or petri loop) knows exactly which area has which problem.

## Integration with Petri Loop

The grid cell review replaces or supplements the tier 3 visual judge:

**Current tier 3:** One judge looks at full-zone baseline vs evidence → holistic 1-10 score

**With grid cells:** Judge looks at each cell independently → structured pass/fail per cell per question → overall verdict based on cell failure count

This changes the petri loop's behaviour:
- **More specific feedback** — "cell (2,1) has a gap" rather than "visually imperceptible"
- **Easier to calibrate** — human corrections can target specific cells and questions
- **Higher sensitivity** — catches problems the full-zoom judge misses
- **Lower keep threshold** — a mutation that fixes problems in 3 cells but doesn't change the others is clearly better, even if the full-zoom view looks "the same"

## Grid Size Trade-offs

| Grid | Cells | Coverage per cell | Best for |
|------|-------|-------------------|----------|
| 2×2 | 4 | ~300×200m | Quick scan, coarse issues |
| 2×4 | 8 | ~150×150m | Good balance — street-level detail visible |
| 4×4 | 16 | ~75×75m | Fine detail, but expensive (16 LLM calls) |

2×4 (8 cells) is a good starting point — detailed enough to see individual streets, not so many cells that evaluation is slow.

## Relationship to Invariant Tests

Grid cell review is **complementary** to invariant tests, not a replacement:

- **Invariant tests** (tier 2) catch violations algorithmically — exact, fast, deterministic
- **Grid cell review** (tier 3) catches visual problems that invariants don't cover — aesthetic quality, overall coherence, "does this look right?"

The value of grid cell review is catching the **unknown unknowns** — problems we haven't written invariant tests for yet. When the evaluator spots a new kind of problem, it becomes a candidate for a new invariant test.

## Related

- [[experiment-loop]] — the petri loop where grid cell review fits as an improved tier 3
- [[contour-street-algorithm]] — the algorithm whose output gets evaluated
- [[world-state-invariants]] — the rules that invariant tests check (tier 2)
- [[pipeline-property-testing]] — the three-level testing strategy
