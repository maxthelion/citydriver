# V5: Unified Bitmap Pipeline

## Status: In Progress

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

### Derived Bitmap 1: buildability (float32, 0–1)

**The single source of truth for "can we build here and how desirable is it?"**

```
buildability = f(elevation, slope, waterMask, waterType, occupancy, waterDistance, edgeMargin)
```

Composites all contributing factors into one grid:

| Factor | Effect |
|--------|--------|
| elevation < seaLevel | 0 (hard block) |
| waterMask > 0 | 0 (hard block) |
| slope | continuous falloff: flat=1.0 → steep=0 |
| occupancy > 0 | 0 (already used) |
| edge margin < 3 cells | 0 (hard block) |
| edge margin 3–8 cells | scaled down |
| water proximity | bonus for waterfront cells |

**Recomputed** after any operation that modifies occupancy (road stamping, plot stamping).

**Consumed by:** nuclei seeding, institutional plot placement, growth target validation, block subdivision plot validation, the debug layer visualization.

### Derived Bitmap 2: pathCost (function)

**The single source of truth for "what does it cost to route through this cell?"**

```
pathCost = f(elevation, waterMask, bridgeGrid, occupancy, buildability)
```

One function, parameterized for different use cases:

| Parameter | Default | Anchor Routes | Growth | Satellite | Bridge |
|-----------|---------|---------------|--------|-----------|--------|
| slopePenalty | 10 | 10 | 10 | 10 | 3 |
| waterCost | Infinity | Infinity | Infinity | Infinity | ×8 |
| allowBridges | true | true | true | true | true |
| reuseDiscount | 0.5 | 0.15 | 0.5 | 0.15 | 0.1 |
| plotPenalty | 5.0 | 5.0 | 5.0 | 5.0 | 5.0 |
| lowBuildabilityPenalty | yes | no | yes | no | no |

Key change: **pathCost reads buildability** for the low-buildability penalty rather than re-deriving slope/water checks. A cell with buildability=0.1 gets a high traversal cost even if no single factor is a hard block.

### Feedback Loop

```
Setup:
  extractCityContext → importRivers → classifyWater → refineTerrain
  → create occupancy grid
  → computeBuildability (initial, no occupancy)
  → generateAnchorRoutes (using pathCost)
  → stamp roads onto occupancy
  → computeBuildability (with road occupancy)
  → seedNuclei (reads buildability)
  → generateInstitutionalPlots (reads buildability)
  → stamp plots onto occupancy
  → computeBuildability (with roads + plots)

Growth (per tick):
  → select targets (reads buildability for priority)
  → pathfind roads (using pathCost, which reads buildability)
  → stamp new roads onto occupancy
  → subdivide blocks into plots
  → stamp plots onto occupancy
  → computeBuildability (updated)
  → next tick reads updated surface
```

## Implementation

### Phase 1: buildability.js (consolidate)

Update `computeBuildability` to include water distance bonus (from terrainFields) so it fully replaces both the old buildability check AND terrainAttraction as the "desirability" surface.

### Phase 2: pathCost.js (new, consolidate)

Create a single parameterized cost function factory that replaces:
- `terrainCostFunction` in pathfinding.js
- `sharedCost` in generateAnchorRoutes.js
- `buildGrowthCostFn` in growCity.js
- `satCost` in growCity.js
- `bridgeCost` in growCity.js

### Phase 3: Migrate consumers

Replace all ad-hoc buildability checks with reads from the buildability grid:
- `generateInstitutionalPlots.isBuildable()` → `buildability.get(gx, gz) > 0`
- `blockSubdivision.isPlotBuildableSimple()` → `buildability.get(gx, gz) > 0`
- `seedNuclei` validation → `buildability.get(gx, gz) > threshold`
- `growCity` target validation → `buildability.get(gx, gz) > 0`
- `generateLandCover` water/elevation checks → `buildability.get(gx, gz)`

### Phase 4: Recompute points

Wire `computeBuildability` at every point occupancy changes:
- After anchor route stamping
- After institutional plot stamping
- After each growth tick (roads + plots stamped)

## Files

| Action | File | Change |
|--------|------|--------|
| Modify | `src/city/buildability.js` | Add water distance bonus, formalize as the canonical buildability surface |
| Create | `src/city/pathCost.js` | Single parameterized cost function factory |
| Modify | `src/city/interactivePipeline.js` | Recompute buildability at each stage |
| Modify | `src/city/pipeline.js` | Same |
| Modify | `src/city/pipelineDebug.js` | Same |
| Modify | `src/city/generateAnchorRoutes.js` | Use pathCost instead of inline cost function |
| Modify | `src/city/growCity.js` | Use pathCost + buildability instead of 4 inline cost functions + ad-hoc checks |
| Modify | `src/city/generateInstitutionalPlots.js` | Replace isBuildable with buildability grid read |
| Modify | `src/city/blockSubdivision.js` | Replace isPlotBuildableSimple with buildability grid read |
| Modify | `src/city/seedNuclei.js` | Replace elevation/water checks with buildability grid read |
| Modify | `src/rendering/layerRenderers.js` | available-land layer directly shows buildability (already done) |
