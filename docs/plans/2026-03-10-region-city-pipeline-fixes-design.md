# Region-to-City Pipeline Fixes Design

**Goal:** Fix three data flow issues where regional information is lost or incorrectly imported into the city model: settlements not becoming nuclei, anchor roads not reaching boundaries, and rivers losing tree structure and boundary continuity.

## 1. Regional settlements as nuclei

In `placeNuclei` (setup.js), before the existing land-value greedy loop:

- Iterate `map.regionalSettlements`, convert each to city grid coords (already computed as `cityGx`/`cityGz`)
- For each, nudge to nearest buildable cell if on water (same logic as the existing center nucleus)
- Add as a nucleus with the regional settlement's original `tier`
- Apply suppression so land-value nuclei spread away from them
- Skip the settlement that matches the city's own settlement (already placed as center nucleus)

Then the greedy loop fills remaining slots. Land-value nuclei get tier = `max(regional tier) + 1` at minimum, so they're always lower priority than regional settlements.

## 2. Anchor roads to boundary with correct angle

In `getAnchorConnections` (skeleton.js):

- Use the smoothed `road.path` (not `rawPath`) for direction
- Convert the full regional path to world coords, then find the two boundary crossing points by walking the polyline and detecting where segments cross the city boundary rect
- At each crossing, interpolate the exact position on the boundary edge, and take the direction from the crossing segment — this gives both position and angle
- Place the first city-grid waypoint a short distance inward along that direction (e.g. 2-3 cells), so the first A* segment starts aligned with the regional road's approach angle
- All intermediate regional waypoints that fall inside the city become waypoints for chained A* (boundary entry -> wp1 -> wp2 -> ... -> boundary exit)
- `buildRoadNetwork` pathfinds each segment and concatenates them into one road feature per regional road
- For roads that only have one crossing (start or end inside the city at the main settlement), only one end gets boundary interpolation; the other end is the settlement itself

## 3. Rivers to boundary with full data

In `inheritRivers` (inheritRivers.js):

- Same boundary interpolation as anchor roads — walk the polyline, detect where segments cross the city boundary rect, interpolate the exact crossing point
- Capture the leading out-of-bounds-to-in-bounds crossing (currently missing) and the trailing in-bounds-to-out-of-bounds crossing
- The river polyline starts and ends exactly at the boundary edge, flowing smoothly in/out
- Carry a `systemId` on each polyline — derived from the tree structure during the walk. All segments that share a root get the same `systemId`
- `addFeature('river', { polyline, systemId })` stores it so downstream code can group rivers by system

The Chaikin smoothing pass and accumulation/width data continue to work as before — they operate on the clipped polyline which now has proper boundary endpoints instead of abrupt cuts.

## 4. Testing

- **Settlements as nuclei**: Regional settlements within city bounds become nuclei with correct tier; nudged off water; center settlement not duplicated; land-value nuclei get lower-priority tiers
- **Anchor roads to boundary**: Boundary crossing point is on the boundary edge; direction matches regional road's approach angle; intermediate waypoints preserved; roads starting/ending inside city only get one boundary end
- **Rivers to boundary**: Leading and trailing boundary crossings interpolated; `systemId` propagated from tree root; short tributaries whose confluence falls just outside boundary still get valid crossing point

All tests in vitest using synthetic data (small grids, simple road/river polylines crossing a boundary rect).
