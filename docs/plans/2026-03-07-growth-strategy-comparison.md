# Growth Strategy Comparison Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a side-by-side comparison view showing 4 different city growth strategies running on the same seed, with shared zoom for detail inspection.

**Architecture:** Each strategy is a class with `constructor(map)` + `tick()`. A CompareScreen renders 8 canvases (4 macro + 4 micro) in a 2x4 grid. Tick 0 (setup + nuclei) is shared; strategies diverge from tick 1.

**Tech Stack:** Vanilla JS, Canvas 2D, existing FeatureMap/PlanarGraph/buildRoadNetwork infrastructure.

---

### Task 1: Grid2D.clone()

**Files:**
- Modify: `src/core/Grid2D.js`
- Test: `test/core/Grid2D.test.js`

**Step 1: Write the failing test**

In `test/core/Grid2D.test.js`, add:

```js
it('clone creates an independent deep copy', () => {
  const g = new Grid2D(10, 10, { type: 'float32', cellSize: 5, originX: 100, originZ: 200 });
  g.set(3, 4, 42);
  const c = g.clone();

  expect(c.width).toBe(10);
  expect(c.height).toBe(10);
  expect(c.cellSize).toBe(5);
  expect(c.originX).toBe(100);
  expect(c.originZ).toBe(200);
  expect(c.get(3, 4)).toBe(42);

  // Mutation independence
  c.set(3, 4, 99);
  expect(g.get(3, 4)).toBe(42);
  expect(c.get(3, 4)).toBe(99);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/Grid2D.test.js`
Expected: FAIL — `g.clone is not a function`

**Step 3: Write minimal implementation**

In `src/core/Grid2D.js`, add method to the class:

```js
clone() {
  const copy = new Grid2D(this.width, this.height, {
    type: this._type,
    cellSize: this.cellSize,
    originX: this.originX,
    originZ: this.originZ,
  });
  copy.data.set(this.data);
  return copy;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/Grid2D.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/Grid2D.js test/core/Grid2D.test.js
git commit -m "Add Grid2D.clone() for deep copying grids"
```

---

### Task 2: FeatureMap.clone()

**Files:**
- Modify: `src/core/FeatureMap.js`
- Test: `test/core/FeatureMap.test.js`

**Step 1: Write the failing test**

In `test/core/FeatureMap.test.js`, add a new describe block:

```js
describe('FeatureMap.clone', () => {
  it('creates an independent deep copy with all grids and features', () => {
    const map = new FeatureMap(20, 20, 10, { originX: 50, originZ: 50 });
    const elev = new Grid2D(20, 20);
    const slope = new Grid2D(20, 20);
    elev.set(5, 5, 100);
    map.setTerrain(elev, slope);

    map.addFeature('road', {
      polyline: [{ x: 50, z: 50 }, { x: 250, z: 50 }],
      width: 8,
      hierarchy: 'arterial',
    });

    map.nuclei = [{ gx: 10, gz: 10, type: 'market', tier: 1, index: 0 }];

    const clone = map.clone();

    // Same dimensions and origin
    expect(clone.width).toBe(20);
    expect(clone.cellSize).toBe(10);
    expect(clone.originX).toBe(50);

    // Terrain copied
    expect(clone.elevation.get(5, 5)).toBe(100);

    // Features copied
    expect(clone.roads.length).toBe(1);
    expect(clone.features.length).toBe(1);

    // Nuclei copied
    expect(clone.nuclei.length).toBe(1);
    expect(clone.nuclei[0].type).toBe('market');

    // Grids are independent
    clone.buildability.set(0, 0, 0.99);
    expect(map.buildability.get(0, 0)).not.toBe(0.99);

    // Features are independent
    clone.addFeature('road', {
      polyline: [{ x: 50, z: 100 }, { x: 250, z: 100 }],
      width: 6,
      hierarchy: 'local',
    });
    expect(clone.roads.length).toBe(2);
    expect(map.roads.length).toBe(1);

    // Nuclei are independent
    clone.nuclei.push({ gx: 5, gz: 5, type: 'suburban', tier: 3, index: 1 });
    expect(map.nuclei.length).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/FeatureMap.test.js`
Expected: FAIL — `map.clone is not a function`

**Step 3: Write minimal implementation**

