# 031k: Used-Street Gap Restarts, High Threshold

## Goal

Keep the good part of `031j` while cutting back the number of restart families.

## Change

- Keep `031j`'s used-street gap restart preference
- Raise the restart threshold so a new family only starts when the leftover span
  is genuinely large

## Result

This reins the behavior back a bit, but not very selectively.

On seed `884469`:

- Zone 0 lands at `59` ribbons
- Zone 1 drops to `13`
- Zone 2 lands at `68`

So it still fills aggressively in Zone 0, but it also suppresses useful restart
families elsewhere.

## Conclusion

This is probably not the best compromise. It suggests the next control should be
more sector-aware than a single global gap threshold.
