# 029g Stronger Local Contour Weight

## Goal

`029f` proved that ribbons can use a local terrain gradient field, but the
visible change on the standard seed was pretty subtle.

This variant asks a simpler follow-up question:

- keep the `029f` local contour field
- keep the current first-hit / no-spatial-order walk
- keep real graph junction splitting
- just turn the contour weighting up a bit

## Change

In [ribbons.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/ribbons.js),
the guide weights are shifted moderately toward the local contour field:

- `contourGuideBlend`: `0.12 -> 0.24`
- `guideMarchPerpBlend`: `1.4 -> 1.15`
- `guideMarchContourBlend`: `0.15 -> 0.4`

So the ribbon still launches from a perpendicular bias, but once it is marching
it is more willing to bend with the locally sampled contour direction.

## Question

Does a stronger local contour influence make the cyan streets read more like
terrain followers without causing new misses or bad street hits?

## Output

- [ribbons-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029g-output/ribbons-zone0-seed884469.png)
- [ribbon-failures-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029g-output/ribbon-failures-zone0-seed884469.png)
- [ribbons-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029g-output/ribbons-zone1-seed884469.png)
- [ribbon-failures-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029g-output/ribbon-failures-zone1-seed884469.png)
- [ribbons-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029g-output/ribbons-zone2-seed884469.png)
- [ribbon-failures-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029g-output/ribbon-failures-zone2-seed884469.png)

## Result

This changed the behavior a little, but not dramatically.

For seed `884469`, the accepted ribbon counts stayed the same as `029f`:

- Zone 0: `4` ribbons
- Zone 1: `2` ribbons
- Zone 2: `6` ribbons

The visible ribbon geometry is still close to `029f`, but the stronger contour
pull does have a couple of small effects:

- Zone 1 Sector 0 changed from `ray-miss + ray-miss` in `029f` to
  `out-of-zone + ray-miss`, which suggests the guide is bending a bit more
  before giving up
- Zone 2 Sector 6 lost the previous `angle` reject and now ends as
  `ray-miss + ray-miss`, which means the stronger contour pull avoided one
  acute arrival but did not actually convert it into a successful hit

So the contour weighting is being felt, but the overall street picture is still
subtle rather than transformative.

The focused verification still passes:

- `npx vitest run test/city/incremental/ribbons.test.js test/core/RoadNetwork.test.js`

## Takeaway

This suggests the missing piece is not just “listen to the contour more.”

Compared with `029f`, a stronger local contour pull can change the failure mode,
but on the real seed it still does not materially improve coverage or produce a
much more obviously terrain-following result. The next useful move is probably
not another weight tweak by itself, but a change to how the march lands on the
next street once the guide has curved into roughly the right corridor.