In `src/core/FeatureMap.js`, add method to the class:

```js
clone() {
  const copy = new FeatureMap(this.width, this.height, this.cellSize, {
    originX: this.originX,
    originZ: this.originZ,
  });

  // Terrain
  if (this.elevation) copy.elevation = this.elevation.clone();
  if (this.slope) copy.slope = this.slope.clone();

  // Derived grids
  copy.buildability = this.buildability.clone();
  copy.waterMask = this.waterMask.clone();
  copy.bridgeGrid = this.bridgeGrid.clone();
  copy.roadGrid = this.roadGrid.clone();
  copy.landValue = this.landValue.clone();
  if (this.waterType) copy.waterType = this.waterType.clone();

  // Features (deep copy data, not object references)
  for (const f of this.features) {
    const fCopy = JSON.parse(JSON.stringify(f));
    copy.features.push(fCopy);
    switch (fCopy.type) {
      case 'road': copy.roads.push(fCopy); break;
      case 'river': copy.rivers.push(fCopy); break;
      case 'plot': copy.plots.push(fCopy); break;
      case 'building': copy.buildings.push(fCopy); break;
    }
  }

  // Graph is fresh (strategies build their own)
  // copy.graph = new PlanarGraph() — already set by constructor

  // Nuclei (deep copy)
  copy.nuclei = this.nuclei.map(n => ({ ...n }));

  // Metadata
  copy.seaLevel = this.seaLevel;
  copy.settlement = this.settlement;
  copy.regionalLayers = this.regionalLayers;
  copy.rng = this.rng;

  return copy;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/FeatureMap.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/FeatureMap.js test/core/FeatureMap.test.js
git commit -m "Add FeatureMap.clone() for independent strategy copies"
```

---

### Task 3: Move nucleus placement to setup.js

Nucleus placement currently lives in `src/city/skeleton.js:placeNuclei()` (lines 226-295) and `classifyNucleus()` (lines 301-357). Move both to `src/city/setup.js` so all strategies share the same nuclei.

**Files:**
- Modify: `src/city/setup.js`
- Modify: `src/city/skeleton.js`
- Test: `test/city/setup.test.js`
- Test: `test/city/skeleton.test.js`

**Step 1: Write the failing test**

In `test/city/setup.test.js`, add:

```js
it('places nuclei during setup', () => {
  // (use existing test setup pattern from the file)
  expect(map.nuclei.length).toBeGreaterThan(0);
  expect(map.nuclei[0]).toHaveProperty('gx');
  expect(map.nuclei[0]).toHaveProperty('gz');
  expect(map.nuclei[0]).toHaveProperty('type');
  expect(map.nuclei[0]).toHaveProperty('tier');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/setup.test.js`
Expected: FAIL — nuclei is empty array after setup

**Step 3: Move the code**

In `src/city/setup.js`:
- Import `distance2D` from `../core/math.js`
- Copy `placeNuclei()` and `classifyNucleus()` from skeleton.js
- Add `nucleusCap()` and `importanceTierWeight()` helper (only `nucleusCap` needed)
- Call `placeNuclei(map, settlement.tier || 3, rng)` after `map.computeLandValue()` and assign to `map.nuclei`

In `src/city/skeleton.js`:
- Remove `placeNuclei()`, `classifyNucleus()`, `nucleusCap()` functions
- Remove `const nuclei = placeNuclei(map, tier, rng); map.nuclei = nuclei;` from `buildSkeleton`
- Instead read nuclei from `map.nuclei` (already placed by setup)
- Keep `importanceTierWeight()` (used by `getMSTConnections`)

**Step 4: Run all tests to verify**

Run: `npx vitest run test/city/setup.test.js test/city/skeleton.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/city/setup.js src/city/skeleton.js test/city/setup.test.js
git commit -m "Move nucleus placement from skeleton to setup (shared tick 0)"
```

---

### Task 4: Extract skeleton road building as a reusable function

`buildSkeleton` in `src/city/skeleton.js` does two things: collect connections + build roads. Extract the "collect connections and build roads" logic into a function that strategies can call with their own connection lists.

**Files:**
- Modify: `src/city/skeleton.js`

**Step 1: Extract `buildSkeletonRoads(map)` function**

