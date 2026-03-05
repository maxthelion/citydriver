# Observations: Road Merging and the Network Problem

## The Current Situation

Regional roads are imported into the city as independent edges in a planar
graph. Each road is pathfound separately through the city grid, connecting
its regional entry/exit points. The result is a collection of polylines
that happen to overlap spatially but have no structural relationship.

When two roads follow the same terrain corridor, they produce nearly
identical A* paths — but they're stored as separate graph edges. We've
tried to fix this with:
- roadGrid discounting (0.3x cost for reusing existing cells)
- Node snapping (merge nodes within 30m)
- Duplicate edge detection (skip if same node pair)
- Parallel edge detection (skip if similar angle + nearby midpoint)

None of these work properly because they treat the symptom, not the cause.
The cause is that **roads are imported as point-to-point connections, but
real roads are a shared network**.

## How Roads Actually Work

Consider five regional roads entering a city. They don't create five
independent routes — they create a network where segments are shared.

### Scenario 1: Roads never meet
Two roads cross the city in completely different areas. They don't
interact at all. No problem — two separate edges is correct.

### Scenario 2: Roads meet temporarily
Two roads coming from different directions converge for a stretch (like
a bypass around a hill), then diverge again. In reality, this stretch
is one road with increased traffic, not two roads on top of each other.

### Scenario 3: Different origins, same destination
Two roads enter the city from different edges but both head to the center.
At some point they merge into one road for the final approach. Before the
merge: two separate roads. After: one shared road.

### Scenario 4: Same destination, different approaches
Two roads both reach the city center but from opposite directions.
They never share any path. They meet at a junction (crossroads) and
continue past each other. This is the simplest case — just an intersection.

### Scenario 5: Different origins and destinations, shared middle
The most complex and most common case. Road A goes north-to-south,
Road B goes northwest-to-east. They share a segment through the city
center. The shared segment is one road, with branches splitting off
at each end.

## The Key Insight

When two A* paths pass through the same grid cell, **that cell is a
junction**. If they continue through the same sequence of cells, that
sequence is a **shared segment**. The result isn't two overlapping edges —
it's a network with merge points, shared segments, and split points.

```
Before (current):
  A =========================> A'
  B =========================> B'
  (two separate edges that happen to overlap in the middle)

After (correct):
  A ====> M ======> S ====> A'
          ^                \
  B ======/                 \=> B'
  (network with merge point M, split point S, shared segment M-S)
```

## What This Means for Implementation

### Step 1: Pathfind all regional roads onto a shared grid
Instead of creating graph edges immediately, first pathfind all regional
roads and record which grid cells each road uses. This gives us a set of
paths on a shared grid.

### Step 2: Identify shared segments
Where two or more paths share consecutive grid cells, they share a road
segment. Walk along each path and detect where it enters and exits a
shared region. These entry/exit points are junctions.

### Step 3: Build the graph from segments
Each unique segment (whether used by one road or many) becomes one graph
edge. Each junction (where roads merge, split, or cross) becomes a graph
node. The result is a minimal planar graph with no overlapping edges.

### Step 4: Assign hierarchy
A shared segment used by two arterials is still an arterial. A segment
used by an arterial and a collector is an arterial (highest wins). The
width comes from the hierarchy.

## Benefits

- **No overlapping roads**: physically impossible by construction
- **Natural junctions**: emerge from where paths actually cross
- **Correct road widths**: shared segments aren't rendered as double-width
- **Simpler graph**: fewer edges, no redundancy
- **Foundation for plot generation**: plots see a clean road network

## Complexity Considerations

The shared-grid approach requires keeping the raw A* paths in grid
coordinates before converting to world coordinates. The segment detection
is essentially a sweep along each path checking a "road usage" grid. This
is O(total_path_length) which is cheap.

The tricky part is handling near-misses: two paths that follow adjacent
grid cells (1 cell apart) rather than the exact same cells. These should
probably be merged too, using a small tolerance (e.g., paths within 2
cells of each other count as shared).

## Relationship to the Broader Pipeline

This change affects only the anchor route import step (C3). Everything
downstream — neighborhoods, density, institutional plots, frontage plots
— benefits from a cleaner road graph but doesn't need to change.

The key principle: **the road graph should represent the physical road
network, not the logical routes that use it**. A route is "road from
settlement A to settlement B". A road network is "these segments exist
on the ground, and routes are paths through them".
