# V5 TODO

## Revisit growth strategies

The compare screen pipeline handles adding plots and growing nuclei. All current strategies likely need revisiting:

- Review how nuclei are grown
- Review how plots are added
- Evaluate each strategy in the compare mode and assess what's working / what isn't

## City view: render surrounding region

When viewing a city, render the rest of the region around the city square. Use the existing lower-resolution regional data rather than generating city-level detail for the surroundings.

## Building instancing

Building generation creates many Three.js objects per building (~116 `new THREE.*` calls in generate.js). Rather than generating a unique building for every plot, generate a palette of 10-20 variations per archetype from different seeds, then reuse them via `THREE.Group.clone()` (shares geometry/material data) or `THREE.InstancedMesh` (reduces draw calls). Should significantly improve performance with large numbers of buildings.

## Bridge variety

Render multiple different bridge styles on the city map (e.g. stone arch, suspension, beam) rather than a single type.

## Sandy beaches

Add sandy beaches along coastlines on the map.

## River rendering

The terrain mesh is a uniform-resolution PlaneGeometry with vertex colors — rivers look blocky. Approach: carve an oversized valley into the coarse terrain mesh so the low-res river bed is never visible, then place a separate high-resolution river bed mesh on top that follows the actual river path with smooth banks. This avoids adaptive tessellation complexity while giving crisp river edges.

## Rivers (generation)

Rivers still have significant problems:
- Disconnected segments appearing
- Overall river generation doesn't work well — needs a fundamental rethink

## Ribbon event log / replay

Add a replayable event log for ribbon generation so we can inspect ordered
operations, trace family history, and rerun individual failed attempts.
See [ribbon-event-log-replay-plan.md](/Users/maxwilliams/dev/citygenerator/specs/v5/ribbon-event-log-replay-plan.md).

## Shared-node road cutover

Replace the current `Road` + mutable `PlanarGraph` dual model with shared
road nodes and ordered road ways as the canonical internal representation.
This is primarily to help seam joining, ribbon junction sharing, and remove
the sync problems in `RoadNetwork`.
See [shared-node-road-cutover.md](/Users/maxwilliams/dev/citygenerator/specs/v5/shared-node-road-cutover.md).
