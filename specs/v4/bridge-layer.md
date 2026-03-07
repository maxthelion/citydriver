# Bridge Detection & Visualization

## Detection

Bridges are detected in two ways:

1. **Initial detection** (`identifyRiverCrossings`) — runs after anchor routes, walks each road edge polyline and detects land→water→land transitions. Produces the initial `bridgeGrid` and `bridges` array.

2. **Incremental detection** (`stampEdge` in `roadOccupancy.js`) — when any road is stamped onto occupancy and the occupancy grid has attached grids (`attachGrids`), the stamp operation walks the polyline at grid resolution and marks water cells in `bridgeGrid`. New bridge records are appended to the `bridges` array.

This means roads added by `connectNuclei` (MST, shortcuts) and `growCity` (growth loop) automatically detect and register bridges — no separate pass needed.

## Data

- `bridgeGrid` (`Grid2D`, uint8) — binary grid at city resolution. Cells = 1 where a bridge exists. Read by `pathCost` to allow water crossings at 8x cost instead of Infinity.
- `bridges` (array) — `{ startGx, startGz, endGx, endGz, gx, gz, x, z, width, heading, importance }`. Used for debug rendering.

## Pipeline Integration

```
computeBuildability()     → terrain-only buildability
generateAnchorRoutes()    → roads (no bridge awareness yet)
identifyRiverCrossings()  → initial bridgeGrid + bridges array
attachGrids(occupancy, { buildability, bridgeGrid, waterMask, bridges })
  ── from here, every stampEdge() incrementally updates bridgeGrid ──
stampEdge (anchor routes)   → bridges detected
connectNuclei              → new bridges detected
growCity                   → new bridges detected
```

## Rendering

- Thick line (3px) from `(startGx, startGz)` to `(endGx, endGz)` in orange `[255, 140, 40]`
- Small circles at each endpoint (radius 2, white)
- Label bridge width near midpoint

## Files

| File | Role |
|------|------|
| `src/city/riverCrossings.js` | Initial bridge detection from anchor routes |
| `src/city/roadOccupancy.js` | Incremental bridge detection in `stampEdge` → `detectBridgeCells` |
| `src/city/pathCost.js` | Reads `bridgeGrid` — bridge cells bypass unbuildable water |
| `src/rendering/layerRenderers.js` | `renderBridgesLayer` visualizes `bridges` array |
