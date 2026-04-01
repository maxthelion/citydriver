# 031i: Gap Seed Borrow Guide

## Goal

Make `seed-gap` restarts less erratic.

The problem in `031h` was that a gap restart could begin as a completely fresh
exploratory row inside an existing fabric. That made some restart rows look much
less disciplined than inherited family rows.

## Change

- Keep `031h`'s midpoint-guided inherited rows
- Keep tail truncation on relation failure
- For `seed-gap` anchors, try to borrow the nearest compatible existing row on
  the same anchor street as a construction guide
- Still treat the result as a new family, not as a child of the borrowed row

## Result

This was a useful idea, but it did not fix the main bad example.

On seed `884469`:

- Zone 0 goes from `38` ribbons in `031h` to `40`
- Zone 1 stays at `18`
- Zone 2 goes from `67` to `73`

The important limitation is that the worst gap restart in Zone 0 was anchored on
a street with no usable prior family junctions, so there was nothing to borrow.

## Conclusion

Helpful in principle, but not sufficient on its own. Gap restarts also need a
better choice of *which* street to restart from.
