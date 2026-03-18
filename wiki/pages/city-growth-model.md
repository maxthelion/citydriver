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

## Pipeline Sequence

```
1. SETUP
   Regional inputs arrive: terrain, water, arterial roads, railways
   Spatial layers computed: elevation, slope, buildability, land value

2. SKELETON ROADS (tick 1)
   Arterial roads connecting settlements. These are the anchor roads.

3. FIRST ZONES (tick 3)
   Extract development zones — large parcels between arterials and water.
   These are coarse: some cover 25% of the map.

4. SECONDARY ROADS
   Run roads along first-zone boundaries. The edges of zones are natural
   street corridors — they follow terrain, water, and road features.
   This creates a secondary road network between the arterials.

5. SECOND ZONES (re-extract)
   Re-extract zones. The new secondary roads split the large first zones
   into smaller, finer-grained parcels. These are the allocation unit.

6. SPATIAL LAYERS (tick 4)
   Compute centrality, waterfrontness, edgeness, roadFrontage, etc.
   Compose per-use value bitmaps from these layers.

7. PER-TICK GROWTH (tick 5+)
   Each tick:
   a. Score unassigned zones against value bitmaps
   b. Assign N highest-scoring zones to use types
   c. For residential zones: ribbon layout creates internal streets
   d. Commercial claims road frontage (strongly favouring arterials)
   e. Influence layers recomputed
   f. Optionally: new roads from ribbon gaps split zones further

8. FEEDBACK
   New roads → zones re-split → finer parcels → more allocation.
   Each tick the city gets finer-grained as roads subdivide zones.
```

### Road Hierarchy and Commercial

Commercial strongly favours anchor (arterial) roads. The main high street forms along arterials first. Secondary roads (zone boundaries) get less commercial. Ribbon streets within residential zones get little to none.

This creates a realistic gradient:
- **Arterials**: dense commercial frontage (shops, markets)
- **Secondary roads**: some commercial, mixed with residential
- **Ribbon streets**: purely residential

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
Roads come from three sources at different scales:

1. **Skeleton arterials** — regional connections, placed once (tick 1)
2. **Zone boundary roads** — placed along edges of first zones, creating secondary network
3. **Ribbon streets** — placed inside residential zones when assigned, creating tertiary network

Each level of road subdivides zones further, creating a natural refinement cascade.

### What's the role of the value bitmap?
The value bitmap scores zones for allocation decisions — not cell-by-cell claiming. Each zone is scored by averaging the value bitmap across its cells. The highest-scoring zones for each use type get assigned first. Once assigned, the internal layout (ribbons for residential, nothing for industrial) handles cell-level detail.

### Should zones be re-extracted after new roads?
Yes. Each time new roads are placed (zone boundary roads, ribbon streets), they split existing zones. Re-extracting zones after road placement creates progressively finer parcels. This is the subdivision mechanism.

## Principles

1. **Bitmaps for spatial analysis, zones for allocation** — don't try to allocate cell-by-cell from bitmaps. Use bitmaps to score zones, then allocate at zone level.

2. **Roads create zones, zones create roads** — the feedback loop is: arterials → zones → assign zones → ribbon streets → more zones. Each tick adds roads that split zones further.

3. **Preserve terrain-following** — the ribbon/zone system produces organic terrain-aware streets. Don't replace it with grid-level BFS that ignores terrain.

4. **One tick model, not competing systems** — each tick should have a clear sequence: score → assign → fill → roads → feedback. Not multiple overlapping allocators competing for cells.
