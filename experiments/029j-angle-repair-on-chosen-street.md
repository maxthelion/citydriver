# 029j Angle Repair On Chosen Street

## Goal

Keep `029i`'s cleaner "choose the street first" behavior, but stop treating a
slightly awkward landing on that chosen street as a hard failure.

## Change

In [ribbons.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/ribbons.js),
this variant adds a local repair pass inside the angle-failure path:

1. March to the first eligible new street as in `029i`.
2. Choose a local sampled landing on that street.
3. If that landing fails only because the arrival angle is too acute, search
   nearby samples on the same street.
4. Accept the best repaired landing that:
   - stays local to the first-hit region
   - satisfies the angle gate
   - still makes a valid ribbon polyline

So the algorithm no longer gives up immediately when it reaches the right
street but lands at a slightly bad point.

## Question

Does a small on-street repair search convert some of `029i`'s local `angle`
failures into successful ribbons without reintroducing the long-range
overreaching behavior from `029h`?

## Output

- [ribbons-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029j-output/ribbons-zone0-seed884469.png)
- [ribbon-failures-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029j-output/ribbon-failures-zone0-seed884469.png)
- [ribbons-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029j-output/ribbons-zone1-seed884469.png)
- [ribbon-failures-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029j-output/ribbon-failures-zone1-seed884469.png)
- [ribbons-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029j-output/ribbons-zone2-seed884469.png)
- [ribbon-failures-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029j-output/ribbon-failures-zone2-seed884469.png)

## Result

This is a real improvement over `029i`.

On seed `884469`, the local repair pass converts many of the chosen-street angle
failures into successful ribbons without reintroducing the global target
overreach from `029h`:

- Zone 0 stays at `4` ribbons
- Zone 1 stays at `2`
- Zone 2 improves from `4` ribbons in `029i` to `6`

The failure overlays are also cleaner. In `029i`, many sectors in Zone 2 had
become "reach the right street, then die on angle." In `029j`, most of those
have been repaired locally, so the remaining failures are mostly `ray-miss`
and a small amount of `out-of-zone` / `angle` in the hardest sectors.

## Takeaway

This looks like the right next state machine:

- choose the next street by actual first-hit geometry
- then recover the landing locally on that street
- only fail once local repair also runs out of options

This keeps the cleaner street choice from `029i`, but removes a lot of its
over-eager pessimism once the right street has already been reached.
