# 042 — Gap Cadence Phase Only

## Goal

Keep the micro-sector frontage logic from `041`, but stop over-seeding the
residential residual with cross streets.

The problem in `041` was that every frontage access gap was injected as an
explicit residual cross-street contour offset. That preserved permeability, but
it also stacked those gap-driven streets on top of the normal sweep rhythm and
produced too many magenta cross streets.

## Change

`042` uses the commercial access gaps to choose the **phase** of the residual
cross-street lattice, but it does **not** force a street at every gap.

More precisely:

1. Project gap centres onto the residual sector contour axis
2. Search for the regular cross-street phase offset that best fits those gap
   positions
3. Run the normal evenly spaced cross-street sweep with that chosen phase
4. Fill the residual with ribbons from the resulting cross streets

So the frontage cadence still influences the layout, but as a rhythm guide
rather than as a second street source.

## Why This Better Matches The Design Notes

### 1. Commercial frontage preserves permeability

The access gaps still matter. They now steer where the residual street lattice
wants to land, instead of each becoming a guaranteed street.

### 2. Commercial is still half depth

The experiment keeps the same frontage, service-road, and backing-residential
assumptions as `041`.

### 3. The residual should not be over-structured

This version tries to avoid a second unintended cross-street system inside the
same residual polygon.

## Read

If this works well, it is a better micro rule than `041`:

- frontage gaps influence cross-street phase
- but the residual still reads as one coherent street system

That would be a better base for the next micro experiment involving a park or a
church/square polygon.
