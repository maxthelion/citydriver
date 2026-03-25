---
title: "Zones"
category: "concepts"
tags: [zones, blocks, land, development, pipeline, concepts]
summary: "What a zone is, why it exists, how it's created, and what it's for. The foundational spatial concept of the city generator."
last-modified-by: user
---

## What is a Zone?

A zone is **a piece of land enclosed by boundaries** — roads, rivers, coastline, or the edge of the map. It's the city's fundamental spatial unit: the answer to "what's between these roads?"

In a real city, these are the blocks you see on a map — the irregular shapes formed by the street grid, bounded by roads on all sides. Everything that happens in the city happens inside a zone: buildings go up, gardens are laid out, parks are created, factories are built.

## Why Zones Exist

Zones serve three purposes in the generator:

### 1. They describe what land is available

Before you can build anything, you need to know where the buildable land is. Zones are the buildable land — the areas that aren't road, aren't water, aren't too steep. A zone's cells are the cells where something *could* be built.

### 2. They provide spatial context

A zone knows things about its land:
- **Slope** — is it flat, gently sloping, or steep? This determines street orientation (contour-following vs grid).
- **Land value** — is this prime central land or distant edge land? This determines what gets built here.
- **Shape** — long and narrow, or fat and square? This determines how streets are laid out inside it.
- **Which roads bound it** — this determines access, frontage, and connectivity.

### 3. They're the unit of development

Growth happens zone by zone. Each tick, the pipeline:
1. Scores zones by value → picks the best unbuilt zones
2. Assigns a use type (residential, industrial, civic, etc.)
3. Lays out streets and plots inside the zone
4. Buildings fill the plots

The zone is where the pipeline transitions from "big picture" (which areas develop?) to "small picture" (where exactly do streets and buildings go?).

## How a Zone Relates to the Real World

In a real city:
- A **city block** (the area bounded by streets) is a zone
- A **neighbourhood** is a group of zones with similar character
- A **district** (industrial quarter, shopping street, residential area) is zones with the same use type
- The **street pattern** is the negative space between zones — the boundaries

The generator's zones aren't perfectly rectangular blocks like Manhattan — they're irregular shapes that follow terrain, water, and the organic road network. This is realistic: most real cities have irregular blocks shaped by geography.

## How Zones are Created

### Step 1: Roads and boundaries create the frame

The skeleton road network (arterials between nuclei), river polylines, and the map boundary create a frame of edges in the planar graph. Any closed loop of edges encloses a potential zone.

### Step 2: Graph face extraction finds enclosed areas

`PlanarGraph.facesWithEdges()` identifies every enclosed polygon in the graph. Each polygon is a potential zone.

### Step 3: Filtering removes unsuitable areas

Not every enclosed area is a good zone. Filtering removes:
- Areas that are mostly water
- Areas with low land value (unbuildable terrain)
- Very small areas (< 500m², too small for anything useful)
- The "outer face" (the area outside the map boundary)

### Step 4: Rasterisation populates cells

Each zone polygon is rasterised onto the grid — the cells inside the polygon that pass terrain suitability checks become the zone's cell set. These cells are what gets built on.

### Step 5: Zone-boundary roads subdivide

Large initial zones get split by secondary roads along their boundaries. The pipeline then re-extracts zones, producing more, smaller zones — closer to real city block sizes.

### Step 6: Metadata computation

Each zone gets computed metadata: average slope, slope direction, centroid, land value, priority, which nucleus it belongs to. This metadata drives everything downstream — street orientation, development order, use type assignment.

## What a Zone Object Contains

```
Zone {
  cells            — grid cells inside this zone [{gx, gz}, ...]
  centroidGx/Gz    — center of mass in grid coordinates
  polygon          — boundary polygon in world coordinates [{x, z}, ...]
  boundingEdgeIds  — which graph edges form the boundary (roads, rivers, etc.)
  boundingNodeIds  — graph nodes at the corners
  avgSlope         — average terrain slope (0 = flat, 0.3 = steep)
  slopeDir         — dominant slope direction {x, z}
  avgLandValue     — average land value score (0-1)
  nucleusIdx       — which growth nucleus this zone belongs to
  priority         — development priority (higher = develops earlier)
}
```

## What Happens Inside a Zone

Once a zone is assigned a use type, it gets filled:

- **Residential** → Ribbon streets laid out following the zone's slope direction. Parallel streets with cross connections. Houses on both sides of each street.
- **Commercial** → Frontage allocation along the zone's bounding roads. Shops face the road, one plot deep.
- **Industrial** → Large plots filling the zone. Loading access to roads.
- **Civic** → Specific building types (church, school, park) placed at the best location within the zone.
- **Open space** → Left as parkland, possibly with paths.

See [land-allocation-model](land-allocation-model) for detailed allocation strategies per type.

## Current State

### Unified extraction
Zone extraction uses flood-fill to find buildable cell regions, traces their boundary polygons, then matches each boundary to graph edges via `matchBoundaryToGraphEdges`. Graph-face extraction was removed — flood-fill is more robust and gives the same result via boundary matching.

### Boundary types partially implemented
Roads, rivers, and the map boundary are graph edges. Railways and planning lines are not yet. See [world-state-invariants](world-state-invariants) for the migration status.

### Bidirectional references implemented
`buildEdgeLookups` builds `map.edgeZones` (which zones are on each side of an edge) and `map.edgeParcels` (which parcels front onto an edge). O(1) lookups via `RoadNetwork.zonesAlongRoad()` and `parcelsAlongRoad()`.

### Inset polygons implemented
`computeInsetPolygons` shrinks each zone polygon inward from road edges (half-width + sidewalk), water edges (bank buffer), and map edges (margin). Stored as `zone.insetPolygon`.

### Parcels and plots
Zones are subdivided into parcels (contiguous reservation regions with edge classification) and plots (individual building lots along ribbon streets). See [[spatial-concepts]] for the hierarchy.

### Remaining limitations
- Plot-to-plot collision detection not yet implemented
- Building placement not yet fully wired through the plot system
- Commercial and civic plots not yet created by `subdividePlots` (only residential ribbon plots)

## Related

- [city-generation-pipeline](city-generation-pipeline) — where zones fit in the step sequence
- [pipeline-step-postconditions](pipeline-step-postconditions) — what should be true about zones at each step
- [zone-based-allocation](zone-based-allocation) — using zones as the unit of land assignment
- [land-allocation-model](land-allocation-model) — how different use types fill zones
- [world-state-invariants](world-state-invariants) — zone-related world rules
- `specs/v5/land-model.md` — the target model for zones as graph-face blocks
- `specs/v5/land-first-development.md` — the original design for zone-driven development
