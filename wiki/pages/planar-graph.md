---
title: "Planar Graph"
category: "architecture"
tags: [graph, topology, roads, zones, faces, planar, boundaries, architecture]
summary: "The road network's topological representation — nodes at intersections, edges along roads and boundaries, faces as zones. How the graph enables face extraction and grows as roads are added."
last-modified-by: user
---

## What is the Planar Graph?

The planar graph is the **topological representation of the road network** — and, more broadly, of all boundaries that separate land into [[zones]]. It stores:

- **Nodes** at intersections, road endpoints, and boundary corners
- **Edges** between nodes, representing roads, rivers, and map boundaries
- **Faces** — the closed polygons enclosed by those edges, which become zones

The graph is "planar" in the mathematical sense: it can be drawn on a flat surface without edges crossing (except at nodes). This planarity property is what enables face extraction — if edges only cross at nodes, the graph's enclosed areas are well-defined polygons.

The `PlanarGraph` class lives at `src/core/PlanarGraph.js`. The `RoadNetwork` wraps it alongside the rasterised `roadGrid`, keeping graph topology and bitmap representation in sync.

## Nodes

A node is a point at which edges meet:
- Road intersections
- Road endpoints (dead ends, T-junctions)
- Points where roads meet rivers or map boundaries
- Map boundary corners

```
Node {
  id    — unique integer
  x, z  — world coordinates
  attrs — optional metadata (e.g. junction type)
}
```

Nodes are added via `addNode(x, z, attrs)`. The graph maintains an adjacency map from each node to the edges incident on it.

## Edges

An edge connects two nodes and represents a linear boundary:

```
Edge {
  id        — unique integer
  from, to  — node IDs (endpoints)
  points    — intermediate polyline points [{x, z}, ...]
  width     — physical width in world units (metres)
  hierarchy — 'arterial' | 'collector' | 'local' | 'boundary'
  attrs     — optional metadata (e.g. type: 'water')
}
```

An edge is not a straight line between two nodes — it can be a **polyline** with intermediate points. This lets roads follow curves and terrain contours while maintaining a simple graph topology. `edgePolyline(edgeId)` returns the full sequence of points including both endpoints.

### Edge types by boundary origin

Edges represent different boundary types depending on what created them:

| Edge type | `hierarchy` | `attrs.type` | What it represents |
|-----------|-------------|-------------|-------------------|
| Road | `arterial`, `collector`, or `local` | — | A road in the road network |
| River | `boundary` | `water` | A river polyline from the map data |
| Map edge | `boundary` | `boundary` | The perimeter rectangle of the map area |

Critically, **all three types are graph edges**. A river is as much a boundary as a road — it divides land into zones just as effectively. Adding rivers and the map perimeter to the graph lets `facesWithEdges()` find closed faces even in areas where roads alone don't form complete loops.

This is the purpose of the `addBoundaryEdges` pipeline step: before face extraction, it adds the map perimeter (4 nodes, 4 edges forming a rectangle) and all river polylines as graph edges with `hierarchy: 'boundary'`.

## Face Extraction: How Zones Emerge

The key capability of the planar graph is **face extraction** — finding every enclosed polygon formed by the edges.

`facesWithEdges()` implements a standard DCEL (Doubly Connected Edge List) algorithm:

1. Each undirected edge becomes two **half-edges**: one pointing forward (from → to), one backward (to → from)
2. At each node, outgoing half-edges are sorted by angle
3. For half-edge (u → v), the "next" half-edge in the face is found by: go to v, find the twin half-edge (v → u), take its predecessor in angular order at v
4. Following the `next` chain from any half-edge traces a closed loop — a face

This is the left-turn rule for planar graphs: always turn as left as possible at each junction. Walking the graph this way traces the smallest enclosed polygon on the left side of each directed edge.

The result is an array of `{ nodeIds, edgeIds }` objects — each is a closed polygon defined by the sequence of nodes on its boundary and the edges connecting them.

### The outer face

The algorithm produces one face per enclosed region, plus one "outer face" — the unbounded region outside the map boundary. The outer face is the largest polygon in the result set and must be filtered out before treating faces as zones. In practice it's identified by being larger than the map area or by winding in the wrong direction (clockwise vs counterclockwise).

### Why boundary edges are required

