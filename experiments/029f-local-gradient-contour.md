# 029f Local Gradient Contour Pull

## Goal

Keep the `029e` street-to-street hit model and real junction splitting, but
replace the single sector-wide contour vector with a **local** contour
direction sampled from the terrain as the ribbon marches.

The question is whether the cyan streets recover more of the older
terrain-following feel when the contour pull comes from the local gradient
field instead of the sector's average `slopeDir`.

## Change

This variant reuses the existing gradient-field helper from
[constructionLines.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/constructionLines.js)
instead of inventing a second terrain-sampling path.

The changes are:

- `buildGradientField(...)` now exposes `getGradWorld(...)` so other algorithms
  can sample the smoothed gradient field in world coordinates
- [ribbons.js](/Users/maxwilliams/dev/citygenerator/src/city/incremental/ribbons.js)
  now builds that gradient field once per sector
- guide launch uses the local contour direction at the current junction point
- march steps use the local contour direction at the current sample point
- the old zone-level contour direction is still kept as a fallback when the
  local gradient is too weak or unavailable

So the ribbon walk is still:

- launch perpendicular from the current cross street
- accept the first new cross street actually hit
- create real graph junctions at accepted hits

But now the weak contour pull is sampled locally instead of coming from one
sector-average vector.

## Question

Does this recover a more genuinely terrain-following shape without reintroducing
the earlier “shoot toward the wrong street” failures?

## Output

- [ribbons-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029f-output/ribbons-zone0-seed884469.png)
- [ribbon-failures-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029f-output/ribbon-failures-zone0-seed884469.png)
- [ribbons-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029f-output/ribbons-zone1-seed884469.png)
- [ribbon-failures-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029f-output/ribbon-failures-zone1-seed884469.png)
- [ribbons-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029f-output/ribbons-zone2-seed884469.png)
- [ribbon-failures-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029f-output/ribbon-failures-zone2-seed884469.png)

## Result

This is technically successful, but visually modest on the standard seed.

For seed `884469`, the accepted ribbon counts stayed the same as `029e`:

- Zone 0: `4` ribbons
- Zone 1: `2` ribbons
- Zone 2: `6` ribbons

The visible ribbon shapes are only slightly different. The main small change in
the diagnostics is that some failures moved a little and Zone 1 Sector 0
changed from `water + ray-miss` in `029e` to `ray-miss + ray-miss` here.

So the local gradient field is definitely wired in and usable, but on these
terrain-face sectors it does not create a dramatic new look by itself. That
likely means the sectors are already internally fairly coherent in slope
direction, so replacing the sector-average contour vector with a local one only
changes the march subtly.

The focused verification also passes:

- `npx vitest run test/city/incremental/ribbons.test.js test/core/RoadNetwork.test.js`

There is now a test in
[ribbons.test.js](/Users/maxwilliams/dev/citygenerator/test/city/incremental/ribbons.test.js)
showing that ribbons can respond to a local elevation field when the contour
weights are increased.

## Takeaway

This was still worth doing. It confirms that local contour sampling is possible
without copying terrain code, and it does so by reusing the existing gradient
field helper.

But `029f` also suggests that “use a local contour field” is not, by itself,
the missing breakthrough on the real seed. The next improvement probably needs
to come from how strongly that local contour can influence the march, or from
where the march starts and stops, rather than only from swapping the source of
the contour direction.
