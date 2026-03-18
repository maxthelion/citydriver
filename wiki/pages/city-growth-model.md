---
title: "City Growth Model"
category: "architecture"
tags: [growth, allocation, zones, roads, bitmaps, ribbons, architecture]
summary: "How city development should work: the relationship between grid-based bitmaps, polygon-based zones, road networks, and land allocation."
last-modified-by: user
---

## What We Know Is True About Cities

1. **Different kinds of land usage exist** — residential (various densities), commercial, industrial, civic, open space, agriculture, port. Each has different spatial requirements.

2. **Anchor roads connect to the wider region** — arterial roads and railways arrive from outside and form the skeleton that everything else hangs off.

3. **Development happens incrementally** — each tick, new land is allocated according to rules. The city grows outward from existing development.

4. **Different use types value different things** — industrial values flat edge land, residential values elevation and centrality, commercial values busy streets. These preferences are spatial and can be expressed as bitmap layers.

5. **Zone types influence each other** — placing industrial depresses nearby residential value. Civic and parks boost it. These influences evolve as the city grows.

6. **Streets create the structure** — residential development follows street patterns. Streets follow terrain contours on slopes and form parallel ribbons. Cross streets cap ribbons at intervals.

7. **Roads are barriers and connectors** — they split developable land into parcels (zones) and connect them.

## Two Geometric Systems

The city generator works at two levels of geometric abstraction:

### Grid level (bitmaps)
- 5m cells, 1200×1200 grid
- Spatial layers: elevation, slope, buildability, land value, centrality, waterfrontness, etc.
- Influence layers: development proximity, industrial proximity, etc.
- Value bitmaps: per-use-type suitability surfaces
- Reservation grid: what each cell is allocated as
- Road grid: where roads are

Grid operations: blur, threshold, compose (weighted sum), flood fill. These are fast, parallelisable, debuggable as images.

### Polygon level (zones)
- Development zones: irregular polygons of buildable land, split by roads and water
- Zone boundaries follow terrain, water, and road features
- Each zone has metadata: slope direction, average slope, land value, nucleus ownership
- Ribbon streets are laid out within zones using the polygon boundary and slope data
- Zone polygons sit above the grid — they're computed from grid data but represent higher-level parcels

The ribbon layout system works at the polygon level. It takes a zone boundary, computes a street direction from slope, and sweeps parallel lines across the polygon. This produces the terrain-following, contour-aware street pattern that looks organic.

## What Should Drive What

```
Regional inputs (arterial roads, railways, terrain, water)
    ↓
Spatial layers (bitmaps — buildability, land value, centrality, etc.)
    ↓
Zone extraction (polygons — parcels of buildable land between roads/water)
    ↓
Per-tick growth:
    1. Score zones against value bitmaps → decide what each zone becomes
    2. For residential zones: ribbon layout creates internal streets
    3. Commercial claims road frontage (grid-level, along all roads)
    4. Influence layers recomputed (bitmaps)
    5. New roads from zone boundaries and ribbon gaps update road grid
    ↓
Feedback: new roads → new zones (roads split existing zones) → new spatial layers
```

## Open Questions

### How do zones and bitmaps interact?
Bitmaps tell us WHERE things should go (commercial value is high near central roads). Zones tell us WHAT SHAPE the land parcels are. The allocation decision uses both: score zones against bitmaps, but allocate at zone granularity.

### Should zones be re-extracted each tick?
Currently zones are extracted once (tick 3). But as new roads are laid, they should split existing zones into smaller parcels. Re-extracting zones after road growth would create a natural subdivision mechanism.

### How granular should zone allocation be?
- Industrial: whole zone (large parcels at edges)
- Civic: whole zone or sub-zone (institutional compounds)
- Residential: whole zone, then ribbon-fill internally
- Commercial: not zone-level — frontage along roads
- Open space: whole zone (parks, waterfront)

### What about mixed-use zones?
In real cities, central zones mix commercial frontage with residential behind. The current model separates these — commercial is road frontage, residential fills the rest. Is that sufficient?

### How do roads grow?
Current options we've explored:
1. layoutRibbons fills a whole zone with streets (too aggressive)
2. Ribbon allocator creates gap-roads as it claims (chicken-and-egg)
3. Zone boundaries become roads naturally (promising but untested)

The most promising approach: roads come from two sources:
- **Zone boundaries** — natural street corridors between zones
- **Ribbon layout within residential zones** — internal streets when a zone is assigned residential

### What's the role of the value bitmap?
The value bitmap should score zones for allocation decisions, not drive cell-by-cell claiming. Once a zone is assigned a type, the internal layout (ribbons, frontage) handles the cell-level detail.

## Principles

1. **Bitmaps for spatial analysis, zones for allocation** — don't try to allocate cell-by-cell from bitmaps. Use bitmaps to score zones, then allocate at zone level.

2. **Roads create zones, zones create roads** — the feedback loop is: arterials → zones → assign zones → ribbon streets → more zones. Each tick adds roads that split zones further.

3. **Preserve terrain-following** — the ribbon/zone system produces organic terrain-aware streets. Don't replace it with grid-level BFS that ignores terrain.

4. **One tick model, not competing systems** — each tick should have a clear sequence: score → assign → fill → roads → feedback. Not multiple overlapping allocators competing for cells.
