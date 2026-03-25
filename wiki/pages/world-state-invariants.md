---
title: "World State Invariants"
category: "testing"
parent: "pipeline-invariant-tests"
tags: [invariants, world-state, rules, design]
summary: "Falsifiable rules about what must and must not exist in the generated world. Tested by bitmap invariants and network geometry checks."
last-modified-by: user
---

## Overview

World state invariants are rules about the generated city that must always hold. They describe the *world*, not the code — "no road runs through water" rather than "roadGrid and waterMask don't overlap." The bitmap invariant tests are one mechanism for verifying these rules; network geometry checks are another.

Violations indicate that the generator has produced something physically impossible or visually absurd. They should be caught as early as possible in the pipeline.

## Water

| Invariant | Description |
|-----------|-------------|
| No roads in water | A road cannot pass through a water cell (bridges are recorded separately, not as road-in-water) |
| No railways in water | Same as roads — bridges are separate |
| No buildings in water | No structure can occupy a water cell |
| No development [[zones]] in water | Zones are buildable land only |

## Roads — Layer Conflicts

| Invariant | Description |
|-----------|-------------|
| No buildings on roads | A building cell cannot overlap a road cell |
| Road grid matches polylines | Every road grid cell is explainable by walking the road's polyline at fine intervals |
| No duplicate road grid stamps | Only one code path stamps a given road into the grid |

## Roads — Geometry

| Invariant | Description |
|-----------|-------------|
| Minimum road separation | No two road centrelines run parallel within 5m of each other. Two closer roads are effectively duplicates. |
| Residential separation from collector | Residential street centreline at least 8m from parallel collector (allows pavement + setback) |
| Collector separation from arterial | Collector centreline at least 10m from parallel arterial |
| No unresolved crossings (residential) | Two residential streets cannot cross without forming a junction — there is no physical way for this to exist |
| No unresolved crossings (collector) | Two collectors cannot cross without a junction |
| No cross-face street crossings | Streets generated in different terrain faces must not cross each other. Each face produces streets in its own direction; where faces meet, streets should terminate or form junctions, not pass through each other. |
| Arterials may bridge/tunnel | Arterial or skeleton roads may cross other roads via bridge or tunnel |
| Dead-end minimum length | A dead-end road must be at least 15m long (one plot depth) — shorter serves no purpose |
| Junction elevation consistency | Connected junctions (parallel street endpoints) should be at similar elevation. Max gradient 15% for a residential street. Junctions should be matched by elevation, not by sequential position along the cross street. |

## Roads — Topology

| Invariant | Description |
|-----------|-------------|
| All residential streets reachable | Every residential street segment is connected to the skeleton road network (no orphaned streets) |
| Residential connects to higher tier | Every residential street reaches a collector or arterial within 3 hops |
| Collectors connect to skeleton | Collector roads link to skeleton roads at both ends (no dangling collectors) |

## Plots and Buildings

| Invariant | Description |
|-----------|-------------|
| Every plot has road frontage | A plot must share at least one edge with a road — no landlocked [[plots]] |
| Frontage minimum width | Plot frontage is at least 5m (one cell width) |
| Buildings within plots | Building footprints do not extend beyond their plot boundary |

## Railways

| Invariant | Description |
|-----------|-------------|
| No buildings on railway | Building cell cannot overlap railway cell |
| Station on dry land | Station position is not in water |
| Station near railway | Station is within 3 cells of a railway cell |
| Smooth railway elevation | Elevation change along railway path does not exceed max gradient per step |
| Entry elevations above sea level | Railway entry points are above sea level |

## Land Use

| Invariant | Description |
|-----------|-------------|
| [[nuclei|Nuclei]] on buildable land | Settlement nuclei are on land with buildability > 0.2 |
| Zones on buildable land | Zone cells have buildability above threshold |
| Reservations within zones | Every reservation cell is inside a zone |
| Valid reservation types | Reservation grid values are valid enum (0-9) |

## Terrain

| Invariant | Description |
|-----------|-------------|
| Finite elevation | All elevation values are finite numbers within reasonable range |
| Sea cells below sea level | Water cells from sea/lake have elevation ≤ sea level |

## Testing Mechanisms

These invariants are verified by different testing approaches depending on cost and complexity:

