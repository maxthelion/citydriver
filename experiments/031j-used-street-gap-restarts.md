# 031j: Used-Street Gap Restarts

## Goal

Improve leftover-pocket filling by making gap restarts happen on streets that
already participate in the local row fabric.

The hope was:

- if a restart begins on a street that already has nearby row structure
- it is more likely to read as a continuation of the local fabric
- and less likely to draw a wild exploratory line through a gap

## Change

- Keep `031h`'s tail truncation
- Keep `031i`'s ability for gap seeds to borrow a nearby guide row
- Change gap-seed selection so it prefers a large leftover gap on a street that
  is already in use, instead of preferring completely untouched streets first

## Result

This is much fuller.

On seed `884469`:

- Zone 0 goes from `38` ribbons in `031h` to `65`
- Zone 1 goes from `18` to `15`
- Zone 2 goes from `67` to `69`

The main upside is that the southern / interior empty pockets in Zone 0 do pick
up additional families instead of relying on a single awkward exploratory gap
seed. The main downside is that it can start too many restart families in some
sectors.

## Conclusion

If the priority is fuller sector coverage, this is a strong direction. It is
less conservative than `031h`, but it clearly attacks the right problem.
