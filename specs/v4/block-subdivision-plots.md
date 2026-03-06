# Block Subdivision Plots

## Problem

The current plot placement in `growCity.js` projects rectangles perpendicular to road centerlines at fixed intervals. Plots don't understand the space they're filling — they're stamped on top of the world rather than carved from it. This causes:

- **Plots overlapping roads** — a plot projected from one road can extend into the corridor of an adjacent road
- **Plots overlapping each other** — two roads at an angle both project plots into the same space
- **Wasted space** — rigid rectangular projection leaves irregular gaps between plots and roads
- **No block structure** — there's no concept of the enclosed area between roads as a unit

Real cities work differently. Roads enclose **blocks** — polygonal areas bounded by road edges. Plots are then subdivisions of those blocks. A plot can never overlap a road because it's defined as a piece of the space *between* roads.

## Approach: Extract Blocks, Then Subdivide

### Step 1: Extract blocks from the road graph

The road graph (PlanarGraph) implicitly defines enclosed faces. A face is a minimal cycle of edges that bounds a region. These faces are the city blocks.

Algorithm: **planar face extraction**
- For each directed half-edge, follow the "next edge" by always turning as far left (or right) as possible at each node
- This traces out one face of the planar graph
- The unbounded outer face is discarded
- Each remaining face is a block polygon

The PlanarGraph already stores node positions and edge connectivity, so this is a graph traversal — no geometry intersection needed.

Blocks that are too large (e.g. >10,000 m^2) likely represent unbounded or peripheral areas and should be skipped or treated as parks/open space.

### Step 2: Classify blocks

Each block gets metadata based on its geometry and adjacent roads:
- **Area** — small blocks get fewer, tighter plots; large blocks may be subdivided further
- **Adjacent road hierarchy** — blocks fronting arterials get commercial plots; blocks on local roads get residential
- **Shape regularity** — roughly rectangular blocks subdivide cleanly; irregular blocks need adaptive subdivision
- **Nucleus ownership** — which nucleus's character (oldTown, waterfront, etc.) applies

### Step 3: Subdivide blocks into plots

For each block:

1. **Identify frontage edges** — the block edges that are road edges. These are where plot fronts face.
2. **Inset the block boundary** by the setback distance from each road edge. This creates the buildable area.
3. **Subdivide along frontage** — divide the frontage into plot-width intervals. For each interval, project inward to create a plot rectangle (or trapezoid for irregular blocks).
4. **Handle depth** — if the block is deep (wider than 2x plot depth), create a second row of plots backing onto each other, leaving a service lane or shared boundary in the middle.
5. **Handle corners** — where two frontage edges meet at a block corner, the corner plot gets special treatment (angled, or assigned to whichever road is higher hierarchy).

The key insight: plots are **subtractive** from block area, not additive from road edges. Every square metre of a block is either a plot, a setback margin, or leftover interior space.

### Step 4: Handle interior space

After frontage plots are placed, the block interior may still have unclaimed space:
- **Narrow interior** (<5m) — absorbed into adjacent plots as extended gardens/yards
- **Medium interior** (5-15m) — becomes a shared courtyard or back lane
- **Wide interior** (>15m) — may warrant an interior road (back lane), which then creates sub-blocks that get their own frontage plots

This is where back lanes emerge naturally: they're not projected from parent roads, but created when block interiors are too deep for single-depth plots.

## Integration with Growth Loop

The growth loop currently has: fillFrontage -> checkDepthPressure -> checkBlockPressure -> extendDeadEnds.

With block subdivision, this becomes:

1. **After any road is added**: recompute affected blocks (only the faces adjacent to the new edge)
2. **Subdivide new/changed blocks into plots**
3. **Depth pressure becomes automatic**: if a block is too deep, a back lane is added as part of subdivision, creating new sub-blocks

The growth loop simplifies to: each tick adds roads (from dead-end extension, loop closure, or demand), then block extraction + subdivision produces plots. No separate "fill frontage" pass needed.

## Data Structures

```
Block {
  id: number
  vertices: Array<{x, z}>       // polygon boundary (wound CCW)
  edgeIds: Array<number>         // road graph edges forming the boundary
  frontageEdges: Array<number>   // subset of edgeIds that are road edges
  area: number
  nucleusId: number
  plots: Array<Plot>
}

Plot {
  vertices: Array<{x, z}>       // 4+ vertices
  centroid: {x, z}
  area: number
  frontageEdgeId: number         // which road edge this plot faces
  frontageWidth: number
  depth: number
  blockId: number
  nucleusId: number
}
```

## Planar Face Extraction

The critical algorithm. Given a PlanarGraph:

1. Build a directed edge table: for each undirected edge (u,v), create half-edges (u->v) and (v->u)
2. For each node, sort outgoing half-edges by angle (atan2 of direction from node)
3. For each half-edge that hasn't been assigned to a face:
   a. Start a new face
   b. Follow the half-edge to its target node
   c. At the target node, find the **next** half-edge by picking the one immediately CW (or CCW, depending on convention) from the reverse of the incoming edge
   d. Repeat until returning to the start half-edge
   e. The traced cycle is one face
4. Compute signed area of each face; discard the one with the largest magnitude (outer face)
5. Discard faces with negative area (they wind the wrong way — depends on convention)

This is O(E) where E is the number of edges — each half-edge is visited exactly once.

## Advantages Over Current Approach

- Plots can never overlap roads (they're carved from space between roads)
- Plots can never overlap each other (they subdivide a fixed polygon)
- Back lanes emerge from block geometry rather than being projected from road offsets
- Block shapes naturally adapt to road angles and curves
- Corner lots, triangular blocks, and irregular geometry are handled by the subdivision algorithm rather than being bugs
- The occupancy grid becomes a secondary check rather than the primary collision system

## Risks

- Planar face extraction requires the road graph to be truly planar (no crossing edges). The graph may need cleanup/intersection resolution first.
- Very small faces (triangular slivers from near-parallel roads) need filtering.
- Performance: recomputing all faces after each road addition could be expensive. Incremental face updates would be better but more complex. Start with full recomputation and optimize if needed.
