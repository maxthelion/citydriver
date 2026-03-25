---
title: "Boundaries"
category: "concepts"
tags: [boundaries, zones, planar-graph, roads, rivers, water, map-edge, topology]
summary: "What boundaries are, how they create zones by enclosing faces in the planar graph, and the different boundary types the system supports."
last-modified-by: user
---

## What is a Boundary?

A boundary is **anything that separates one area of land from another**. Roads are the most obvious boundaries, but rivers, coastline, the map edge, and eventually railways and planning lines all play the same fundamental role: they divide land into discrete zones.

The key insight is that boundaries aren't just physical features — they're **edges in the planar graph**. Every line that separates land should be a graph edge. Every enclosed loop of graph edges encloses a face. Every face is a potential [[zones|zone]].

This is what it means to treat boundaries as the universal separator: once everything that separates land is in the graph, zone extraction becomes a graph problem (find all faces) rather than a terrain problem (flood-fill from seeds).

## Why Boundaries Matter

Boundaries are what make zones exist. A zone is not a blob of buildable terrain — it's a **face enclosed by boundary edges** in the planar graph. Without closed boundary loops, there are no enclosed faces and no zones.

This is why adding the map perimeter as graph edges is an explicit pipeline step (`addBoundaryEdges`): even a perfect skeleton road network, if it's a tree-shaped graph with no loops, produces no enclosed faces. The map boundary closes the outer face. Rivers close the faces they run through. Together, they turn the graph into a planar subdivision whose faces are the city's zones.

## Boundary Types

The graph recognises several boundary types. Each has a different effect on the zone it bounds.

### Road boundary

A road in the road network — arterial, collector, or local street. The most common boundary type. Road boundaries create frontage: plots can face the road, commercial development can front it, ribbon streets can run parallel to it.

In the graph, road edges carry `width` and `hierarchy` attributes. These flow through to zone inset calculations: a zone bordered by an arterial road is inset further (road half-width + sidewalk) than one bordered by a narrow local street.

### Water boundary

A river, coastline, or lake edge. Added to the graph as `hierarchy: 'boundary'` with `attrs.type: 'water'`. Water boundaries split zones but provide no road frontage. They do provide amenity: land near water scores a bonus in [[land-value|land value]] computation, and water-adjacent zone edges get a 5m bank buffer in the inset polygon.

River polylines are added to the graph by `addBoundaryEdges` — the same pipeline step that adds the map perimeter. Each segment of a river polyline becomes a graph edge, snapped to existing nodes where possible.

See [[regional-rivers]] for how rivers are generated at the regional level before flowing into the city pipeline.

### Map boundary

The edge of the generated area. Added as four edges forming the perimeter rectangle. Without this, any open-ended road network would produce an infinite outer face rather than a closed one. Map boundary edges carry `attrs.type: 'boundary'` and get a margin inset of one cell size.

Map boundary is a specific technical necessity, not a real urban boundary — in a real city you'd extend the area rather than hitting a hard edge. But for a bounded generation space it's essential.

### Unimplemented boundary types

**Railway** — a rail corridor is a hard barrier: land on either side is disconnected, with no frontage and noise/industrial character. Not yet added to the graph as edges. When implemented, railway boundaries would produce edge conditions similar to water but without the amenity bonus.

**Planning line** — an administrative boundary with no physical form: a zoning district edge, a conservation area boundary, a flood plain limit. These have no visual presence but should govern what can be built on either side. Not yet implemented.

## How Boundaries Create Zones

The relationship between boundaries and zones is direct: boundaries are the edges; zones are the faces they enclose.

```
graph edges (roads + rivers + map perimeter)
  → PlanarGraph.facesWithEdges()
    → each enclosed polygon = potential zone
      → filtering (water, low value, too small, outer face)
        → remaining polygons = development zones
```

Each zone's `boundingEdgeIds` records exactly which graph edges form its boundary. This is the topology reference that makes zones first-class graph objects rather than just labelled cell regions.

Zone extraction uses flood-fill to find buildable cell regions, traces their boundary polygons, then matches each boundary segment to nearby graph edges using `matchBoundaryToGraphEdges`. This gives every zone both a cell set (for grid operations) and `boundingEdgeIds` (for topological references). Graph-face extraction was removed — flood-fill is more robust and achieves the same result via boundary matching.

## How Boundary Type Affects What Faces It

Once a zone is created, its bounding edges determine the character of each side of the zone. This matters for how development fills the zone.

| Boundary type | Inset distance | Frontage? | Character |
|---------------|---------------|-----------|-----------|
| Road | road_width/2 + 2m sidewalk | Yes | House fronts, shop fronts, ribbon street origins |
| Water | 5m bank buffer | No | Gardens, amenity, views |
| Map edge | 1 cell margin | No | Edge condition — not usable frontage |
| Back of another parcel | 0 | No | Blank walls, gardens, fences |

The `computeInsetPolygons` step uses this classification to produce each zone's `insetPolygon` — the actual buildable envelope after road widths and setbacks are removed. Each polygon edge is matched against the zone's bounding graph edges to determine its type, then inset by the appropriate amount.

## The Vision: Boundaries as Universal Separator

The land-model spec (`specs/v5/land-model.md`) envisions every land-separating feature — roads, rivers, railways, planning lines — as a graph edge, so that:

1. Zone extraction is purely topological (find faces)
2. Zones automatically know their bounding features and their types
3. Inset polygons are computed correctly from edge types
4. No flood-fill or boundary-matching workarounds are needed

Currently, roads and the map boundary are in the graph. Rivers are being added. Railways and planning lines are future work. The `addBoundaryEdges` pipeline step is the current implementation of step 1 of this migration.

## Related

- [[zones]] — zones are the faces that boundaries enclose; boundaries are the zone's edges
- [[spatial-concepts]] — the broader spatial hierarchy and the role of boundaries in it
- [[regional-rivers]] — how river polylines are generated and passed into the city pipeline
- [[zone-based-allocation]] — how zone boundaries become natural road locations
- [[land-allocation-model]] — how boundary type shapes development allocation within zones
- [[land-value]] — water boundaries give nearby cells an amenity bonus in land value
