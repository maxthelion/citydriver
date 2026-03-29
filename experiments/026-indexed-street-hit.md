# 026 Indexed Street Hit

## Idea

Previous variants picked a target point by searching along the neighboring cross
street's arc length. That made split streets awkward because the algorithm was
still solving against abstract street parameters rather than "what does the
guide actually hit in space?"

This variant adds a separate **street index bitmap** for the committed cross
streets in a sector. It does **not** replace the existing boolean `roadGrid`.
Instead it provides a second lookup layer that answers "which cross street
index occupies this cell?"

The seed-link experiment then changes from:

- choose a likely target `t` on the next street
- search candidate points on that street

to:

- start at the seed anchor
- march a guide polyline outward, blending local perpendicular with sector
  contour direction so the guide can bend slightly
- stop when the march first hits the **next street's** cells in the index
  bitmap
- project that rough hit back onto the next street's polyline and use the
  projected point as the exact junction

## Implementation

- Added [streetIndexBitmap.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/streetIndexBitmap.js)
  to build a separate per-cell street identity bitmap with small overlap
  buckets.
- Updated [ribbons.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/ribbons.js)
  so `seed-link` placement uses a bitmap-guided march and then projects the hit
  back onto the next street.
- Kept failure tracing on, with new reasons:
  - `wrong-street`
  - `ray-miss`
- Updated [ribbons.test.js](/Users/maxwilliams/dev/citygenerator/test/city/incremental/ribbons.test.js)
  so the tests assert that the link hits an adjacent street, without requiring
  a straight 2-point segment.

## Result

`026` is a useful step forward.

- Zone 1 stayed at `2/2` ribbons and the cyan seed links now read more like
  actual projected guides that bend into the next street, instead of arbitrary
  endpoint guesses.
- The new failures are much more informative:
  - `wrong-street` means the guide hit a different street before the intended
    adjacent one.
  - `ray-miss` means the guide never touched the intended next street at all.

Those are better failure modes than the earlier "bad acute candidate line" bug,
because they directly expose the spatial problem.

## Output

- [ribbons-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/026-output/ribbons-zone0-seed884469.png)
- [ribbons-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/026-output/ribbons-zone1-seed884469.png)
- [ribbon-failures-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/026-output/ribbon-failures-zone1-seed884469.png)
- [ribbons-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/026-output/ribbons-zone2-seed884469.png)

## Next

If we continue on this branch, the next high-value change is:

- keep the street index bitmap
- but constrain the guide so that when it sees a non-adjacent street first, it
  can slide or re-seed rather than immediately failing as `wrong-street`

That would preserve the honesty of the bitmap hit model while making it less
brittle in dense sectors.
