# 044 — Declarative Buyer Families

## Goal

Take the micro land-allocation mechanics from `043` and run them through a
first declarative buyer model instead of a procedural loop.

This is not yet the full city-wide buyer system. It is the bridge step:

- same micro geometry
- same commercial frontage rules
- same park-with-ring-road rule
- same residential residual fill
- but orchestrated by declarative buyer families and variants

## Buyer Program

The program used here has three families:

1. `commercial`
   - variant: `frontage-strip`
2. `civic`
   - variant: `park`
3. `residential`
   - variant: `residual-fill`

Each family declares:

- `macroSearch`
- `familyGoals`
- `variants`

Each variant declares:

- `kind`
- `microClaim`

## Important Limitation

This experiment is still micro-scoped, so the `macroSearch` fields are
declarative metadata only. The actual executed behaviour is the micro claim.

That is intentional. The point of `044` is to prove the model shape, not to
solve full macro land reservation yet.

## Why This Matters

The main benefit is architectural clarity:

- buyer intent is data, not buried in `if` branches
- archetypes can later become compositions of buyer families
- event logging can describe claims in buyer terms
- macro search and micro claim are explicitly separated

One important follow-up still remains:

- residential should not only appear as `residual-fill`
- civic spaces such as parks may want a shallow residential edge treatment
  before the generic residual ribbons are laid

So the next buyer-program step after `044` should add a
`residential/edge-terrace` variant around civic reservations.

## Read

If `044` behaves similarly to `043`, that is a success.

The point is not yet to outperform `043` visually. The point is to show that
the same micro logic can be expressed as a buyer program without collapsing
macro and micro into one procedural loop.