Refactor `buildSkeleton` into an exported `buildSkeletonRoads(map)` that:
1. Collects anchor + MST + fallback connections (existing logic)
2. Calls `buildRoadNetwork` (existing)
3. Adds roads as features + graph edges (existing)
4. Returns the built roads array

The existing `buildSkeleton(map)` becomes a thin wrapper that calls `buildSkeletonRoads(map)`.

```js
export function buildSkeletonRoads(map) {
  const layers = map.regionalLayers;
  const nuclei = map.nuclei;

  const connections = [];
  connections.push(...getAnchorConnections(map, layers));
  connections.push(...getMSTConnections(map, nuclei));
  if (connections.length === 0) {
    connections.push(...getFallbackConnections(map));
  }

  const costFn = map.createPathCost('anchor');
  const builtRoads = buildRoadNetwork({ /* existing params */ });

  for (const road of builtRoads) {
    if (!road.polyline || road.polyline.length < 2) continue;
    const importance = road.hierarchy === 'arterial' ? 0.9 :
                       road.hierarchy === 'collector' ? 0.6 : 0.45;
    const width = 6 + importance * 10;
    map.addFeature('road', {
      polyline: road.polyline, width, hierarchy: road.hierarchy,
      importance, source: 'skeleton',
    });
    _addRoadToGraph(map, road.polyline, width, road.hierarchy);
  }

  return builtRoads;
}

export function buildSkeleton(map) {
  buildSkeletonRoads(map);
}
```

**Step 2: Run existing tests to verify nothing broke**

Run: `npx vitest run test/city/skeleton.test.js`
Expected: PASS

**Step 3: Commit**

```bash
git add src/city/skeleton.js
git commit -m "Extract buildSkeletonRoads as reusable function for strategies"
```

---

### Task 5: CompareScreen UI shell

**Files:**
- Create: `src/ui/CompareScreen.js`
- Modify: `src/main.js`
- Modify: `src/ui/RegionScreen.js`

**Step 1: Create CompareScreen with layout**

Create `src/ui/CompareScreen.js` with:
- Constructor takes `(container, layers, settlement, seed, onBack)`
- Layout: sidebar (240px) + grid area (2 rows x 4 cols of canvases)
- Each canvas has a strategy label above it
- Sidebar: seed input, layer selector (reuse LAYERS from debugLayers.js), Step button, Reset button, Back button
- No strategy logic yet — just the 8 canvases rendering empty/terrain

Key structure:
```js
import { setupCity } from '../city/setup.js';
import { LAYERS } from '../rendering/debugLayers.js';
import { SeededRandom } from '../core/rng.js';

const STRATEGY_NAMES = ['Face Subdivision', 'Offset Infill', 'Frontage Pressure', 'Triangle Merge'];
const DETAIL_SCALE = 4;
const GRID_DIVISIONS = 6;

export class CompareScreen {
  constructor(container, layers, settlement, seed, onBack) {
    this.container = container;
    this.layers = layers;
    this.settlement = settlement;
    this.seed = seed;
    this.onBack = onBack;
    this.maps = [null, null, null, null]; // one FeatureMap per strategy
    this.strategies = [null, null, null, null];
    this.currentLayerIndex = 0;
    this._selectedCell = null;
    this.currentTick = 0;
    this._disposed = false;

    this._buildUI();
    this._generate();
  }
  // ... UI building, rendering, event handling
}
```

**Step 2: Wire up routing**

In `src/main.js`, add:
- Import `CompareScreen`
- Add `let compareScreen = null;`
- Add `compareScreen` cleanup in `backToRegion`
- Handle `urlMode === 'compare'` in deep-link section
- Add `onCompare` callback alongside `onDebug`

In `src/ui/RegionScreen.js`:
- Accept `onCompare` in callbacks
- Add "Compare Growth" button next to "Debug City" button (same style, different color)

**Step 3: Test manually**

Navigate to `?mode=compare&seed=202245&gx=59&gz=92` — should show 8 empty canvases with strategy labels and sidebar controls.

**Step 4: Commit**

```bash
git add src/ui/CompareScreen.js src/main.js src/ui/RegionScreen.js
git commit -m "Add CompareScreen UI shell with 8-panel layout and routing"
```

---

### Task 6: CompareScreen rendering and interaction

