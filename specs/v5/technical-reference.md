# V5 Technical Reference

Proven constants, formulas, algorithms, and data structures from v4. These are the learnings to carry forward — the specific numbers and approaches that took iteration to get right.

## River Geometry

### Width from accumulation
```
halfWidth = clamp(sqrt(accumulation) / 8, 1.5, 25)  // world units
```

### Max channel depth from width
```
maxDepth = min(4, 1.5 + halfWidth / 15)  // world units
```

### Cross-section profile (normalized distance → depth fraction)
```
nd < 0.6  → 1.0                              (full depth, flat bed)
nd 0.6-1.0 → 1.0 - (nd-0.6)/0.4 * 0.7       (bank slope)
nd 1.0-1.5 → 0.3 * (1.0 - (nd-1.0)/0.5)     (gentle bank)
nd >= 1.5  → 0                                (dry land)
```
This produces a smooth U-shaped channel that tapers to flat banks. Took several iterations to avoid sharp edges.

### Chaikin corner-cutting
Weights: 0.75/0.25 per iteration. Default 3 iterations for segment tree data, 1-2 for already-smoothed data. Converts staircase grid-cell paths into smooth curves.

### Path painting
Step along polyline at `cellSize * 0.5` intervals. At each step, stamp a circle of `max(halfWidth, cellSize * 0.75)` onto the waterMask. The `max` with `cellSize * 0.75` ensures cells are painted even when river width < cell size (critical at regional 50m resolution).

## Buildability

### Slope scoring
| Slope | Score | Character |
|-------|-------|-----------|
| < 0.05 | 1.0 | Flat |
| < 0.15 | 0.9 | Gentle |
| < 0.3 | 0.7 | Gradeable (San Francisco builds on this) |
| < 0.5 | 0.4 | Difficult |
| < 0.7 | 0.15 | Marginal |
| >= 0.7 | 0 | Unbuildable |

### Edge margin
- < 3 cells from map boundary: unbuildable (hard block)
- 3-8 cells: `score *= edgeDist / 8` (taper)

### Waterfront bonus
```
if 0 < waterDist < 10 cells:
  score = min(1, score + 0.3 * (1 - waterDist / 10))
```
Cells near water are more desirable, not less. This matches real land value patterns.

### River edge gradient
For water cells with river centerline distance data:
```
nd < 0.8  → 0 (deep channel, unbuildable)
nd 0.8-1.0 → 0.15 * ((nd - 0.8) / 0.2)  (marginal, allows pathfinding near banks)
```

### Water distance BFS
4-connected flood from water cells, cutoff at 15 cells. Sufficient for waterfront bonus computation without scanning the whole grid.

## Path Cost

### Core formula
```
cost = baseDist + slope * slopePenalty
```
Then modifiers applied in this order:
1. Occupancy check (scan all 3m cells within 10m city cell)
   - Road/junction → `return baseDist * reuseDiscount` (early return)
   - Plot → `cost *= plotPenalty`
2. Bridge check (bridgeGrid) → `cost *= 8` for water cells under bridges
3. Buildability check
   - b < 0.01 → unbuildableCost (Infinity or finite depending on preset)
   - b < 0.3 → `cost *= 1 + 2 * (1 - b / 0.3)`

### Presets (tuned values)
| Preset | slopePenalty | unbuildableCost | reuseDiscount | plotPenalty | Use |
|--------|-------------|-----------------|---------------|-------------|-----|
| Anchor routes | 10 | Infinity | 0.15 | 5.0 | Regional road merging |
| Growth roads | 10 | Infinity | 0.5 | 5.0 | General expansion |
| Nucleus connections | 5 | 12 | 0.1 | 3.0 | MST structural roads, can cross water |
| Shortcuts | 8 | 20 | **1.0** | 3.0 | New roads (no reuse!) |
| Satellite | 10 | Infinity | 0.15 | 5.0 | Merge onto existing |
| Bridge | 3 | 8 | 0.1 | 5.0 | Bridge-capable connections |

Key insight: **shortcuts need reuseDiscount = 1.0** (no discount), otherwise they just follow existing roads instead of creating new connections.

## Nucleus Placement

### Population weight by tier
```
tier 1: 0.50, tier 2: 0.30, tier 3: 0.10, tier 4: 0.05, tier 5: 0.02
```

### Caps
```
tier ≤ 1: 20 nuclei, tier ≤ 2: 14, tier > 2: 10
```

### Spacing
Minimum 15 grid cells (150m at 10m resolution). Was 8 cells in early versions — too tight, caused overlapping neighborhoods.

### Niche scoring
```
score = 0.5 * buildability + 0.5 * spacingBonus
spacingBonus = min(1, minDistToExisting / 30)
```
Search covers entire buildable map (no radius cap). Early versions searched only 35% of radius — caused central clustering.

### Type classification
Priority order (first match wins):
1. Adjacent to water (within radius) → `waterfront`
2. Road junction (3+ directions within 5 cells) → `market`
3. Elevated + slope > 0.05 (5×5 local window) → `hilltop`
4. Low elevation + flat (relative to 5×5 window) → `valley`
5. On existing road → `roadside`
6. Default → `suburban`

### Plot config by type
| Type | Frontage | Depth | Setback | Cross-street spacing |
|------|----------|-------|---------|---------------------|
| oldTown | 8m | 25m | 2m | 55m |
| waterfront | 10m | 20m | 3m | 65m |
| market | 12m | 30m | 3m | 60m |
| hilltop | 14m | 30m | 4m | 70m |
| valley | 12m | 28m | 3m | 60m |
| roadside | 10m | 25m | 3m | 60m |
| suburban | 16m | 35m | 5m | 80m |

## Nucleus Connectivity

