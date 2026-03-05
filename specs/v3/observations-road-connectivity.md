# Observations: Road Connectivity

## Current Problems

The K-nearest-neighbor approach with per-tier distance limits leaves gaps:

1. **Isolated settlements** — A hamlet in a remote valley may have no neighbors within its `maxDistForTier` (30 cells), so it gets zero connections.
2. **Disconnected components** — The network can fragment into clusters with no path between them, e.g. a mountain range splits the map into two halves.
3. **No global guarantee** — Two tier-1 cities on opposite sides of the map may not be connected if intermediate settlements are sparse.
4. **Tier 5 farms excluded** — Currently `tier <= 4` is the routing cutoff. Farms should still be reachable via tiny tracks/lanes.

## Proposed: Component-Aware Expanding-Radius Connectivity

### Phase 1 — Nearest Neighbor Guarantee

Every settlement (including tier 5 farms) connects to its single nearest routable neighbor. This ensures zero isolates. Farms connect via a new `track` hierarchy — single-lane unpaved roads.

### Phase 2 — Local Neighborhood

Connect all pairs within a proximity radius (~15 cells). Plus K-nearest per tier. This builds dense local clusters.

### Phase 3 — Cluster Identification

After phases 1-2, identify connected components using Union-Find. Each component is a **cluster**. Clusters can be characterized by:

- Number of settlements
- Highest tier present
- Geographic centroid
- Total population/importance weight

### Phase 4 — Inter-Cluster Bridging

Clusters should be treated as a whole when deciding connections to other clusters. The logic:

1. Sort all cluster pairs by distance between their nearest members.
2. Walk through in order — if two clusters are in different components, find the **best crossing point** between them and connect.
3. This is Kruskal's algorithm on clusters — it produces a minimum spanning tree.
4. The "attraction" between two clusters scales with their combined importance (number of settlements, highest tiers present). Larger/more important clusters should reach further to connect.

#### Finding the Best Crossing Point

When connecting two clusters separated by difficult terrain (e.g. a mountain range), don't just connect the two nearest settlements. Instead:

- Identify candidate pairs: settlements on the facing edges of each cluster.
- For each candidate pair, estimate path difficulty (could use a quick heuristic: straight-line elevation profile, max elevation along the line, total elevation change).
- Pick the pair that exploits natural features — **mountain passes**, river valleys, coastal routes.
- The A* pathfinding will then find the detailed route, but choosing good endpoints is half the battle.

This means the algorithm actively seeks out passes. Two clusters on either side of a ridge will route through the lowest saddle point between them, even if that's not the shortest straight-line distance.

#### Cluster Size Thresholds

- A cluster of 1-2 settlements connects to its nearest neighbor cluster only.
- A cluster of 3-5 settlements tries to connect to 2 neighboring clusters.
- A cluster of 6+ settlements (or containing a tier 1-2 city) tries to connect to 3+ clusters, reaching further.

This means large population centers become natural hubs with multiple approach routes, while small hamlets get a single lifeline road.

### Phase 5 — Backbone Verification

After bridging, verify that all tier 1-2 cities are in a single connected component. If not (e.g. a failed A* path), attempt progressively more expensive connections:

1. Try alternative endpoint pairs between the disconnected clusters.
2. Increase A* search limits.
3. Consider tunnel/cutting (see below).

### Phase 6 — Tier 5 Farm Tracks

Farms (tier 5) connect to their nearest settlement via `track` hierarchy — the lowest road class. These are:

- Single-lane, unpaved
- Follow field boundaries and contours
- Very short (farms are placed near existing settlements)
- Rendered as thin dotted lines or faint paths
- At city scale, these become dirt tracks between fields

## Tunnels and Cuttings

When the attraction between two clusters is large enough but terrain makes surface routes extremely costly, consider infrastructure:

- **Tunnel**: If the best surface path between two important clusters has a cost exceeding N times the straight-line distance cost, and both clusters contain tier 1-2 settlements, mark the route as requiring a tunnel through the worst section.
- **Cutting/viaduct**: A lighter version — the road is forced through steep terrain at high construction cost but avoids a full tunnel.

Tunnel indicators:
- Both clusters have high importance (combined tier-1/tier-2 count >= 2).
- Surface path cost > 3x the flat-terrain equivalent distance.
- The difficult section is relatively short (< 20% of total path length) — a focused obstacle, not generally terrible terrain.

Tunnels would be stored as metadata on the road: `{ tunnel: true, tunnelStart: {gx, gz}, tunnelEnd: {gx, gz} }`. At city scale, these become rendered as tunnel portals with a straight segment through the mountain.

This is a stretch goal — the core algorithm works without tunnels, but they would explain how real infrastructure connects communities separated by mountain ranges.

## Hierarchy Assignment

Road hierarchy emerges from context rather than just endpoint tiers:

| Connection type | Hierarchy |
|---|---|
| Between tier 1-2 settlements, or bridging large clusters | `arterial` |
| Between tier 3 settlements, or bridging medium clusters | `collector` |
| Between tier 4 settlements, or local connections | `local` |
| Tier 5 farm connections | `track` |

Inter-cluster bridges default to at least `collector` regardless of endpoint tiers, since they serve a strategic connectivity role.

## Transitive Connectivity

Key insight: if A connects to B and B connects to C, then A can reach C. We never need a direct A-C road — we only need to **bridge disconnected components**. This means:

- The number of bridging roads is at most (number of components - 1).
- Most work is done by phases 1-2 (local connections).
- Phase 4 only adds the missing long-distance links — typically just a handful of roads.

## Processing Order and Road Sharing

The order roads are pathfound matters because of the road-sharing grid (0.3x cost on cells with existing roads):

1. **Short arterials** between nearby cities lay down first.
2. **Long arterials** bridging distant cities merge into existing short arterials.
3. **Collectors** from villages tap into the arterial network.
4. **Local roads** from hamlets connect to the nearest anything.
5. **Tracks** from farms reach the local road network.

This creates organic trunk routes without explicit planning — later roads naturally gravitate toward earlier ones, producing the merging/branching pattern seen in real road networks.

## Performance Considerations

- ~150 settlements: all-pairs is ~11,000 pairs. Sorting and Union-Find is instant.
- The expensive part is A* pathfinding per connection. Current approach already does this.
- Cluster-level reasoning reduces the number of long-distance A* searches (bridge clusters, not every pair).
- Mountain pass detection could use a cheap elevation-profile heuristic before committing to full A*.
