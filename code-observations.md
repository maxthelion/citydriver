# Code Observations

## Anchor roads don't reach city boundary

Regional roads enter the city via `getAnchorConnections()` in `skeleton.js:131`. It filters regional waypoints to those inside the city bounds, then takes the first and last in-bounds points as pathfinding endpoints. Since regional waypoints are spaced at `regionalCellSize` (~200m), the first in-bounds waypoint can be up to 200m inside the city edge.

Result: skeleton roads start/end well short of the city boundary — there's a gap where a regional road should connect to the edge but doesn't. A fix would interpolate the regional road polyline against the city boundary to find the actual entry/exit points.

## Anchor roads discard intermediate waypoints

Regional roads are A* pathfound at regional resolution, producing a `rawPath` of grid cells that trace through valleys, around water, and through passes. `getAnchorConnections()` converts all in-bounds waypoints to city grid coords (`cityPoints`), but then only uses the first and last: `startPt = cityPoints[0]`, `endPt = cityPoints[cityPoints.length - 1]`. All intermediate waypoints are discarded.

The city then re-pathfinds from scratch between those two endpoints on the city-resolution cost grid. For long roads crossing the full city, the city A* might find a quite different route than the regional one intended — ignoring knowledge about where the regional road found good river crossings or mountain passes. The intermediate `cityPoints` could be passed as waypoints to guide the city pathfinding, or the road could be broken into segments between consecutive regional waypoints.

## Regional settlements not connected to road network

`setupCity` imports nearby settlements as `map.regionalSettlements` (setup.js:166), but they're only used for debug drawing. The MST in `getMSTConnections()` (skeleton.js:201) only connects `map.nuclei` — the independently placed growth seeds. Regional settlements aren't included as nuclei or MST targets.

Anchor roads from the regional map do pass through/near these settlements (since that's how regional roads were routed), but the skeleton builder doesn't know they're destinations. Nuclei are placed by land value scoring and may not coincide with the village locations. A fix could seed nuclei at regional settlement positions, or add them as explicit MST targets.

## River tributary tree structure lost at city import

`inheritRivers` walks the regional `riverPaths` tree (which has parent/child relationships between tributaries and confluence points) but outputs a flat array of clipped polylines. The tree structure is discarded — at the city level, rivers are just independent polylines with no knowledge of which tributary feeds into which main stem, or where confluences are. This could matter for bridge placement (knowing which rivers are branches of the same system) or for any future hydrology-aware logic.

## Rivers enter abruptly at city boundary

`inheritRivers` (inheritRivers.js) captures one out-of-bounds point *after* the in-bounds run (trailing edge), but not the last out-of-bounds point *before* the first in-bounds point (leading edge). Rivers that enter the city from outside start abruptly at the boundary rather than flowing in smoothly. Same class of issue as the anchor roads.

## Nucleus classification checks roads before roads exist

`classifyNucleus()` in setup.js:401 checks `map.roadGrid` to assign `market` (3+ road directions) and `roadside` types. But it's called from `placeNuclei` at the end of `setupCity`, before `buildSkeletonRoads` runs. The road grid is all zeros at that point, so `market` and `roadside` can never trigger.

## Nucleus type is computed but never used behaviorally

`classifyNucleus()` assigns types (`waterfront`, `market`, `hilltop`, `valley`, `roadside`, `suburban`) but no downstream code reads `n.type`. The skeleton builder only uses `n.gx`, `n.gz`, and `n.tier`. The type is only drawn in debug views.

## Land value underweights roads

`computeLandValue()` runs in `setupCity` before any roads exist, so the junction (`LV_JUNCTION`) and bridge (`LV_BRIDGE`) value sources contribute nothing. After skeleton roads are added, `_stampRoadValue` does a lightweight incremental update (only stamps junctions where value < 0.5, no re-blur). The land value field ends up dominated by terrain features (town center, waterfront, hilltops) and largely ignores the road network.

## Graph and road features diverge after resolution passes

After `rebuildGraphFromRoads()` (skeleton.js:101), the graph and `map.roads` are in sync. Then the crossing-edge and shallow-angle resolution passes (lines 108-114) modify the graph only — splitting edges, merging nodes, removing near-parallel edges. But `map.roads` is not updated. Downstream code reading `map.roads` (placeBuildings, prepareCityScene, DebugScreen) sees pre-resolution polylines, while `map.graph` has the cleaned topology.

## MST uses Euclidean distance, not terrain cost

`getMSTConnections()` (skeleton.js:201) sorts edges by Euclidean distance between nuclei. Two nuclei that are close as the crow flies but separated by a wide river get connected first in the MST, even though the actual pathfound route is expensive and requires a bridge. A terrain-weighted distance would produce a better spanning tree.

## Building placement ignores road hierarchy

`placeBuildings()` uses the same setback (14m), plot interval (20m), and archetype (`suburbanDetached`) for all roads regardless of hierarchy. Houses along a 16m-wide arterial are placed identically to those along a 9m-wide local road. No density or building-type variation.

## Dead code

- `regionalSlope` extracted in setup.js:29 but never used — slope is recomputed from city-resolution elevation via central differences
- `roadAngle` computed in placeBuildings.js:98 but never referenced — rotation is computed separately from the perpendicular vector

## Redundant slope computation

Slope is computed in `setupCity` (lines 97-113), then `carveChannels()` recomputes it from scratch using identical central-difference logic and re-runs `_computeInitialBuildability()`. The initial slope computation is effectively thrown away if any rivers exist.

## clone() omits waterDepth

`FeatureMap.clone()` copies terrain, derived grids, features, nuclei, and metadata, but omits `waterDepth`. A cloned map's `createPathCost()` will find `waterDepth` undefined and fall back to flat `unbuildableCost` penalties, producing different routing behavior than the original.
