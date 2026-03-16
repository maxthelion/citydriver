# Water Boundary Treatment

## Problems

### 1. Z-fighting at water edges
Terrain mesh vertices near sea level flicker against the water plane.
Cells barely below sea level render as ambiguous land/water. River ribbon
meshes overlap with the sea plane at river mouths.

### 2. No flood margin
Buildings are placed right up to the waterline. No concept of minimum
elevation above sea level for development. Low-lying coastal land should
not be built on.

### 3. No waterfront edge treatment
Real waterfronts have engineered edges:
- River embankments (vertical wall, 1-2m above water)
- Harbour quay walls (vertical face, 2-3m above water)
- Beaches (gradual slope from sea to land)
- Promenades (flat walkway between water edge and buildings)

Currently the transition from water to land is just wherever the terrain
happens to cross sea level — no clear boundary, no constructed edge.

### 4. Rivers don't terminate cleanly at the sea
River ribbon meshes extend to the coast and overlap with the sea plane.
Both surfaces are at similar heights, causing visual artifacts.

## Design

### A. Terrain clamping (fixes z-fighting)

**Rule: terrain vertices are never rendered below `seaLevel + 0.1m`.**

In `_buildTerrain` (CityScreen.js), clamp the elevation used for vertex
positions:
```
renderHeight = max(cutElevation, seaLevel + 0.1)
```

The water plane sits at `seaLevel`. Terrain is always at least 0.1m
above it. No z-fighting possible. The terrain mesh becomes a "lid" over
the water.

For cells that ARE water (waterMask > 0), the terrain vertex can be
lowered to `seaLevel - 1.0` so the water plane clearly covers them.
This creates a visible "cliff" at the water boundary which reads as a
bank edge.

### B. Water edge step (clean boundary)

After channel carving in city setup, enforce a **minimum depth step** at
water boundaries:

For each land cell adjacent to a water cell:
- Clamp elevation to `max(elevation, seaLevel + BANK_HEIGHT)`
- Where `BANK_HEIGHT` = 1.0m for rivers, 1.5m for sea

For each water cell:
- Clamp elevation to `min(elevation, seaLevel - MIN_WATER_DEPTH)`
- Where `MIN_WATER_DEPTH` = 0.5m

This creates a visible step at every water boundary — a 1.5m drop from
land to water. No gradual ambiguous transition.

### C. River termination at sea

River ribbon meshes should **stop** where the river enters open water
(sea or large lake).

In `prepareCityScene`, when building river ribbons:
- Walk each river polyline
- If a point's elevation is at or below sea level AND the cell is
  classified as sea water (waterType = 1), truncate the ribbon there
- The sea plane takes over for the remainder

This prevents river/sea mesh overlap.

### D. Flood margin in buildability

In terrain suitability computation:
- Cells below `seaLevel + FLOOD_MARGIN` are unbuildable
- `FLOOD_MARGIN` = 2.0m
- Cells within 2 cells of water AND below `seaLevel + FLOOD_MARGIN`
  get buildability = 0

This creates a natural setback from water. Combined with the bank edge
(section B), buildings sit on land that's at least 2m above sea level.

### E. Waterfront edge types (future)

Different water edge treatments based on context:
- **River embankment**: vertical wall 1-2m, with path on top
- **Harbour quay**: vertical wall 2-3m, with bollards
- **Beach**: gradual sandy slope from promenade to water
- **Natural bank**: steep vegetated slope

These would be rendered as geometry features (wall meshes, path meshes)
placed along the water boundary. They connect to the archetype system:
port cities get quays, market towns get embankments, etc.

**Deferred** — the clean boundary from sections A-D is enough for now.
Edge types add visual quality but aren't needed to fix the artifacts.

## Implementation order

1. **A + B**: terrain clamping + water edge step (fixes all z-fighting)
2. **C**: river termination at sea
3. **D**: flood margin in buildability
4. **E**: waterfront edge types (future work)

## Files affected

| File | Changes |
|------|---------|
| `src/ui/CityScreen.js` | Clamp terrain vertices in `_buildTerrain` |
| `src/city/setup.js` | `enforceWaterBoundaries()` after channel carving |
| `src/rendering/prepareCityScene.js` | Truncate river ribbons at sea |
| `src/core/terrainSuitability.js` | Flood margin in suitability computation |
