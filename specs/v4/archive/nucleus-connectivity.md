# Nucleus Connectivity: Union-Find MST Pattern

## The Problem

City nuclei (growth centers) need roads connecting them before the growth loop begins. Currently this is handled by two ad-hoc functions:

- **`connectSatellites()`** — iterates nuclei, pathfinds each disconnected one to nearest road node, always creates `collector` hierarchy, runs before growth
- **`connectNeighborhoodClusters()`** — iterates all pairs, checks BFS reachability, connects up to 3 pairs, always `collector`, runs after growth

Problems:
1. No connectivity guarantee — nuclei can remain isolated if pathfinding fails or distance limits exclude them
2. Hard-coded `collector` hierarchy regardless of nucleus importance
3. Pair iteration is O(n²) with an arbitrary cap of 3 connections
4. No terrain-aware endpoint selection — just nearest road node
5. Runs at two separate points in the pipeline with different logic
6. Bridge-capable connections only in the post-growth pass

## The Pattern

The regional road network (`specs/v3/plan-road-connectivity.md`) solved the same problem for settlements using a 6-phase Union-Find algorithm. Apply the same pattern to city nuclei:

1. Guarantee every nucleus is reachable
2. Use Kruskal's MST to bridge disconnected clusters with minimum cost
3. Add redundant connections for important clusters
4. Derive road hierarchy from the connection, not from a hard-coded string

## Road Hierarchy: Derived, Not Named

Instead of assigning `'arterial'` / `'collector'` / `'local'` as string labels, derive a numeric **importance score** from context. The score determines road width, rendering, and pathfinding weight. This removes the need to decide "what type of road is this" at creation time.

### Importance score

Each road edge gets an importance value in [0, 1]:

```
importance = clamp01(
    pairWeight * 0.4          // who does this road connect?
  + pathLength * 0.3          // how far apart are the endpoints?
  + clusterBridging * 0.3     // does this road bridge disconnected clusters?
)
```

Where:
- **pairWeight** = `(nucleusA.tier + nucleusB.tier) / 2`, normalized so tier 1-1 = 1.0, tier 4-4 = 0.1
- **pathLength** = `min(1, actualLength / maxExpectedLength)` — longer roads are more important (they serve a structural role)
- **clusterBridging** = 1.0 if this edge bridges two previously disconnected clusters (MST edge), 0.5 if it's a redundant cross-link, 0.0 if it connects within an already-connected cluster

### Derived properties

From importance, everything else follows deterministically:

| Importance | Width | Rendering | Cost discount | Legacy label |
|-----------|-------|-----------|---------------|-------------|
| > 0.7 | 14-16m | Thick white | 0.15x reuse | arterial |
| 0.4 - 0.7 | 10-12m | Medium yellow | 0.3x reuse | collector |
| < 0.4 | 6-8m | Thin grey | 0.5x reuse | local |

The legacy labels exist only for backward compatibility with renderers and validators that check string hierarchy. Internally, importance is the single source of truth.

```js
function edgeWidth(importance) {
  return 6 + importance * 10;  // 6m at 0.0, 16m at 1.0
}

function edgeHierarchy(importance) {
  if (importance > 0.7) return 'arterial';
  if (importance > 0.4) return 'collector';
  return 'local';
}
```

### Anchor routes

Anchor routes (from regional roads re-pathfound at city resolution) already have regional hierarchy. Convert to importance:

| Regional hierarchy | Importance |
|-------------------|-----------|
| arterial | 0.9 |
| collector | 0.6 |
| structural | 0.5 |
| local | 0.3 |
| track | 0.15 |

### Growth roads

Roads added during the growth loop get importance from their spawning context:

- Cross-streets from an arterial edge: importance = parent importance × 0.5
- Cross-streets from a collector: importance = parent importance × 0.6
- Dead-end extensions: importance = 0.2
- Block-closing connections: importance = 0.3

This creates a natural hierarchy decay: arterials spawn collectors, collectors spawn locals.

## Algorithm: `connectNuclei()`

Single function replacing both `connectSatellites` and `connectNeighborhoodClusters`. Runs once, before the growth loop, after anchor routes and buildability are computed.

### Input

- `nuclei[]` — array of nucleus objects with `{id, gx, gz, x, z, tier}`
- `graph` — PlanarGraph (already has anchor route edges)
- `cityLayers` — for buildability, pathCost
- `occupancy` — for stamping new edges

### Phase 1: Nearest road attachment

For each nucleus, find its nearest road node in the existing graph (anchor routes). If within 3×cellSize, mark as attached. Otherwise, pathfind to it and create an edge.

This is the same as current `connectSatellites` but for ALL nuclei, not just disconnected ones.