Without map boundary and river edges, the skeleton road network is typically a **tree** (arterials connect nuclei but don't form loops). A tree has no enclosed faces — `facesWithEdges()` would return nothing.

Adding the map perimeter closes the tree into a planar graph with faces. Each peninsula of road that branches off from the skeleton now creates faces between itself and the map boundary. Rivers add further subdivisions.

```
Before boundary edges: skeleton is a tree → no faces
After addBoundaryEdges: faces appear between roads, rivers, and map edge → zones
```

## How the Graph Grows with Roads

The planar graph is rebuilt or extended at several points in the pipeline:

### 1. Skeleton roads (early pipeline)

`buildSkeletonGraph()` / `rebuildGraphFromRoads()` creates the initial graph from arterial roads connecting city nuclei. At this point the graph is typically a tree.

### 2. Boundary edges added

The `addBoundaryEdges` pipeline step adds map perimeter and river edges. This is what enables face extraction — without it, no zones can be found.

### 3. Zone-boundary roads (secondary network)

When large initial zones are subdivided, new roads are laid along zone boundaries. Each new road is added to the graph as an edge (with nodes at its endpoints, snapped to nearby existing nodes). Adding a road through an existing face splits it into two faces — the two new zones on either side.

### 4. Ribbon streets (tertiary network)

Residential ribbon streets are added to the graph when residential parcels are filled. Each new street adds more edges and further subdivides faces.

### Adding a road splits faces

The fundamental dynamic is: **adding an edge through a face splits it into two**. Every road laid creates two smaller zones where one larger zone existed. This is why the pipeline runs `extractZones` multiple times — after each round of road addition, new smaller zones appear that can be developed independently.

## Splitting Edges

When a new road meets an existing road at a point that isn't already a node, the existing road's edge must be split. `splitEdge(edgeId, x, z)` handles this:

1. Creates a new node at (x, z)
2. Splits the edge's polyline at the nearest point to (x, z)
3. Removes the original edge
4. Adds two new edges: original-from → new-node, and new-node → original-to

All intermediate polyline points are distributed between the two halves. The new node is now a proper junction that new roads can connect to.

## Merging Nearby Nodes

`compact(snapDist)` merges nodes that are closer than `snapDist` to each other, then removes duplicate edges between the same pair of nodes. This is necessary because:

- Roads from different sources may have endpoints that nearly (but not exactly) coincide
- Graph face extraction requires a proper planar embedding — T-intersections must be actual nodes, not edges that cross without connecting

The `compact` step is run after building the skeleton to ensure the graph is clean before face extraction begins.

## Graph Topology vs Road Geometry

The planar graph is **topology-first** — it records connectivity, not visual appearance. The node positions and edge polylines give you geometry, but the graph's job is to answer topological questions:

- Which nodes are connected? (`neighbors(nodeId)`)
- What are the edges at this intersection? (`incidentEdges(nodeId)`)
- What closed polygons does this network form? (`facesWithEdges()`)

The `RoadNetwork` class keeps the graph in sync with the canonical road collection and the rasterised `roadGrid`. All road mutations (add, remove, update polyline) go through `RoadNetwork`, which keeps all three representations consistent.

## Relationship to Zones

Zones are created by flood-filling buildable cells, then tracing the boundary polygon and matching it to graph edges via `matchBoundaryToGraphEdges`. This gives each zone:

- `boundingEdgeIds` — the graph edges that form its boundary
- `boundingNodeIds` — the graph nodes at its corners
- A boundary polygon in world coordinates traced from the cell blob

The graph also stores reverse lookups via `buildEdgeLookups`: each edge knows which zones are on its left and right side (`map.edgeZones`), and which parcels front onto it (`map.edgeParcels`).

When a new road is added through a zone, re-running zone extraction produces two smaller zones where one existed — the road acts as a new barrier in the flood-fill.

See [[polygons-vs-cells]] for the architectural principle that zones (and roads) should be polygon-first, with cell grids as derived rasterisations.

## Current Limitations

### River edges not yet systematically snapped to road nodes

Rivers are added to the graph as separate edges. Their endpoints may not be precisely snapped to nearby road intersection nodes, which can leave small gaps that confuse face extraction. The `snapDist` in `addRiverEdges` mitigates this but doesn't eliminate it.

### Railways not yet in the graph

Railway corridors are hard barriers but aren't graph edges. When implemented, they would split zones like rivers do, but with different edge character (noise, no amenity, no frontage).

### Planning lines not yet supported

Administrative boundaries with no physical form aren't representable as graph edges yet. The land-model spec envisions these as boundary type `PlanningLine`.

## Related

- [[zones]] — zones are the faces of the planar graph
- [[boundaries]] — everything the graph represents as an edge
- [[road-hierarchy]] — how edge `hierarchy` values distinguish arterial, collector, local, and boundary edges
- [[road-network-invariants]] — geometric and topological rules the graph must satisfy
- [[polygons-vs-cells]] — why polygons (faces) are the source of truth, with cells as derived rasterisations
