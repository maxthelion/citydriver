## 037 Borrowed Phase Seed Lines

This builds on `036`.

`035` and `036` borrow a modulo-`spacing` phase from neighboring cross-street
endpoints on a shared boundary. That improves rhythm, but it still allows clean
near-miss seams where a new sector inherits the spacing without actually laying
the street through the neighbor's existing boundary endpoint.

### Change

For sectors using borrowed shared-boundary phase:

1. still infer a shared `phaseOrigin` and average `phaseOffset`
2. also project the neighboring boundary endpoints onto the contour axis
3. inject those projected offsets as explicit sweep lines for this sector
4. prefer those explicit borrowed offsets over nearby generic grid lines

So this variant borrows not just the average phase, but some of the actual
boundary-facing line placements from the already-codified neighboring sector.

### Goal

- reduce clean near-miss seams where a sector inherits the phase but misses an
  obvious neighboring cross street
- make borrowed-phase sectors feel more like a continuation of the existing
  boundary street set
