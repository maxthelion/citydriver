# Plan: Inherit Regional Roads in Anchor Routes

## Problem

B2 (Anchor Routes) currently ignores the actual regional road paths and re-pathfinds everything from scratch at city scale. This creates three problems:

1. **Star topology** — every entry point connects to a central seed via independent A* paths, producing an unrealistic radial layout
2. **Disconnected from regional model** — the regional pipeline already computed good terrain-following roads between settlements, but the city throws them away and invents its own
3. **Aggressive waterfront** — traces the entire coastline as a chain of small edges, rather than placing a focused waterfront road

The spec says anchor routes should be "connections to regional road entry points" and "ancient routes that predate planned development." The regional roads *are* those ancient routes — they should be inherited, not redrawn.

---

## File Changes

### 1. `src/city/extractCityContext.js` — store `regionalCellSize`

**What:** Add `regionalCellSize` to the params object so downstream code doesn't have to reverse-engineer it.

**Change:** One line added to the params object at line 46:

```js
cityLayers.setData('params', {
  width: cityWidth,
  height: cityHeight,
  cellSize: cityCellSize,
  seaLevel,
  originX,
  originZ,
  settlement,
  regionalMinGx: minGx,
  regionalMinGz: minGz,
  regionalCellSize,          // ← add this
});
```

No other changes to this file.

---

### 2. `src/city/generateAnchorRoutes.js` — rewrite

**What:** Replace the current approach (seed → star pathfinding + aggressive waterfront) with regional road inheritance.

**Current structure to remove:**
- `snapToLand()` — no longer needed (regional roads are already on land)
- `findEntryPoints()` — replaced by direct clipping of regional road paths
- `findWaterfrontEndpoints()` — replaced by focused waterfront logic
- `createWaterfrontCostFunction()` — replaced
- `addFallbackWaterfrontPath()` — replaced
- The star-pattern seed→entry pathfinding in `generateAnchorRoutes()`

**New structure:**

```
generateAnchorRoutes(cityLayers, rng)
├── clipRegionalRoads(regionalRoads, params)
│   For each regional road:
│   1. Walk path points, convert from regional grid → city world coords
│      worldX = (p.gx - minGx) * regionalCellSize
│      worldZ = (p.gz - minGz) * regionalCellSize
│   2. Clip to city boundary (keep segment inside [0, cityWidth*cs] × [0, cityHeight*cs])
│   3. Re-pathfind the clipped segment at city resolution for smoother terrain-following
│      Use corridor-guided cost: base terrain cost × bonus for being near regional path
│   4. Return array of { entryPoint, exitPoint, path, hierarchy }
│
├── addInheritedRoads(graph, clippedRoads, cs)
│   For each clipped road:
│   1. Create entry/exit nodes at city boundary with direction metadata
│   2. Add the refined path as edges with intermediate polyline points
│      (single edge with points array, NOT many small edge segments)
│   3. Where two roads share path segments (from regional roadGrid merging),
│      detect proximity and create shared intersection nodes using splitEdge()
│
├── connectSeed(graph, seedX, seedZ, elevation, waterMask, params)
│   1. Place seed node at settlement center
│   2. Find nearest inherited road node or edge
│   3. If nearest is an edge, split it with splitEdge() and connect seed to split point
│   4. If nearest is a node, add a short pathfound spur from seed to that node
│   5. Mark the spur as hierarchy: 'arterial'
│
├── addWaterfrontRoad(graph, cityLayers, rng)  [optional, only if coastal]
│   1. Find waterfront cells near the city center (within ~30% of city radius)
│   2. If enough waterfront exists, pathfind a short promenade route
│   3. Cap length at maxLength = cityWidth * cs * 0.3
│   4. Add as a single edge with polyline points, hierarchy: 'collector'
│   5. Connect to nearest inherited road node
│
└── addRiverRoads(graph, cityLayers, rng)  [optional, only if river present]
    1. Check if rivers data exists and crosses city area
    2. If so, add road(s) along riverbank(s) near the center
    3. Connect to nearest inherited road node
```

**Key design decisions:**

- **Coordinate conversion:** Regional road paths are in regional grid coords `{gx, gz}`. Convert to city-local world coords: `x = (gx - minGx) * regionalCellSize`, `z = (gz - minGz) * regionalCellSize`. This uses the regional cell size directly (not the city cell size).

- **Clipping:** Walk path points sequentially. When a segment crosses the city boundary, interpolate to find the exact crossing point. That becomes an entry/exit node. A road might enter and exit the city (passing through), giving two boundary nodes and an interior path.

