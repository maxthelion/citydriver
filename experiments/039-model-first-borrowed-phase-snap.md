# 039 model-first borrowed-phase snap

Goal: keep the successful `031j` ribbon family behavior, but make the shared-boundary cross-street joining more adherent to the shared-node road model.

## Change

`039` uses:

- the same ribbon params as `031j`
- borrowed shared-boundary phase
- borrowed explicit contour offsets from neighboring sectors
- boundary snap points applied inside `layCrossStreets(...)`

It does **not** use the renderer-side seam rescue steps from `036`/`038`:

- no prejoin endpoint mutation in `render-sector-ribbons.js`
- no post-`txn-parallel` retry that rewrites the candidate geometry and resubmits it

So the intended path is:

1. derive phase from neighboring committed streets
2. let `layCrossStreets(...)` snap a candidate if it improves the boundary match
3. commit through `tryAddRoad(...)`
4. let shared-node `RoadNetwork` and `roadTransaction` decide the final accepted geometry

That makes it a cleaner test of the new model, because the renderer is no longer patching seam candidates after generation.

## Result

Rendered from the saved `spatial` fixture for seed `884469`:

- Zone 0: `56` cross streets, `60` ribbons
- Zone 1: `17` cross streets, `13` ribbons
- Zone 2: `54` cross streets, `65` ribbons

Compared with `031j` on the same fixture:

- Zone 0: `58 -> 56` cross streets, `60 -> 60` ribbons
- Zone 1: `17 -> 17` cross streets, `13 -> 13` ribbons
- Zone 2: `63 -> 54` cross streets, `63 -> 65` ribbons

## Read

`039` is more architecturally honest, but not a clear visual win.

The good part:

- shared-boundary alignment is now driven by the generator + shared-node commit path rather than renderer repairs

The bad part:

- some seam candidates that `036`/`038` could rescue are now left rejected
- Zone 2 in particular becomes too conservative on cross streets

So `039` is a useful “clean model-first baseline”, not the new best experiment.
