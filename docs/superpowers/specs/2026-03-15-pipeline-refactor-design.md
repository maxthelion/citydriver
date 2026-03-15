# Pipeline Refactor: Source Layers and Explicit Composition

## Problem

`FeatureMap` conflates data storage with derived computation. `addFeature`
has side effects that stamp grids and zero `buildability` — making the
pipeline opaque, order-dependent, and hard to extend. Adding a reservation
system (or any new pipeline step) means understanding and working around
these hidden mutations.

## Goals

1. Separate source layers (terrain, water, roads) from derived composites
   (buildability, land value, residential mask)
2. Each pipeline step is a function `(map, params?) → map` that reads input
   layers and produces output layers
3. Composite masks are built by explicit composition functions at the point
   of use, not maintained eagerly by side effects
4. The existing tick-based UI stepping still works
5. The reservation pass can slot in cleanly as a new step

## Non-Goals

- Full immutability (too expensive for 90k-cell grids copied every step)
- Generic blend-mode layer composition (deferred — see
  `specs/v5/layer-composition-idea.md`)
- Episode/era architecture (future work)

---

## Design

### 1. FeatureMap becomes a layer bag

`FeatureMap` stores named layers and feature arrays. No `addFeature` side
effects. No `_stampRoad`, `_stampRiver`, `_stampPlot`, `_stampBuilding`.

```js
class FeatureMap {
  constructor(width, height, cellSize, options) {
    // Dimensions
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.originX = options.originX;
    this.originZ = options.originZ;

    // Feature arrays (append-only, no side effects)
    this.roads = [];
    this.rivers = [];
    this.plots = [];
    this.buildings = [];

    // Named layers (Grid2D instances, set by pipeline steps)
    this.layers = new Map();

    // Road topology graph (built by skeleton step)
    this.graph = null;

    // Metadata
    this.nuclei = [];
    this.settlement = null;
    this.seaLevel = null;
    // ...
  }

  // Layer access
  setLayer(name, grid) { this.layers.set(name, grid); }
  getLayer(name) { return this.layers.get(name); }
  hasLayer(name) { return this.layers.has(name); }

  // Feature storage (no side effects — just appends to array)
  addRoad(data) { this.roads.push(data); }
  addRiver(data) { this.rivers.push(data); }
}
```

**Layers set by pipeline steps:**

| Layer name | Type | Set by | Description |
|---|---|---|---|
| `elevation` | float32 | setup | Refined terrain height |
| `slope` | float32 | setup | Terrain gradient magnitude |
| `waterMask` | uint8 | setup | Water cells (sea, river, lake) |
| `waterType` | uint8 | setup | Sea(1)/lake(2)/river(3) |
| `waterDist` | float32 | setup | BFS distance from water |
| `waterDepth` | float32 | setup | BFS distance from land into water |
| `terrainSuitability` | float32 | setup | Slope score + edge taper (pure terrain, never mutated) |
| `roadGrid` | uint8 | skeleton | Road occupancy cells |
| `bridgeGrid` | uint8 | skeleton | Bridge cells |
| `landValue` | float32 | computeLandValue | Development desirability |
| `zoneGrid` | uint8 | extractZones | Development zone membership |
| `reservationGrid` | uint8 | reserveLandUse | Reserved land use type |

### 2. Terrain suitability replaces buildability

Currently `buildability` is computed from terrain, then mutated by every
`addFeature` call. Split it:

**`terrainSuitability`** — pure function of elevation, slope, water, and
map edges. Computed once in setup, never mutated. This is what the current
`_computeInitialBuildability` produces before any features modify it.

**Composite masks** — built on demand from source layers:

