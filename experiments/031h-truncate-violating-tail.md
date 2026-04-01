# 031h: Truncate Violating Tail

## Goal

Fix the all-or-nothing behavior of family child rows.

In `031g`, a child row could be mostly good but still get rejected entirely if a
later segment crossed another row, got too close, or drifted too far from the
parallel angle rule. That is too harsh for the kind of layout we want. A better
rule is:

- keep the valid part of the row
- drop only the violating tail
- accept the shortened row if it is still long enough

## Change

- Keep `031g`'s midpoint-segment guide for inherited child rows
- When a parallel relation check fails, do not immediately reject the whole row
- Instead:
  - locate the failing child junction or child segment
  - trim the child row back to the last clean inherited junction on that side
  - rebuild the shortened row
  - re-run relation validation
- Only reject the row if trimming cannot produce a valid remaining street

This is intentionally conservative. It does **not** clip to an arbitrary
mid-segment point. It only rolls back to an existing junction, so the row
object stays well-formed.

## Result

This looks like a real improvement over `031g`.

On seed `884469`:

- Zone 0 goes from `35` ribbons in `031g` to `38`
- Zone 1 goes from `17` to `18`
- Zone 2 goes from `63` to `67`

The main benefit is not just the counts. Rows that were previously thrown away
because of one bad tail segment now survive as shorter, cleaner streets. That
matches the intended behavior much better.

## Likely Next Step

The next refinement would be to make the debug view show when a row was
accepted after truncation, so it is easier to see which families were salvaged
by this rule and whether any of those truncated rows should seed new growth at
their new endpoints.