| Mechanism | What it checks | Cost | Implemented | See |
|-----------|---------------|------|-------------|-----|
| Bitmap invariant tests | Layer overlap rules (water/road, road/building, etc.) | Cheap — per-cell bitwise checks | ✅ | `src/city/invariants/bitmapInvariants.js` |
| Graph integrity checks | Duplicate edges, dangling edges | Cheap — graph traversal | ✅ | `src/city/invariants/polylineInvariants.js` |
| Street geometry checks | Parallel separation, crossings, dead-ends, elevation consistency | Medium — segment intersection | ✅ | `src/city/invariants/streetGeometryChecks.js` |
| k3 invariant tests | All geometry checks applied to k3 output across seeds | Medium — runs k3 on real terrain | ✅ (4 failures) | `test/city/invariants/k3StreetInvariants.test.js` |
| Pipeline postconditions | Zone count, coverage, road count, monotonicity | Medium — runs pipeline per seed | ✅ | `test/city/pipeline/pipelinePostconditions.test.js` |
| Graph connectivity checks | Reachability, hierarchy, orphaned streets | Medium — BFS/DFS traversal | ❌ | [road-network-invariants](road-network-invariants) |
| Plot adjacency checks | Frontage rules | Cheap — boundary cell adjacency | ❌ | [road-network-invariants](road-network-invariants) |

## Land Model Invariants (from specs/v5/land-model.md)

These invariants are defined in the land-model spec but NOT YET IMPLEMENTED in code or tests. They describe the target state where blocks (graph faces) are the primary spatial unit.

### Face Coverage

| Invariant | Description |
|-----------|-------------|
| Every cell in one face | Every non-road, non-water cell belongs to exactly one graph face. No cell belongs to two faces. No cell is in no face. |
| Face-road duality | Every road in the network has exactly two faces on either side (or one face and the outer/edge face) |
| No orphan blocks | Every block shares at least one boundary edge with the road network. If a block has no bounding road, it's a bug or a missing road. |

### Boundary Types (NOT YET IMPLEMENTED)

The land-model spec defines [[boundaries]] as anything that separates land — not just roads. Graph faces should be bounded by:
- Roads
- Water edges (rivers, coastline)
- Map boundary edges
- Railway edges
- Planning lines (no physical form)

Currently only roads are in the [[planar-graph|planar graph]]. Water and map boundaries are not represented as graph edges, which is why graph-face extraction fails on tree-like skeletons — there aren't enough edges to form closed faces.

### Width Accounting (NOT YET IMPLEMENTED)

| Invariant | Description |
|-----------|-------------|
| Cell exclusivity | Every cell is exactly one of: road, water, railway, buildable, or unbuildable. No overlaps, no gaps. Sum equals width × height. |
| Width consistency | No buildable cell is within road.width/2 of a road centreline |
| Inset polygon containment | Every block's inset polygon is strictly contained within its face polygon |

### Containment (NOT YET IMPLEMENTED)

| Invariant | Description |
|-----------|-------------|
| Plot in block | Every plot is inside exactly one block |
| Block in bounds | Every block is inside the map bounds |
| Plot within inset | No plot boundary extends beyond its containing block's inset polygon |

### Bidirectional References (NOT YET IMPLEMENTED)

| Invariant | Description |
|-----------|-------------|
| Road→block consistency | Every road references exactly the blocks on its left and right sides |
| Block→road consistency | Every block's bounding edge list matches the roads that bound it |

## Migration Status

From `specs/v5/land-model.md` migration path:

| Step | Description | Status |
|------|-------------|--------|
| 1 | Add invariant checks | Partially done — bitmap/polyline/block invariants exist, land-model invariants not yet |
| 2 | Unify zones and graph faces | Partially done — graph-face extraction exists but only roads are graph edges. Needs water + map boundary edges. |
| 3 | Add bidirectional references | Not done |
| 4 | Add inset polygons | Not done |
| 5 | Introduce boundary types | Not done — this is the KEY missing piece for step 2 |

**Critical dependency:** Step 2 requires step 5. Graph-face extraction can't produce full face coverage from roads alone (tree-like skeletons have no cycles). Adding water edges and map boundary to the graph would create enough faces.

## Relationship to Petri Loop

The petri loop uses invariants as part of its three-tier evaluation:

- **Tier 1** — [[bitmap-invariants|Bitmap invariants]] (must pass or instant reject)
- **Tier 2** — Network geometry heuristics derived from these invariants (must not regress)
- **Tier 3** — Visual evaluation by judge agent (subjective quality)

Adding new invariants to this page makes them candidates for automated checking in tiers 1 and 2.
