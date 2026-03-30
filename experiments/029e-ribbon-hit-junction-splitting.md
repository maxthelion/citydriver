# 029e Ribbon Hit Junction Splitting

## Goal

Make accepted ribbon hits become real road-network junctions.

Up to `029d`, the cyan ribbon geometry could pass through the recorded
cross-street hit points, but those mid-edge hits were still only polyline
vertices. The graph was not being split there, so the topology lagged behind
the rendered geometry.

This variant tests the proper road-level version:

- keep the current `029d` first-hit / no-spatial-order ribbon walk
- when a ribbon is accepted, split both the ribbon road and the hit cross
  street at each accepted hit
- merge those split nodes into one shared junction through `RoadNetwork`

## Change

In [RoadNetwork.js](/Users/maxwilliams/dev/citygenerator/src/core/RoadNetwork.js),
this variant adds two road-level helpers:

- `ensureGraphNodeOnRoad(...)` projects a point onto a road-owned graph edge and
  splits that edge when needed
- `connectRoadsAtPoint(...)` ensures both roads have a node there, then merges
  them into a shared junction

`#addToGraph(...)` now also tags graph edges with `roadId`, so those helpers can
find the graph edges that belong to a specific road.

In [render-sector-ribbons.js](/Users/maxwilliams/dev/citygenerator/scripts/render-sector-ribbons.js),
accepted cross streets keep their `roadId`, and every accepted ribbon now calls
`splitRibbonHitJunctions(...)` on its recorded `streetPoints`.

This variant also draws a second confirmation marker:

- green marker = geometric ribbon hit point
- blue marker with white outline = actual graph junction node created or reused

## Question

Does the network now treat ribbon-to-cross-street contacts as real topology,
not just drawn geometry?

The images are mainly a sanity check that the confirmed junction markers line up
with the green hit markers. The more important result is in graph topology.

## Output

- [ribbons-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029e-output/ribbons-zone0-seed884469.png)
- [ribbon-failures-zone0-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029e-output/ribbon-failures-zone0-seed884469.png)
- [ribbons-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029e-output/ribbons-zone1-seed884469.png)
- [ribbon-failures-zone1-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029e-output/ribbon-failures-zone1-seed884469.png)
- [ribbons-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029e-output/ribbons-zone2-seed884469.png)
- [ribbon-failures-zone2-seed884469.png](/Users/maxwilliams/dev/citygenerator/experiments/029e-output/ribbon-failures-zone2-seed884469.png)

## Result

This behaves like a topology correction rather than a layout change, which is
what we wanted.

For seed `884469`, the accepted ribbon counts stayed the same as `029d`:

- Zone 0: `4` ribbons
- Zone 1: `2` ribbons
- Zone 2: `6` ribbons

So this variant did not materially change the visible ribbon search behavior.

What it did change is the honesty of the network representation. In the render,
the blue confirmed-junction markers line up with the recorded ribbon hit points
where the cyan ribbons meet the magenta cross streets. That means those hits
are now being turned into real shared graph nodes instead of remaining implicit
mid-edge geometry.

The focused test for this behavior is in
[RoadNetwork.test.js](/Users/maxwilliams/dev/citygenerator/test/core/RoadNetwork.test.js),
where `connectRoadsAtPoint(...)` now splits two roads at a mid-edge crossing and
produces one degree-4 shared junction. The focused test run also passes:

- `npx vitest run test/core/RoadNetwork.test.js test/city/incremental/ribbons.test.js`

## Takeaway

If this behaves as expected, `029e` should be the first ribbon variant that is
topologically honest about its accepted cross-street hits. That should make
later parceling and graph-based post-processing much less fragile than the
earlier “geometry yes, topology no” setup.