**Files:**
- Modify: `src/ui/CompareScreen.js`

**Step 1: Implement _generate()**

```js
_generate() {
  const rng = new SeededRandom(this.seed);
  const baseMap = setupCity(this.layers, this.settlement, rng.fork('city'));
  // Clone 4 copies (one per strategy)
  this.maps = [baseMap.clone(), baseMap.clone(), baseMap.clone(), baseMap.clone()];
  this.currentTick = 0;
  this._selectedCell = null;
  this._renderAll();
}
```

**Step 2: Implement rendering**

- `_renderAll()` — iterates all 8 canvases, calls the current LAYERS renderer on each
- Macro canvases render at `map.width x map.height`
- Micro canvases render at `cellW * DETAIL_SCALE x cellH * DETAIL_SCALE` (same detail rendering logic as DebugScreen)
- Layer selector re-renders all 8 on change

**Step 3: Implement click-to-zoom**

- Click on any macro canvas → compute grid cell (col, row) from click position
- Set `this._selectedCell = { col, row }`
- Re-render all 4 micro canvases at that cell

**Step 4: Test manually**

Navigate to compare view — should show 4 identical terrain maps (macro) and 4 identical zoomed cells (micro) after clicking. Layer selector should update all 8.

**Step 5: Commit**

```bash
git add src/ui/CompareScreen.js
git commit -m "CompareScreen rendering: layer selection, macro/micro zoom interaction"
```

---

### Task 7: Strategy base — FaceSubdivision (skeleton only)

The first strategy to implement. Start with just the skeleton (tick 1), no growth yet.

**Files:**
- Create: `src/city/strategies/faceSubdivision.js`
- Test: `test/city/strategies/faceSubdivision.test.js`

**Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { FaceSubdivision } from '../../../src/city/strategies/faceSubdivision.js';
import { setupCity } from '../../../src/city/setup.js';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';

describe('FaceSubdivision', () => {
  it('builds skeleton roads on first tick', () => {
    const { layers, settlement } = generateRegionFromSeed(42);
    const { SeededRandom } = await import('../../../src/core/rng.js');
    const rng = new SeededRandom(42);
    const map = setupCity(layers, settlement, rng.fork('city'));

    const strategy = new FaceSubdivision(map);
    strategy.tick(); // tick 1: skeleton

    expect(map.roads.length).toBeGreaterThan(0);
    expect(map.graph.edges.size).toBeGreaterThan(0);
  });
});
```

**Step 2: Write the strategy**

```js
import { buildSkeletonRoads } from '../skeleton.js';

export class FaceSubdivision {
  constructor(map) {
    this.map = map;
    this._tick = 0;
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    // TODO: face extraction + subdivision in later ticks
    return false;
  }
}
```

**Step 3: Run test**

Run: `npx vitest run test/city/strategies/faceSubdivision.test.js`
Expected: PASS

**Step 4: Commit**

```bash
git add src/city/strategies/faceSubdivision.js test/city/strategies/faceSubdivision.test.js
git commit -m "Add FaceSubdivision strategy with skeleton-only first tick"
```

---

### Task 8: Remaining strategy stubs

Create the other 3 strategy files. All start identical to FaceSubdivision (skeleton on tick 1, no growth yet). This lets the CompareScreen work immediately — all 4 panels show the same skeleton, proving the infrastructure works.

**Files:**
- Create: `src/city/strategies/offsetInfill.js`
- Create: `src/city/strategies/frontagePressure.js`
- Create: `src/city/strategies/triangleMergeSubdiv.js`

Each file follows the same pattern:

```js
import { buildSkeletonRoads } from '../skeleton.js';

export class OffsetInfill {
  constructor(map) {
    this.map = map;
    this._tick = 0;
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    return false;
  }
}
```

(Same for FrontagePressure, TriangleMergeSubdiv with appropriate class names.)

**Step 1: Create all 3 files**

**Step 2: Commit**

```bash
git add src/city/strategies/
git commit -m "Add stub strategies: OffsetInfill, FrontagePressure, TriangleMergeSubdiv"
```

---

### Task 9: Wire strategies into CompareScreen with auto-run

**Files:**
- Modify: `src/ui/CompareScreen.js`

**Step 1: Import strategies and wire up**

```js
import { FaceSubdivision } from '../city/strategies/faceSubdivision.js';
import { OffsetInfill } from '../city/strategies/offsetInfill.js';
import { FrontagePressure } from '../city/strategies/frontagePressure.js';
import { TriangleMergeSubdiv } from '../city/strategies/triangleMergeSubdiv.js';