```js
// In a new file: src/core/composeMask.js

/**
 * Build a buildability mask from source layers.
 * Returns a new Grid2D (float32) — the composed result.
 */
export function composeBuildability(map) {
  const terrain = map.getLayer('terrainSuitability');
  const water = map.getLayer('waterMask');
  const roads = map.getLayer('roadGrid');

  return terrain.map((value, gx, gz) => {
    if (water.get(gx, gz) > 0) return 0;
    if (roads && roads.get(gx, gz) > 0) return 0;
    return value;
  });
}

/**
 * Build a residential placement mask.
 * Cells where ribbon layout and house placement may operate.
 */
export function composeResidentialMask(map) {
  const terrain = map.getLayer('terrainSuitability');
  const water = map.getLayer('waterMask');
  const roads = map.getLayer('roadGrid');
  const zones = map.getLayer('zoneGrid');
  const reservations = map.getLayer('reservationGrid');

  return terrain.map((value, gx, gz) => {
    if (value < 0.3) return 0;
    if (water.get(gx, gz) > 0) return 0;
    if (roads && roads.get(gx, gz) > 0) return 0;
    if (zones && zones.get(gx, gz) === 0) return 0;
    if (reservations && reservations.get(gx, gz) > 0) return 0;
    return value;
  });
}
```

Each consumer composes exactly the mask it needs. No shared mutable state.

### 3. Pipeline steps as functions

Each step is a standalone function: `(map, params?) → map`. It mutates the
map (adds layers, appends features) and returns it for chaining.

```
src/city/pipeline/
  extractCityMap.js      — was setup.js
  buildSkeletonRoads.js  — was skeleton.js (public function)
  computeLandValue.js    — was FeatureMap.computeLandValue()
  extractZones.js        — was zoneExtraction.js
  reserveLandUse.js      — NEW
  layoutRibbons.js       — was ribbonLayout.js + LandFirstDevelopment._layoutRibbons()
  connectToNetwork.js    — was LandFirstDevelopment._connectToNetwork()
  placeBuildings.js      — was placeBuildings.js
```

### 4. Skeleton builder owns its internal state

The skeleton builder pathfinds roads sequentially, each road affecting the
cost function for the next (via road reuse discount). This is stateful
within the step.

The function:
1. Creates a working `roadGrid` internally
2. Pathfinds each connection, stamps the road onto the working grid
3. At the end, sets `map.setLayer('roadGrid', workingGrid)` and appends
   all roads to `map.roads`

The internal iteration is an implementation detail. From the pipeline's
perspective, it's a single function call that produces a roadGrid layer
and a set of road features.

### 5. Path cost uses composed buildability

`createPathCost` currently closes over `this.buildability`. After refactor,
it receives the layers it needs explicitly:

```js
export function createPathCost(preset, layers) {
  const { terrainSuitability, roadGrid, waterMask, waterDepth, waterType,
          elevation } = layers;
  // ... same logic, but reads from explicit layer references
}
```

Or more practically, compose a buildability grid once before pathfinding
and pass it in, rather than recomposing per cell lookup.

### 6. LandFirstDevelopment becomes a thin sequencer

```js
import { buildSkeletonRoads } from '../pipeline/buildSkeletonRoads.js';
import { computeLandValue } from '../pipeline/computeLandValue.js';
import { extractZones } from '../pipeline/extractZones.js';
import { reserveLandUse } from '../pipeline/reserveLandUse.js';
import { layoutRibbons } from '../pipeline/layoutRibbons.js';
import { connectToNetwork } from '../pipeline/connectToNetwork.js';

export class LandFirstDevelopment {
  constructor(map, options = {}) {
    this.map = map;
    this._tick = 0;
    this.archetype = options.archetype || null;
  }

  tick() {
    this._tick++;
    switch (this._tick) {
      case 1: this.map = buildSkeletonRoads(this.map); return true;
      case 2: this.map = computeLandValue(this.map); return true;
      case 3: this.map = extractZones(this.map); return true;
      case 4: this.map = reserveLandUse(this.map, this.archetype); return true;
      case 5: this.map = layoutRibbons(this.map); return true;
      case 6: this.map = connectToNetwork(this.map); return true;
      default: return false;
    }
  }
}
```

### 7. Grid2D composition utilities

Add a small set of static methods to Grid2D for common operations:

```js
// Create a new grid where each cell is fn(a, b)
static combine(a, b, fn) {
  return a.map((va, gx, gz) => fn(va, b.get(gx, gz)));
}

// Threshold: returns 1.0 where value >= threshold, else 0
static threshold(grid, threshold) {
  return grid.map(v => v >= threshold ? 1.0 : 0);
}

// Stamp a polyline onto a grid with a given radius and value
static stampPolyline(grid, polyline, radius, value, cellSize, originX, originZ) {
  // ... extracted from current _stampRoad logic
}
```

