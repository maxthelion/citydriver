---
title: "Land Allocation Model"
category: "functionality"
tags: [zoning, allocation, plots, ribbons, residential, civic, industrial]
summary: "How different zone types should allocate land using type-specific spatial strategies, from ribbon streets to typed civic plots."
last-modified-by: user
---

## Overview

The value bitmap pipeline determines **where** each zone type wants to be. The allocation model determines **what shape** gets placed there. Different zone types have fundamentally different spatial allocation strategies.

The value bitmap is the suitability surface. The allocator stamps actual plots, ribbons, and polygons onto it.

## Allocation Strategies by Zone Type

### Residential (fine/terrace)

Allocates in street-width ribbons, similar to the current [[city-generator-overview|ribbon layout]] system. Houses pack tightly along both sides of a street. Ribbon spacing is tighter in dense central areas and loosens in valuable areas for wealthier housing outside city centres. Frontage-maximising — every house wants a street face.

### Residential (estate)

Grabs a larger polygon (roughly 100×200m, regular or irregular) and fills it as a planned block. Typical of workers' housing near industrial areas, or postwar social housing. The polygon is oriented to road access but the internal layout is self-contained.

### Residential (quality)

Looser spacing, larger individual plots. Responds to terrain — follows contours on hillsides, takes advantage of views. Less concerned with packing density, more with amenity. Villas, large detached houses.

### Commercial

Frontage-based allocation. Claims cells along road edges, typically one plot deep from the road. In a market town, commercial follows the main approach roads into town. The depth and density of commercial frontage increases with centrality and road importance.

### Industrial / Port

Large contiguous polygons. Industrial plots are big (2,000-20,000m²), need loading access, and are less concerned with street frontage than with flat terrain and transport links. Port/dock allocations are linear along the waterfront with deep plots running back from the quay.

### Civic (typed plots)

Civic allocations work from a typology list. Each civic building type has its own size, shape, and placement rules:

| Type | Typical Size | Shape | Placement |
|------|-------------|-------|-----------|
| **Park** | Large (1-5 hectares) | Irregular polygon, terrain-following | Waterfront, hilltops, central |
| **Hospital** | Medium-large (0.5-2 hectares) | Rectangular compound | Accessible, near residential |
| **Church/cathedral** | Small-medium (0.1-0.5 hectares) | Small plot at prominent location | Central, visible, crossroads |
| **School** | Medium (0.2-1 hectare) | Rectangular with grounds | Distributed through residential |
| **Town hall** | Small-medium (0.1-0.3 hectares) | Prominent plot on main square | Central, highest-value civic cell |
| **Cemetery** | Medium-large (0.5-3 hectares) | Irregular, permanent | Edge of settlement, never redeveloped |
| **Market square** | Small-medium (0.1-0.5 hectares) | Irregular polygon | Central, at road convergence |

Each tick, the civic allocator picks the next type from the archetype's civic programme and places it at the highest-value eligible location that fits its size/shape requirements.

### Open Space

Terrain-following irregular polygons. Parks on hilltops, promenades along waterfront, green corridors along rivers. Shape follows natural features rather than imposed geometry.

## Allocation Constraints

All allocators should be mindful of:

- **No useless gaps** — allocations should tessellate where possible, not leave narrow unusable strips between zones
- **Road access** — every allocation needs at least one edge touching a road or street
- **Minimum viable size** — don't create plots too small for their intended use
- **Contiguity** — same-type allocations should form coherent districts, not scattered cells

## Relationship to Value Bitmaps

The [[bitmap-pipeline-model|value bitmap]] tells the allocator where to look. The allocator then stamps a shape at the best location. After placement, the influence layers are recomputed and feed back into the next tick's value bitmaps.

```
value bitmap → allocator picks location → stamps shape → influence recomputed → next tick
```

## Current State

The main pipeline still uses BFS seed-and-grow for non-residential reservation (see [[land-reservation]]). However experiments 040–061 have built a substantially more capable vector-based approach in `src/city/land/`:

- **Commercial frontage** — a shallow strip reserved along anchor road edges, with regular access gaps and a service road one block behind. Produces realistic commercial high street geometry.
- **Parks** — placed as explicit boundary-attached polygons with perimeter roads. Several placement strategies: rectangular, regularised quad, boundary-attached.
- **Terrace bands** — shallow residential strips reserved around civic space (park, square) before generic residential fill.
- **Residual fill** — after reservations are placed, remaining zone area is filled with cross streets and ribbon streets using the incremental street machinery.

This is the approach described in [[micro-reservation-model]]. The allocation strategies in this page — frontage strips for commercial, polygon parks, typed civic plots, ribbon residential — are now substantially implemented in `vectorFrontageLayout.js` for the single-sector case.
