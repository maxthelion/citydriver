---
title: "Pipeline Step Postconditions"
category: "pipeline"
tags: [pipeline, testing, invariants, postconditions, design]
summary: "What should be true after each pipeline step — the source of truth for validating the pipeline's intent."
last-modified-by: user
---

## Overview

Each pipeline step has an **intention** — what it's trying to achieve. Postconditions describe what should be true after the step completes successfully. They serve three purposes:

1. **Design documentation** — what does this step actually promise?
2. **Test targets** — Level 2 property tests assert these postconditions across random seeds
3. **Regression detection** — if a postcondition fails, we know which step broke and what was expected

Postconditions are NOT exact values ("53 zones"). They are structural properties that should hold for any valid seed ("zone count > 0, every zone has cells").

See [world-state-invariants](world-state-invariants) for the world rules that must hold at ALL steps. This page describes what should be true at SPECIFIC steps.

## Step: skeleton

**Intent:** Build the arterial road network connecting nuclei.

| Postcondition | Description |
|---------------|-------------|
| Roads exist | Road count > 0 |
| Graph nodes exist | At least 2 nodes per nucleus (start + end of at least one road) |
| Graph is connected or one component per nucleus cluster | No isolated nuclei with zero roads |
| No roads in water | roadGrid ∩ waterMask = ∅ (except bridges) |

**What's NOT promised:** Cycles in the graph. The skeleton is an MST — a tree with no cycles. This is correct. Cycles come from boundary edges and zone-boundary roads later.

## Step: boundaries

**Intent:** Add map perimeter and river/water polylines to the planar graph as boundary edges, creating the cycles needed for face extraction.

| Postcondition | Description |
|---------------|-------------|
| Map perimeter is in graph | 4 boundary edges forming the map rectangle |
| River polylines are in graph | Each river segment within map bounds is a graph edge |
| Graph has cycles | Edge count > node count (at least one cycle exists) |
| No duplicate edges | Every node pair connected by at most one edge |

## Step: land-value

**Intent:** Compute a land value score (0-1) for every cell based on flatness, nucleus proximity, and water proximity.

| Postcondition | Description |
|---------------|-------------|
| Layer exists | `landValue` layer is set and has correct dimensions |
| Values bounded | All values in range [0, 1] |
| Non-trivial | Not all zeros — at least some cells have landValue > 0.15 (the zone threshold) |
| Nucleus proximity visible | Cells near nuclei have higher average value than cells far from nuclei |

## Step: zones

**Intent:** Extract development zones from graph faces. Each zone is an area of buildable land enclosed by roads, water, and map boundaries.

| Postcondition | Description |
|---------------|-------------|
| Zones exist | Zone count > 0 |
| Zones have cells | Every zone has cells.length > 0 |
| Zone coverage | Total zone cells > 10% of non-water area |
| No zones in water | No zone cell overlaps waterMask |
| No zone overlap | No cell belongs to two zones |
| zoneGrid consistent | zoneGrid layer matches zone cell membership |

**What's NOT promised yet:** Full face coverage (every buildable cell in a zone). Initial zones from skeleton + boundary edges are coarse — zone-boundary roads subdivide them further.

## Step: zone-boundary

**Intent:** Add secondary collector roads along zone polygon boundaries to subdivide large zones into finer development parcels.

| Postcondition | Description |
|---------------|-------------|
| More edges | Graph has more edges than before this step |
| No duplicate edges | Every node pair connected by at most one edge |
| No dangling edges | Degree-1 nodes only at map boundary, not in interior |
| Roads on buildable land | New road cells are not in water |

**What's NOT promised:** That all zones get subdivided. Small zones or zones without arterial access may be skipped.

## Step: zones-refine

**Intent:** Re-extract zones now that zone-boundary roads have added finer boundaries. Should produce more, smaller zones than the initial extraction.

| Postcondition | Description |
|---------------|-------------|
| Zone count increased or stable | zones-refine count >= initial zones count |
| Zone coverage increased or stable | Total zone cells >= initial total * 0.5 |
| Zones have cells | Every zone has cells.length > 0 |
| No zone overlap | No cell belongs to two zones |
| Zones cover most buildable land | Total zone cells > 30% of non-water area |

**Future target:** When flood-fill is replaced by graph-face extraction for this step, add: every zone has boundingEdgeIds matching its boundary to graph edges.

## Step: spatial

**Intent:** Compute scoring layers (centrality, waterfrontness, edgeness, road frontage, downwindness) used by growth agents.

| Postcondition | Description |
|---------------|-------------|
| All five layers exist | centrality, waterfrontness, edgeness, roadFrontage, downwindness layers set |
| Values bounded | All values in range [0, 1] |
| Centrality gradient | Cells near nuclei have higher centrality than edge cells |
| Road frontage non-trivial | Cells adjacent to roads have roadFrontage > 0 |

## Step: growth-N:influence

**Intent:** Blur reservation grid into proximity gradients. Retreat agriculture near active development.

| Postcondition | Description |
|---------------|-------------|
| Influence layers computed | At least one influence layer has non-zero values (after tick > 1) |

## Step: growth-N:value

**Intent:** Compose per-agent value bitmaps from spatial + influence layers.

| Postcondition | Description |
|---------------|-------------|
| Value layers computed | One value bitmap per active agent |

## Step: growth-N:ribbons

**Intent:** Throttled ribbon layout — place parallel streets in zones near existing development.

| Postcondition | Description |
|---------------|-------------|
| Road count non-decreasing | Road count >= road count before this step |
| New roads in zones | Any new road cells are within zone boundaries |
| No roads in water | roadGrid ∩ waterMask = ∅ |

## Step: growth-N:allocate

**Intent:** Run agent allocation loop — blob, frontage, or ribbon allocators claim cells.

| Postcondition | Description |
|---------------|-------------|
| Reservations within zones | reservationGrid cells are inside zoneGrid |
| Reservation types valid | All values in range [0, 9] |
| Monotonic | Total reserved cells >= total before this step |

## Step: growth-N:roads

**Intent:** Grow roads from ribbon gaps via A* pathfinding. Fill agriculture at development frontier.

| Postcondition | Description |
|---------------|-------------|
| Road count non-decreasing | Road count >= road count before this step |
| No roads in water | roadGrid ∩ waterMask = ∅ |

## Step: connect

**Intent:** Connect zone spines to skeleton road network. Fix disconnected local-road components.

| Postcondition | Description |
|---------------|-------------|
| Road network connected | Ideally one connected component, or at most a few (isolated by water) |
| No roads in water | roadGrid ∩ waterMask = ∅ |

## What's Tested Today vs What Should Be

| Step | World rules (Level 1) | Postconditions (Level 2) |
|------|----------------------|-------------------------|
| skeleton | Bitmap invariants ✅ | Road count, graph structure ❌ |
| boundaries | — | Cycles exist, no duplicates ❌ |
| land-value | — | Layer exists, values bounded ❌ |
| zones | Block invariants ✅ | Zone count, coverage, no empties ❌ |
| zone-boundary | Bitmap invariants ✅ | No duplicates, no dangling ❌ |
| zones-refine | Block invariants ✅ | Count increased, coverage ❌ |
| spatial | — | Layers exist ❌ |
| growth-N:* | Bitmap invariants ✅ | Monotonicity ❌ |
| connect | Bitmap invariants ✅ | Connectivity ❌ |

Level 1 (world rules) is mostly covered. Level 2 (postconditions) is entirely untested — these are the property tests described in [pipeline-property-testing](pipeline-property-testing).
