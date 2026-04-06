# 046 — Park Edge Terraces Before Residual Fill

This experiment follows the buyer-model order more closely than `045`.

It keeps:

- commercial frontage strips on road-facing anchor edges
- a central civic park with a ring road
- the corner reconciliation that trims over-wide frontage/service treatment at
  shared anchor corners

Then it changes the residential sequence:

1. reserve a one-row terrace band on the *outside* of the park ring road
2. keep that terrace band fixed
3. only then run residual cross streets and ribbons in the remaining land

The important rule is that the terrace band does **not** emit another service
road behind itself. It uses the park ring road as its frontage. That should
avoid the pattern where the park introduces too many additional road corridors
before the residual fill runs.

Buyer order:

1. `commercial/frontage-strip`
2. `civic/park`
3. `residential/park-edge-terrace`
4. `residential/residual-fill`

What to look for:

- whether the park gets a readable fringe of intentional housing
- whether residual ribbons have a cleaner leftover polygon to work with
- whether Zones 1 and 2 become less road-heavy than in `045`