```
for each nucleus:
  nearest = graph.nearestNode(nucleus.x, nucleus.z)
  if nearest.dist < cs * 3:
    nucleus.roadNodeId = nearest.id
  else:
    pathfind nucleus → nearest road node
    create edge, stamp occupancy
    nucleus.roadNodeId = new node id
```

After this phase, every nucleus has a `roadNodeId` — a node in the road graph.

### Phase 2: Build nucleus connectivity graph

Using the road graph, check which nuclei can reach each other via existing roads. Use BFS with a hop limit proportional to straight-line distance.

Initialize Union-Find with n = nuclei.length. For each pair (i, j): if BFS from nucleus[i].roadNodeId reaches nucleus[j].roadNodeId within `ceil(dist / (cs * 2))` hops, union(i, j).

### Phase 3: Cluster identification

From Union-Find, extract connected components. Each cluster:

```js
{
  root,                    // Union-Find root index
  members: [nucleusIdx],   // indices into nuclei array
  importance: sum of tier weights,
  centroid: { x, z },
}
```

If only one component → skip to phase 5.

### Phase 4: Inter-cluster MST bridging

For each pair of clusters, find the best crossing:
- For each nucleus in cluster A and each nucleus in cluster B, compute `estimateCrossingCost(a, b)` using the buildability grid:
  - Sample buildability along the straight line between a and b
  - Cost = euclidean distance × (1 + unbuildable_fraction × 5 + low_buildability_fraction × 2)
  - This favours routes through buildable corridors and penalizes water/cliff crossings

Sort all cluster pairs by their best crossing cost. Kruskal's: walk through in order, if two clusters are in different components, pathfind between the best pair and create the edge. Union the clusters.

**Road importance** for MST edges: clusterBridging = 1.0. PairWeight from the two nuclei tiers. These are the structurally critical roads.

**Redundant bridges**: after MST pass, clusters with importance ≥ 3.0 (roughly: contains a tier 1-2 nucleus) get one additional cross-link to a different cluster. This provides route redundancy for important areas.

### Phase 5: Stamp and record

All new edges get:
- Stamped onto occupancy grid
- importance score computed and stored as `edge.importance`
- `edge.hierarchy` derived from importance (for backward compat)
- `edge.width` derived from importance

### Pathfinding preset

Nucleus connections use a dedicated pathCost preset:

```js
export function nucleusConnectionCost(cityLayers) {
  return createPathCost(cityLayers, {
    slopePenalty: 5,          // less slope-averse than growth (these are structural)
    unbuildableCost: 12,      // expensive but not impassable (bridges possible)
    reuseDiscount: 0.1,       // strongly prefer existing roads
    plotPenalty: 3.0,
  });
}
```

The low `unbuildableCost` (finite, not Infinity) means connections can cross water at high cost — producing bridge-worthy routes — without a separate "bridge mode".

## What This Replaces

| Current | New |
|---------|-----|
| `connectSatellites()` — pre-growth, nearest road, collector | Phase 1: nearest road attachment |
| `connectNeighborhoodClusters()` — post-growth, pair iteration, 3-cap, BFS reachability | Phases 2-4: Union-Find + MST, no arbitrary cap |
| Hard-coded `hierarchy: 'collector'` on all connections | `importance` score → derived hierarchy |
| Two separate connection passes (pre + post growth) | Single pass before growth |
| No connectivity guarantee | MST guarantees all clusters connected |
| Bridge-capable only in post-growth | Single cost function with finite unbuildableCost |

## File Changes

| Action | File | Change |
|--------|------|--------|
| Create | `src/city/connectNuclei.js` | New function implementing phases 1-5 |
| Modify | `src/city/pathCost.js` | Add `nucleusConnectionCost` preset |
| Modify | `src/city/growCity.js` | Remove `connectSatellites`, `connectNeighborhoodClusters`, `bfsReachable`. Call `connectNuclei` instead. |
| Modify | `src/city/pipeline.js` | Call `connectNuclei` after anchor routes + buildability, before growth |
| Modify | `src/city/pipelineDebug.js` | Same |
| Modify | `src/city/interactivePipeline.js` | Same |

## Visualization

The connections debug layer (`layerRenderers.js`) currently draws dashed lines from nuclei to nearest road nodes. Update to show:
- MST edges as solid lines (structural connections)
- Redundant bridges as dashed lines
- Line thickness proportional to importance
- Color from importance (white → yellow → grey)

## Future: Importance Propagation

Once growth roads exist, importance could propagate through the graph via betweenness centrality or traffic simulation. Roads that carry many shortest-paths between nuclei would gain importance. This is a post-growth pass, not part of the initial connection phase.