### Importance formula
```
tierWeight(t) = t<=1 ? 1.0 : t<=2 ? 0.7 : t<=3 ? 0.45 : t<=4 ? 0.2 : 0.1
pairWeight = (tierWeight(a) + tierWeight(b)) / 2
lengthWeight = min(1, pathLen / maxLen)
bridgeWeight = isMSTEdge ? 1.0 : 0.0
importance = min(1, 0.4*pairWeight + 0.3*lengthWeight + 0.3*bridgeWeight)
```

### Hierarchy from importance
```
> 0.7 → arterial, > 0.4 → collector, else → local
```

### Edge width
```
width = 6 + importance * 10  // 6-16 world units
```

### MST algorithm
1. Attach each nucleus to nearest road node
2. BFS connectivity discovery, union connected pairs
3. Cluster centroids weighted by tier
4. Kruskal's MST on cluster crossings (cheapest inter-cluster edges first)
5. Pathfind connections with shared cost (0.3× multiplier on previous paths)
6. Safety net: connect remaining components via direct edges

### Shortcut selection
- Min distance: 5 cells
- Detour ratio threshold: 2.0 (if network distance > 2× straight distance, add shortcut)
- 3 passes, each finding next-closest neighbor
- Track attempted pairs to avoid retrying failures

## Terrain Refinement

### Perlin detail
- Octaves: 3, persistence: 0.4, amplitude: **2m** (subtle at city scale)
- Frequency scaling: `0.005` (world coords → noise space)

### Slope recomputation
Central difference: `sqrt((elev[x+1]-elev[x-1])² + (elev[z+1]-elev[z-1])²) / (2*cellSize)`

### Channel carving
Walk river paths at `cellSize * 0.5` steps. At each step, compute distance from centerline for surrounding cells (radius = halfWidth + 3 cells). Apply `channelProfile(nd) * maxDepth` as elevation reduction. Skip if carve < 0.05m.

## Regional Pipeline Order

```
A1. Geology → rockType, erosionResistance, permeability, soilFertility
A2. Terrain → elevation, slope
A4. Coastline → coastlineFeatures
A3. Hydrology → rivers, confluences, riverPaths, waterMask
A6a. Settlements → primaries, proximityGrids
A6b. Farms → farms (fills gap settlements)
A7a. Roads v1 → roads, roadGrid
A6c. Market towns → newTowns on road intersections
A7b. Roads v2 → updated road network
A6d. Settlement growth → tier promotions
A5. Land cover → landCover
```

Key: there's a feedback loop — settlements → roads → market towns → roads → growth. This produces realistic settlement hierarchies.

## PlanarGraph

### Data structure
```
nodes: Map<id, {id, x, z, ...attrs}>
edges: Map<id, {id, from, to, points, width, hierarchy, ...attrs}>
_adjacency: Map<nodeId, [{edgeId, neighborId}]>
```
`edge.points` stores intermediate vertices (excluding endpoints). `edgePolyline(id)` returns `[fromNode, ...points, toNode]`.

### Face extraction (half-edge approach)
1. Create directed half-edges for each undirected edge
2. Sort outgoing half-edges at each node by angle (atan2)
3. For each incoming half-edge, find next in CW order at target
4. Walk loops until returning to start
5. Return faces ≥ 3 nodes

### Key methods
- `splitEdge(edgeId, x, z)` — finds closest point on polyline, creates new node + 2 edges
- `shortestPathLength(a, b)` — Dijkstra with geometric edge lengths
- `faces()` / `facesWithEdges()` — planar face extraction

## A* Pathfinding

- 8-connectivity (cardinal + diagonal)
- Euclidean heuristic (admissible)
- Binary min-heap priority queue
- Path simplification: Douglas-Peucker (epsilon typically 0.5-3.0 cells)
- Path smoothing: Chaikin (2 iterations, converts grid cells to world coords)

## Anchor Route Import

### Shared-grid approach
1. Sort regional roads by hierarchy (arterials first)
2. Pathfind each onto city grid with shared cost: existing road cells = `dist * 0.3`
3. Stamp onto shared roadGrid to seed next pathfinding
4. Merge pipeline: split shared segments at divergence points

### Hierarchy ranking
```
arterial: rank 1, importance 0.9
collector: rank 2, importance 0.6
structural: rank 3, importance 0.45
```

### Fallback
If no regional roads cross city: generate 2 roads from center to random margins. Ensures every city has at least a skeleton.

## Water Classification

### Types
```
0 = land, 1 = sea, 2 = lake, 3 = river
```

### Algorithm
1. Mark all water cells (waterMask > 0 OR elevation < seaLevel)
2. BFS from boundary water cells (4-connected) → mark as sea
3. Paint river paths → mark as river
4. Remaining water → lake

## Water Polygon Extraction (Marching Squares)

1. **Dilate** water grid: fill cells with ≥ 3 water neighbors (prevents diagonal-only connections)
2. **March**: 2×2 cell quads → lookup 16 cases → edge segments
3. **Chain**: link segments by endpoint (key = round to 10× scale for float stability)
4. **Simplify**: Douglas-Peucker (epsilon = cellSize × 0.5)
5. **Smooth**: Chaikin (2 iterations)

Key: dilate-before-trace avoids disconnected contours from diagonal-only water bodies.

## City Context Extraction

### Sampling
- Categorical grids (rockType, landCover): nearest-neighbor
- Binary grids (waterMask): bilinear + threshold (>= 0.5 → 1)
- Continuous grids (elevation, slope, etc.): bilinear interpolation

### Default parameters
- City radius: 30 regional cells
- City cell size: 10m (vs regional 50m)
- Scale ratio: regionalCellSize / cityCellSize = 5
