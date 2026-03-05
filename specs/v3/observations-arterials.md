# B4 Arterials — Observations

File: `src/city/generateArterials.js`

## What it does

1. Finds all nodes touching arterial edges ("arterial nodes")
2. Samples the density grid every 10 cells, looking for high-density cells
   (> 0.3) that are far from any arterial node (> 300 world units)
3. Connects up to 4 such "gap centers" to the nearest arterial node via A*
4. Cross-links entry nodes that aren't connected within 4 hops

## Diagnostic data (seed 12345, tier-1 city)

- City grid: 405x405 (4050x4050 world units)
- Graph before arterials: 7 nodes, 7 edges
- Only 3 nodes touch arterial edges (nodes 0, 1, 2)
- 2 waterfront nodes are structural-only (invisible to arterial logic)
- 0 entry nodes (cross-link code is dead)
- 305 out of ~1400 sampled cells qualify as gaps (density > 0.3, dist > 300)
- Max density: 0.997; 34,437 cells above 0.3 threshold (~21% of grid)

## Problems

### 1. Gap threshold is too small relative to city scale

`gapThreshold = cs * 30 = 300` world units, but the city spans 4050 units.
Almost the entire populated area qualifies as underserved. The top-ranked
gaps are only 316-424 units from an existing arterial — effectively right
next to one. The threshold should scale with city size or be based on what
a reasonable arterial spacing looks like (e.g. 500-1000m in a real city).

### 2. Coverage measured against nodes, not edges

Distance is measured to arterial *nodes* (3 in this case), not to the
nearest point on an arterial *edge*. A long arterial edge with endpoints
far apart creates a false "gap" along its middle, even though the road
runs right through that area. This is why new arterials appear to
duplicate/overlay existing roads — they connect to a node when the edge
already passes nearby.

### 3. Cross-link code is dead

The cross-link logic filters for `node.attrs.type === 'entry'`, but the
anchor route rewrite creates nodes with type `'inherited'`. Zero entry
nodes are found, so the entire cross-link section does nothing.

### 4. Structural roads are invisible

The gap-fill only considers `hierarchy === 'arterial'` edges. Waterfront
structural roads are ignored, so new arterials won't extend from or connect
to the waterfront network. In a coastal city, the waterfront road is a
major route that arterials should branch from.

### 5. Max 4 gaps is too conservative

For a tier-1 city (50k population, 4050 unit span), 4 new arterials feels
far too few. The arterial phase should be creating the major road framework
that collectors and local streets will later subdivide. Real cities of this
size would have 8-15 major arterials forming a coarse grid or radial pattern.

### 6. No directional awareness

All gap-fills connect to the *nearest* arterial node, which may be the same
node for multiple gaps. This produces short, overlapping routes clustering
around one node rather than extending the network outward. Arterials should
aim to create new connections between different parts of the network, not
just spurs to the closest point.

### 7. No consideration of city shape or population target

The algorithm doesn't use `targetPopulation`, city tier, or the overall
shape of the buildable area. A tier-1 city should have a denser arterial
grid than a tier-3 village. The arterial network should roughly define
the extent and structure of the eventual built area.
