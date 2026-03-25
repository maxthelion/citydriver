---
title: "Road Network Invariants"
category: "testing"
tags: [testing, invariants, roads, network, geometry]
summary: "Geometric and topological invariants for the road network — minimum separation, crossing rules, hierarchy constraints."
last-modified-by: user
---

## Overview

Road network invariant tests are a **testing mechanism** for verifying the geometry and topology rules in [world state invariants](world-state-invariants). They check road polylines and the network graph for physically impossible or visually absurd configurations.

These are more expensive than bitmap checks (segment intersection tests, graph traversal) but catch problems invisible at the cell level — parallel duplicate roads, crossings without junctions, orphaned streets.

They should be checked after any step that creates or modifies roads (skeleton, zone-boundary, ribbons, growth-tick roads, connect).

## Minimum Separation

**No two road centrelines should run parallel within 5m of each other.**

Roads need space between them for plots, pavements, and buildings. Two roads closer than 5m (one cell at typical resolution) are effectively duplicates or would create an impossibly narrow strip of land.

| Context | Minimum separation |
|---------|-------------------|
| Residential streets (parallel) | 5m between centrelines |
| Residential street alongside collector | 8m (allows pavement + setback) |
| Collector alongside arterial | 10m |

**How to check:** For each road segment, find the nearest parallel segment (angle difference < 15 degrees) and measure perpendicular distance. Flag violations.

**Common causes:** Ribbon layout placing streets too close to existing zone boundary roads; zone-boundary roads duplicating skeleton segments; connect step creating redundant links.

## No Unresolved Crossings

**Residential streets must not cross each other without forming a junction.**

When two roads cross, they must either:
1. Meet at a proper junction node (both roads terminate or split at the intersection), or
2. One road passes over/under the other via a bridge or tunnel (only allowed for higher-tier roads).

An X-crossing where two residential streets pass through each other without a junction is a world-state violation — it represents an impossible physical situation.

| Road A tier | Road B tier | Crossing allowed? |
|-------------|-------------|-------------------|
| Residential | Residential | No — must form junction |
| Residential | Collector | No — must form junction |
| Collector | Collector | No — must form junction |
| Arterial | Any | Yes — bridge/tunnel permitted |
| Skeleton | Any | Yes — bridge/tunnel permitted |

**How to check:** For each pair of road segments that geometrically intersect, verify either (a) there is a junction node at the intersection point, or (b) the higher-tier road is arterial/skeleton class.

**Common causes:** Overlay render scripts drawing two independent street systems (k3 organic + s2 geometric) without merging them; ribbon streets crossing zone boundary roads without being clipped.

## Dead-End Constraints

**No stub road shorter than one plot depth.**

A dead-end road shorter than ~15m serves no purpose — there's no room for a plot to front onto it. Dead-ends should either be long enough to serve plots on both sides, or not exist.

| Constraint | Value |
|------------|-------|
| Minimum dead-end length | 15m (one plot depth) |
| Maximum dead-end length without turning circle | 100m (fire access) |

**How to check:** Find road segments with one endpoint having degree 1 (dead-end). Measure length from dead-end to nearest junction. Flag if < 15m.

## Road Hierarchy

**Lower-tier roads should not carry through-traffic patterns.**

The road network has a hierarchy: skeleton (arterial) > zone-boundary (collector) > ribbon (residential). Lower-tier roads should form local networks that connect to higher-tier roads, not create shortcuts between arterials.

| Rule | Description |
|------|-------------|
| Residential connects to collector or arterial | Every residential street must reach a collector or arterial within 3 hops |
| No residential-to-residential through-routes | A path between two arterials should not pass through more than 4 consecutive residential segments |
| Collector roads connect zones | Collectors should link to skeleton roads at both ends (no dangling collectors) |

## Plot Adjacency

**Every plot must have road frontage.**

A plot (buildable parcel) that has no edge adjacent to a road cell is unbuildable — there's no access. This is both a world-state invariant and a quality metric.

| Constraint | Description |
|------------|-------------|
| All plots have frontage | Every plot polygon shares at least one edge with a road |
| Frontage minimum width | Plot frontage should be at least 5m (one cell) |

**How to check:** For each plot, check that at least one boundary cell is adjacent to a road cell in the roadGrid.

## Relationship to Bitmap Invariants

These network invariants are complementary to the bitmap invariants in [bitmap-invariants](bitmap-invariants). The bitmap invariants catch cell-level conflicts (road in water, building on road). The network invariants catch geometric/topological problems that are invisible at the cell level but obvious visually.

Both should be checked, but network invariants are more expensive (require graph traversal and geometric intersection tests vs. simple per-cell checks).

## Relationship to Petri Loop

The petri loop's tier 2 evaluation should include network invariant checks. These are cheap enough to run programmatically and catch many "obviously wrong" outputs before the expensive visual evaluation (tier 3). See the [petri loop design spec](../../docs/superpowers/specs/2026-03-23-petri-loop-design.md).

Candidate tier 2 heuristics derived from these invariants:
- Count of minimum-separation violations
- Count of unresolved crossings
- Count of dead-ends shorter than 15m
- Percentage of plots with road frontage