const STRATEGY_CLASSES = [FaceSubdivision, OffsetInfill, FrontagePressure, TriangleMergeSubdiv];
```

**Step 2: Update _generate()**

After cloning maps, create strategy instances:
```js
this.strategies = this.maps.map((map, i) => new STRATEGY_CLASSES[i](map));
```

**Step 3: Auto-run ticks 1-4**

```js
for (let t = 0; t < 4; t++) {
  for (const s of this.strategies) s.tick();
  this.currentTick++;
}
this._renderAll();
```

**Step 4: Wire Step button**

```js
_step() {
  for (const s of this.strategies) s.tick();
  this.currentTick++;
  this._renderAll();
}
```

**Step 5: Test manually**

Compare view should auto-run and show 4 panels with identical skeletons (since all strategies are stubs using the same buildSkeletonRoads). Step button should work.

**Step 6: Commit**

```bash
git add src/ui/CompareScreen.js
git commit -m "Wire strategies into CompareScreen with auto-run ticks 1-4"
```

---

### Task 10: FaceSubdivision growth — face extraction + subdivision

This is the first real growth algorithm. Implement face extraction and recursive subdivision.

**Files:**
- Modify: `src/city/strategies/faceSubdivision.js`
- Test: `test/city/strategies/faceSubdivision.test.js`

**Step 1: Write the test**

```js
it('subdivides large faces into smaller blocks', () => {
  const { layers, settlement } = generateRegionFromSeed(42);
  const rng = new SeededRandom(42);
  const map = setupCity(layers, settlement, rng.fork('city'));

  const strategy = new FaceSubdivision(map);
  strategy.tick(); // skeleton
  const roadsAfterSkeleton = map.roads.length;

  strategy.tick(); // first growth tick
  expect(map.roads.length).toBeGreaterThan(roadsAfterSkeleton);

  // Faces should be getting smaller
  const faces = map.graph.faces();
  const simpleFaces = faces.filter(f => f.length === new Set(f).size);
  expect(simpleFaces.length).toBeGreaterThan(0);
});
```

**Step 2: Implement subdivision logic**

In `faceSubdivision.js`, tick 2+:
1. Extract faces from `this.map.graph`
2. Filter to simple faces (no repeated nodes), exclude outer face (largest area or negative signed area)
3. Find faces larger than target block size (e.g. area > 4000 sq meters = ~60x60m)
4. For each oversized face: find two longest edges, pick midpoints, pathfind between them using `buildRoadNetwork`, add as feature + graph edge
5. Return true if any faces were subdivided, false if all faces are small enough

Key implementation details:
- Compute face polygon from node positions: `face.map(nid => map.graph.getNode(nid))`
- Shoelace formula for signed area (negative = CW = inner face in our coordinate system)
- Split graph edges at the midpoint using `graph.splitEdge(edgeId, x, z)`
- The new connecting road is added via `addFeature` and `_addRoadToGraph`
- Each tick subdivides a batch of faces (e.g. up to 5 largest faces per tick for visual stepping)

**Step 3: Run test**

Run: `npx vitest run test/city/strategies/faceSubdivision.test.js`
Expected: PASS

**Step 4: Commit**

```bash
git add src/city/strategies/faceSubdivision.js test/city/strategies/faceSubdivision.test.js
git commit -m "FaceSubdivision: recursive face splitting into blocks"
```

---

### Task 11: OffsetInfill growth

**Files:**
- Modify: `src/city/strategies/offsetInfill.js`
- Test: `test/city/strategies/offsetInfill.test.js`

**Step 1: Write the test**

Same pattern as Task 10 — verify roads increase after skeleton tick.

**Step 2: Implement offset curve logic**

Tick 2+:
1. For each skeleton road polyline, generate a parallel offset curve at `plotDepth` (30-40m) on each side
2. Clip offset curves to buildable land (check buildability at each point)
3. Where offset curves from different parent roads come within `plotDepth * 1.5`, add a perpendicular connecting road
4. Add all new roads via `addFeature`
5. Return true if new roads were added

Offset curve generation: for each segment of the polyline, compute the perpendicular direction, offset each point by `plotDepth` along the perpendicular. Handle inner-curve self-intersections by skipping points where the offset reverses.

**Step 3: Run test, commit**

```bash
git add src/city/strategies/offsetInfill.js test/city/strategies/offsetInfill.test.js
git commit -m "OffsetInfill: parallel offset curves with perpendicular connectors"
```

---

### Task 12: FrontagePressure growth

**Files:**
- Modify: `src/city/strategies/frontagePressure.js`
- Test: `test/city/strategies/frontagePressure.test.js`

**Step 1: Write the test**

Same pattern — verify roads increase.

**Step 2: Implement frontage pressure logic**

Tick 2+:
1. For each road, compute frontage on both sides (cells within `plotDepth` that are buildable and not occupied)
2. Track "filled" frontage (cells where plots would be placed — use buildability < threshold as proxy)
3. When filled frontage on one side exceeds `backLaneThreshold` (e.g. 60% filled for 50+ meters), pathfind a back lane at `plotDepth` distance from the road
4. When a road segment has no cross street for > `blockLengthMax` (e.g. 80m), insert a perpendicular cross street connecting to the nearest parallel road
5. Add all new roads via `addFeature`
6. Return true if new roads were added

**Step 3: Run test, commit**

```bash
git add src/city/strategies/frontagePressure.js test/city/strategies/frontagePressure.test.js
git commit -m "FrontagePressure: back lanes and cross streets from fill pressure"
```

---

### Task 13: TriangleMergeSubdiv growth

**Files:**
- Modify: `src/city/strategies/triangleMergeSubdiv.js`
- Test: `test/city/strategies/triangleMergeSubdiv.test.js`

**Step 1: Write the test**

Same pattern — verify roads increase.

**Step 2: Implement triangle merge + subdivision logic**

Tick 2:
1. Extract faces from graph
2. Find pairs of adjacent triangular faces (sharing an edge)
3. Remove the shared edge to merge them into a quad
4. Record merged quads for subdivision in next tick

Tick 3+:
1. For each quad face larger than target block size:
   - Find the two longest edges
   - Connect their midpoints with a new road (A* pathfound)
   - This splits the quad into two smaller quads
2. Recurse until faces reach block size
3. Return true if any faces were split

**Step 3: Run test, commit**

```bash
git add src/city/strategies/triangleMergeSubdiv.js test/city/strategies/triangleMergeSubdiv.test.js
git commit -m "TriangleMergeSubdiv: merge triangle pairs into quads then subdivide"
```

---

### Task 14: Info display and polish

**Files:**
- Modify: `src/ui/CompareScreen.js`

**Step 1: Add info display per strategy**

Show below each macro canvas:
- Road count
- Face count (simple faces)
- Total road length (sum of polyline lengths)

**Step 2: Add dispose() method**

Clean up event listeners, matching DebugScreen pattern.

**Step 3: Update URL on seed change**

```js
const url = new URL(location.href);
url.searchParams.set('seed', this.seed);
url.searchParams.set('mode', 'compare');
url.searchParams.set('gx', this.settlement.gx);
url.searchParams.set('gz', this.settlement.gz);
history.replaceState(null, '', url);
```

**Step 4: Test manually across multiple seeds**

Try seeds: 42, 202245, 12345, 999. Verify all 4 panels render, zoom works, layer switching works, Step button advances all strategies.

**Step 5: Commit**

```bash
git add src/ui/CompareScreen.js
git commit -m "CompareScreen: info display, dispose, URL state"
```

---

### Task 15: Full integration test

**Files:**
- Run: `npx vitest run`

**Step 1: Run full test suite**

Expected: All tests pass (existing 140 + new strategy tests + new clone tests).

**Step 2: Manual visual check**

Open compare view, try 3+ seeds. Verify:
- All 4 strategies produce visibly different results after tick 2+
- Zoom syncs across all 4 micro panels
- Layer selector applies to all 8 panels
- Step button advances all strategies
- Back button returns to region view

**Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "Growth strategy comparison: integration fixes"
```
