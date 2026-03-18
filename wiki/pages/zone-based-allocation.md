---
title: "Zone-Based Allocation"
category: "functionality"
tags: [zones, allocation, ribbons, roads, residential, industrial]
summary: "Using development zones as the primary unit for land reservation, with zone boundaries as road locations and sub-zones for finer control."
last-modified-by: user
---

## Key Insight

Development zones already encode terrain-awareness, buildability, road-splitting, and slope orientation. Rather than allocating cell-by-cell (which produces either blobs or struggles with chicken-and-egg road problems), use zones as the primary allocation unit.

## What Zones Already Give Us

Zones are created by `extractDevelopmentZones`:
- **Voronoi partitioning** around nuclei — natural territories
- **Terrain filtering** — only buildable, suitable-slope land
- **Road-split** — existing roads act as zone boundaries, so zones naturally sit between roads
- **Water-split** — rivers and coast form zone edges
- **Slope metadata** — each zone knows its average slope and slope direction
- **Boundary polygons** — terrain-following outlines
- **Priority ordering** — by land value and distance from nucleus

This means zones already have the properties that make [[bitmap-pipeline-model|ribbon layout]] work well: they're oriented relative to slope, bounded by roads, and terrain-aware.

## Zone-Level Allocation

Instead of cell-by-cell BFS, assign a use type to zones or groups of zones:

- **Industrial** — assign whole zones at edges, near waterfront/downwind. The zone boundary becomes the industrial district boundary. Natural shape from terrain.
- **Civic** — assign smaller zones near centre for institutional compounds
- **Open space** — assign zones at waterfront, hilltops
- **Residential** — assign central/mid-distance zones, then fill with ribbons using the zone's slope orientation
- **Commercial** — not zone-level; frontage along roads between zones

The value bitmap still drives *which* zones get which use type — score each zone by averaging its value bitmap, then assign the highest-scoring zones to each use type.

## Zone Boundaries as Roads

Zone edges are natural road locations:
- Zones are already split by existing roads
- The gaps between zones (where terrain filtering removed cells) are natural street corridors
- Zone boundaries could be explicitly marked as road cells, creating a street network that follows terrain and connects the zone system

This solves the road-before-development problem: the zone boundaries *are* the primary street network.

## Sub-Zones for Finer Control

Zones can be large (50,000+ cells). For more granular control, subdivide large zones:
- Split along contour lines (using slope direction)
- Split at regular intervals perpendicular to the zone's ribbon orientation
- Each sub-zone is still terrain-aware and inherits the parent's slope metadata

This gives finer tick-by-tick control without losing the terrain-following property.

## Ribbon Layout Within Zones

Once a zone is assigned as residential, the existing ribbon layout logic fills it with streets:
- Ribbon direction comes from the zone's slope orientation (contour-following on slopes, nucleus-bearing on flat)
- Spacing comes from development pressure
- Cross streets at regular intervals
- Streets clip to zone boundary

The key difference from the current approach: ribbons run within an already-assigned zone, not as a competing allocator trying to find roads to sprout from.

## Preserving What Works

The ribbon layout system produces nice terrain-following street patterns because:
1. Zone orientation follows slope contours
2. Streets are clipped to zone boundaries (which follow terrain)
3. Road-splitting means zones sit naturally between arterials

Going too organic (pure BFS spread, cell-by-cell allocation) loses these properties. Zone-based allocation preserves them because the zone geometry encodes the terrain relationship.

## Commercial Exception

Commercial doesn't work at zone level — it's fundamentally about road frontage. Commercial should still be allocated as frontage along roads (both arterials and zone-boundary roads), one plot deep. The zone system creates the road network; commercial fills along it.

## Tick Model

Each tick:
1. Score unassigned zones against value bitmaps
2. Assign N highest-scoring zones to use types (based on archetype priority)
3. For newly-assigned residential zones, run ribbon layout to create internal streets
4. Commercial claims frontage along all roads (arterials + zone boundaries + ribbon streets)
5. Influence layers recomputed for next tick