These are pure functions that return new grids.

### 8. Debug layer rendering

`debugLayers.js` currently reads `map.buildability`, `map.roadGrid` etc.
After refactor it reads `map.getLayer('terrainSuitability')`,
`map.getLayer('roadGrid')` etc. Mechanical find-and-replace. Any composed
mask can also be rendered by composing it first, then passing the result
to the renderer.

---

## Migration Path

The refactor can be done incrementally, one pipeline step at a time, with
tests passing at each stage.

**Phase 1: Extract pipeline functions**
- Create `src/city/pipeline/` directory
- Move each tick's logic into its own file as a standalone function
- Each function reads from map, writes layers and features to map,
  returns map
- `LandFirstDevelopment` becomes a thin sequencer calling these functions
- Delete the inlined logic from `LandFirstDevelopment` (no duplication)

**Phase 2: Replace FeatureMap properties with layer bag**
- Add `layers` Map to FeatureMap with `setLayer()`/`getLayer()`
- Pipeline functions set layers via `setLayer()` instead of direct
  property assignment
- Delete the old hardcoded grid properties (`buildability`, `roadGrid`,
  `waterMask`, `bridgeGrid`, `landValue`, `waterType`, `waterDist`,
  `waterDepth`)
- Update all consumers to use `getLayer()` — no compatibility shims,
  no getters, just find-and-replace

**Phase 3: Remove addFeature side effects**
- Extract stamping logic into standalone utility functions
  (e.g. `stampPolyline`)
- Skeleton builder creates and stamps its own working roadGrid internally,
  sets it as a layer at the end
- Setup stamps waterMask from rivers directly (already does this)
- `addFeature` becomes a plain append to the feature array (or is removed
  entirely in favour of direct `map.roads.push()` etc.)
- Delete `_stampRoad`, `_stampRiver`, `_stampPlot`, `_stampBuilding`,
  and `addFeature` from FeatureMap

**Phase 4: Replace buildability with terrainSuitability + composition**
- Extract `_computeInitialBuildability` into a standalone function that
  returns a `terrainSuitability` grid (pure terrain, no feature masking)
- Add composition functions (`composeBuildability`, `composeResidentialMask`)
  in `src/core/composeMask.js`
- Update all consumers to call the appropriate composition function
- Delete `_computeInitialBuildability` and `buildability` from FeatureMap
- Delete `setTerrain` (setup sets layers directly)

**Phase 5: Add reservation step**
- `reserveLandUse(map, archetype)` reads zoneGrid, produces reservationGrid
- `layoutRibbons` reads `composeResidentialMask()` which excludes reserved
  cells
- New debug layer renders reservation zones by type

**Cleanup rule:** At each phase, old code paths are deleted, not preserved
behind compatibility shims. No deprecated getters, no forwarding methods,
no "legacy" alternatives. If a consumer needs updating, update it in the
same phase.

---

## Consequences and Risks

**What gets easier:**
- Adding new pipeline steps (reservation, commercial placement, park
  placement) — each is a function that adds a layer
- Debug visualization — any layer can be rendered independently
- Testing — each function can be tested with a minimal FeatureMap
- Understanding data flow — layers are named and traceable

**What gets harder:**
- Path cost function needs explicit layer references instead of closing
  over `this`. Minor refactor but touches a hot path.
- The "compose buildability before pathfinding" step is new ceremony.
  Currently implicit (always up to date via side effects).

**Performance:**
- Composing a 300×300 grid is ~0.1ms. Negligible even if done 10 times.
- Skeleton builder composing buildability once before its pathfinding
  loop is no worse than the current eager stamping.
- No new allocations in the hot path (pathfinding inner loop still reads
  a pre-computed grid).

**What breaks:**
- Any code reading `map.buildability` directly. During migration (phase 2),
  old property access is preserved via getters. After phase 4, callers
  must use composition functions or `map.getLayer()`.
- `map.addFeature()` callers that relied on immediate grid updates. After
  phase 3, they need to stamp grids explicitly or the grid won't reflect
  the new feature until recomposition.
- Debug layer renderers need updating (mechanical).

**What doesn't change:**
- Grid2D internals
- PlanarGraph
- Regional pipeline
- Building generation
- Three.js rendering (reads features, not grids)
