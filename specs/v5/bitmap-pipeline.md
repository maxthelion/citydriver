# V5: Unified Bitmap Pipeline

## Status: Implemented

## Problem

Every system that needs to know "can I build here?" or "what does it cost to path through here?" re-derives the answer from raw layers (elevation, slope, waterMask) with its own thresholds and logic. This creates:

- **5 different buildability checks** with inconsistent slope thresholds (0.2, 0.35, 0.5, 0.7)
- **5 different pathfinding cost functions** that each composite the same layers differently
- **Inconsistent water definition** — some check `waterMask > 0 OR elevation < seaLevel`, others only one
- **No feedback loop** — occupancy changes don't update the decision surface that future operations read

## Architecture

### Raw Layers (immutable after refineTerrain)

| Layer | Type | Source |
|-------|------|--------|
| elevation | float32 | extractCityContext → refineTerrain |
| slope | float32 | refineTerrain |
| waterMask | uint8 binary | extractCityContext → importRivers (painted) |
| waterType | uint8 (0-3) | classifyWater |
| bridgeGrid | uint8 binary | riverCrossings |

These are set once during setup and never modified after refineTerrain completes.

### Occupancy Grid (mutable)

| Layer | Type | Source |
|-------|------|--------|
| occupancy | uint8 at 3m res | roadOccupancy.js |

Modified throughout the pipeline as roads and plots are stamped. Values: 0=empty, 1=road, 2=plot, 3=junction.

Carries an attached reference to the buildability grid so stamp operations can incrementally update it.

### Derived Bitmap 1: buildability (float32, 0–1)

**The single source of truth for "can we build here and how desirable is it?"**

```
buildability = f(elevation, slope, waterMask, waterType, waterDistance, edgeMargin)
```

Composites terrain factors into one grid:

| Factor | Effect |
|--------|--------|
| elevation < seaLevel | 0 (hard block) |
| waterMask > 0 | 0 (hard block, with river-edge gradient) |
| slope | continuous falloff: flat=1.0 → steep=0 |
| edge margin < 3 cells | 0 (hard block) |
| edge margin 3–8 cells | scaled down |
| water proximity | bonus for waterfront cells |

**Computed once** from terrain during setup. After that, **incrementally updated**: stamp operations (roads, plots, junctions) zero out affected buildability cells automatically via the occupancy grid's attached buildability reference. No expensive full-grid recompute needed.

**Consumed by:** nuclei seeding, institutional plot placement, growth target validation, block subdivision plot validation, the debug layer visualization.

### Derived Bitmap 2: pathCost (function)

**The single source of truth for "what does it cost to route through this cell?"**

```
pathCost = f(elevation, buildability, bridgeGrid, occupancy)
```

One function, parameterized for different use cases:

| Parameter | Default | Anchor Routes | Growth | Satellite | Nucleus | Shortcut | Bridge |
|-----------|---------|---------------|--------|-----------|---------|----------|--------|
| slopePenalty | 10 | 10 | 10 | 10 | 5 | 8 | 3 |
| unbuildableCost | ∞ | ∞ | ∞ | ∞ | 12 | 20 | 8 |
| reuseDiscount | 0.5 | 0.15 | 0.5 | 0.15 | 0.1 | 1.0 | 0.1 |
| plotPenalty | 5.0 | 5.0 | 5.0 | 5.0 | 3.0 | 3.0 | 5.0 |

**Critical ordering:** pathCost checks occupancy *before* buildability. Road/junction cells get the reuse discount and return early, so their zeroed-out buildability doesn't block pathfinding. Plot cells get the penalty. Only genuinely unbuildable terrain (water, cliffs, edges) triggers the unbuildableCost path.

### Incremental Update Flow

```
Setup:
  extractCityContext → importRivers → classifyWater → refineTerrain
  → create occupancy grid
  → computeBuildability (terrain-only, computed once)
  → attachBuildability (wire occupancy → buildability)
  ── from here, every stamp() zeroes buildability cells automatically ──
  → generateAnchorRoutes (using pathCost)
  → stamp roads onto occupancy          ← buildability updated
  → seedNuclei (reads buildability)
  → generateInstitutionalPlots (reads buildability)
  → stamp plots onto occupancy          ← buildability updated
  → connectNuclei (MST + shortcuts)
  → stamp roads onto occupancy          ← buildability updated

Growth (per tick):
  → select targets (reads buildability for priority)
  → pathfind roads (using pathCost, reads buildability + occupancy)
  → stamp new roads onto occupancy      ← buildability updated
  → subdivide blocks into plots
  → stamp plots onto occupancy          ← buildability updated
  → next tick reads updated surface
```

No full recompute at any stage. The buildability grid is always up-to-date because every stamp operation zeros the affected cells in O(affected cells).

## Implementation

### buildability.js

`computeBuildability(cityLayers)` — terrain-only, no occupancy parameter. Computed once during setup. Returns the Grid2D which is then attached to the occupancy grid via `attachBuildability()`.

### roadOccupancy.js

`attachBuildability(occupancy, buildability)` — stores a reference to the buildability grid on the occupancy object. The low-level stamp helpers (`stampPolyOnGrid`, `stampCircleOnGrid`) check for this reference and zero corresponding buildability cells as they mark occupancy cells. The mapping from 3m occupancy cells to 10m buildability cells is: `bgx = floor(ax * res / cityCS)`.

### pathCost.js

Single parameterized cost function factory. Check order:
1. **Occupancy** — road/junction → early return with reuse discount; plot → penalty
2. **Bridge** — bridgeGrid cells bypass unbuildable water
3. **Buildability** — terrain suitability (b < 0.01 = unbuildable, b < 0.3 = moderate penalty)

Presets: `anchorRouteCost`, `growthRoadCost`, `satelliteCost`, `nucleusConnectionCost`, `shortcutRoadCost`, `bridgeCost`.

## Files

| Action | File | Change |
|--------|------|--------|
| Done | `src/city/buildability.js` | Terrain-only computation, no occupancy parameter |
| Done | `src/city/roadOccupancy.js` | `attachBuildability()`, incremental zeroing in stamp helpers |
| Done | `src/city/pathCost.js` | Occupancy-first check order, parameterized presets |
| Done | `src/city/pipeline.js` | Single `computeBuildability` + `attachBuildability`, no recomputes |
| Done | `src/city/interactivePipeline.js` | Same |
| Done | `src/city/pipelineDebug.js` | Same |
| Done | `src/city/growCity.js` | No periodic recompute, stable grid reference |
| Done | `src/city/connectNuclei.js` | No manual recompute between phases |
| Done | `src/rendering/layerRenderers.js` | Available-land layer directly shows buildability |