- **Corridor-guided refinement:** The regional path is at 50m resolution. Re-pathfinding at 10m resolution gives smoother results. The cost function adds a distance-from-corridor penalty so the refined path stays near the original but adapts to fine terrain detail. Something like:
  ```
  corridorCost(gx, gz) = baseTerrain(gx, gz) * (1 + distToRegionalPath * 0.5)
  ```
  where `distToRegionalPath` is measured from a rasterized version of the regional road on the city grid.

- **Intersection detection:** After adding all inherited roads, scan for node pairs that are closer than `3 * cs`. Merge them into one node. This handles the case where two regional roads share a corridor (the regional `roadGrid` encouraged this) — their city-refined paths will be close together near shared sections.

- **No fallback cardinal routes:** If no regional roads enter the city (unlikely but possible for isolated tier-3 villages), add 2 simple roads from the seed toward the two nearest city boundary edges. Much simpler than the current 4-direction fallback.

---

### 3. `src/city/generateArterials.js` — simplify

**What:** Remove the all-pairs entry connection (regional roads already handle this). Replace with gap-fill logic.

**Current structure to change:**
- Lines 39-75: The all-pairs `entryNodes[i] ↔ entryNodes[j]` pathfinding loop — **remove entirely**

**New structure:**

```
generateArterials(cityLayers, graph, rng)
├── Find underserved areas
│   1. Rasterize current road network onto a coverage grid
│   2. Identify cells with density > 0.3 that are further than 30*cs from any arterial node
│   3. These are "gap centers" that need arterial access
│
├── For each gap center:
│   1. Find the two nearest arterial nodes in the graph
│   2. Pathfind from the gap center to each (terrain + density corridor cost, same as current)
│   3. Add as arterial edges
│
├── Cross-link parallel arterials
│   1. If two inherited arterials run roughly parallel (within 40*cs) without connecting,
│      add a perpendicular cross-link through high-density areas between them
│
└── Bridge marking (keep existing concept)
    Mark edges that cross waterMask cells as needing bridges
```

**The `addPathAsEdges` helper function (lines 88-120) is still useful** — keep it for the gap-fill paths.

---

### 4. `src/city/pipeline.js` — no structural changes

The pipeline calls `generateAnchorRoutes` and `generateArterials` with the same signatures. No changes needed to the orchestrator.

---

### 5. `src/city/pipelineDebug.js` — no structural changes

Same — it calls the same functions. The debug output will automatically show the new road patterns.

---

### 6. Spec Changes

#### `specs/v3/architecture-summary.md`

**Line 122-123, B2 description.** Replace:
> Place the first roads — waterfront routes, roads following natural features, connections to regional road entry points. These are the ancient routes that predate planned development.

With:
> Inherit regional roads that pass through the city area. Clip to the city boundary, refine at city grid resolution using corridor-guided pathfinding, and detect where roads intersect or share corridors. Connect the city seed to the nearest inherited road. Add focused structural roads — a waterfront promenade near the center if coastal, paths along riverbanks if a river passes through. These inherited routes are the skeleton that all subsequent road phases build on.

**Lines 128-129, B4 description.** Replace:
> Connect regional entry roads to the city seed and to each other. These become the main streets — widest roads, most traffic, commercial character. Bridge locations become critical nodes.

With:
> Fill gaps in the inherited arterial network. Where populated areas lack arterial access (based on the density field), pathfind new connections. Add cross-links between parallel inherited roads through high-density areas. Mark bridge locations where arterials must cross rivers.

#### `specs/v3/pipeline.md`

**Line 21, B2 Output.** Change:
> PlanarGraph with entry roads + waterfront

To:
> PlanarGraph with inherited regional roads + waterfront/river structural roads

---

## Implementation Order

1. **`extractCityContext.js`** — add `regionalCellSize` to params (1 line)
2. **`generateAnchorRoutes.js`** — full rewrite
3. **`generateArterials.js`** — remove all-pairs loop, add gap-fill
4. **Run `debug-city.js`** with a few seeds to compare before/after
5. **Update spec documents** once the output looks right
6. **Update `observations-anchor-routes.md`** to mark issues as resolved

## Expected Outcome

- Anchor routes will show 2-4 roads passing through the city following realistic corridors, rather than a star pattern
- The waterfront will be a short promenade, not an exhaustive coastal survey
- Entry/exit points will be at the correct positions where regional roads cross the boundary
- Subsequent phases (arterials, collectors, streets) will build on a much more realistic skeleton
