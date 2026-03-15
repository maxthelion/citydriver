# River Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rivers realistic — wider, sitting in valleys, meandering on flat terrain, cutting through mountain ranges via pre-planned corridors that terrain respects.

**Architecture:** Plan major river corridors after tectonics (A0b). Terrain generation suppresses ridges along corridors. Hydrology routes flow through corridors naturally, then carves valleys and applies meandering. All geology-aware.

**Tech Stack:** JavaScript/ES6 modules, Vitest, Grid2D, LayerStack

---

## Chunk 1: River Corridors and Terrain Integration

### Task 1: Implement planRiverCorridors

**Files:**
- Create: `src/regional/planRiverCorridors.js`
- Create: `test/regional/planRiverCorridors.test.js`

Picks 0-3 entry points on non-coastal edges, routes corridors to coast,
assigns synthetic accumulation. Outputs corridor polylines and a distance
field grid.

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Implement planRiverCorridors**

Key logic:
- Count corridors: `floor(rng.next() * 3)` biased by tectonic intensity
- Entry points: non-coastal edges, prefer edges perpendicular to coast
- Exit points: nearest coastal edge, with lateral offset
- Polyline: 3-5 control points with lateral noise, Chaikin smoothed
- Distance field: BFS from corridor cells, stored as `corridorDist` grid
- Corridor width: 8/15/25 cells based on importance

```js
export function planRiverCorridors(layers, rng) {
  // Returns { corridors: [...], corridorDist: Grid2D }
}
```

- [ ] **Step 3: Run tests, commit**

---

### Task 2: Modify generateTerrain to suppress ridges along corridors

**Files:**
- Modify: `src/regional/generateTerrain.js`
- Modify: `test/regional/terrain.test.js`

- [ ] **Step 1: Write test that terrain along corridor is lower than
same ridge position away from corridor**

- [ ] **Step 2: Add corridor suppression logic**

In the ridge computation section of generateTerrain, read `corridorDist`
from layers. Apply:
```js
const corridorWidth = corridor.importance * 25; // cells
const suppress = corridorDist < corridorWidth
  ? Math.exp(-(corridorDist * corridorDist) / (2 * (corridorWidth/3) ** 2))
  : 0;
ridgeContribution *= (1 - suppress);
elevation -= corridor.importance * 15 * suppress;
```

- [ ] **Step 3: Run tests, commit**

---

### Task 3: Wire corridors into regional pipeline

**Files:**
- Modify: `src/regional/pipeline.js`

- [ ] **Step 1: Insert planRiverCorridors after tectonics (A0), before
geology (A1)**

```js
// After A0 tectonics:
const { corridors, corridorDist } = planRiverCorridors(layers, rng);
layers.setData('riverCorridors', corridors);
layers.setGrid('corridorDist', corridorDist);
```

Pass `corridorDist` to generateTerrain.

- [ ] **Step 2: Run pipeline integration test**
- [ ] **Step 3: Commit**

---

## Chunk 2: Wider Rivers and Valley Carving

### Task 4: Update river width formula

**Files:**
- Modify: `src/core/riverGeometry.js`
- Modify: `test/core/inheritRivers.test.js` (if width assertions exist)

- [ ] **Step 1: Update riverHalfWidth**

```js
// Old: clamp(sqrt(acc) / 8, 1.5, 25)
// New:
export function riverHalfWidth(accumulation) {
  return Math.max(2, Math.min(40, Math.sqrt(accumulation) / 5));
}
```

- [ ] **Step 2: Run tests, fix any width-dependent assertions, commit**

---

### Task 5: Add valley geometry functions to riverGeometry.js

**Files:**
- Modify: `src/core/riverGeometry.js`
- Create: `test/core/riverGeometry.test.js`

- [ ] **Step 1: Write tests for valleyHalfWidth, valleyDepth,
valleyProfile**

- [ ] **Step 2: Implement**

```js
export function valleyHalfWidth(accumulation) {
  return Math.max(30, Math.min(500, Math.sqrt(accumulation) * 1.5));
}

export function valleyDepth(accumulation) {
  return Math.max(1, Math.min(15, Math.sqrt(accumulation) / 20));
}

export function valleyProfile(nd) {
  if (nd < 0.3) return 1.0;
  if (nd < 0.8) return 1.0 - 0.7 * ((nd - 0.3) / 0.5);
  if (nd < 1.0) return 0.3 - 0.3 * ((nd - 0.8) / 0.2);
  return 0;
}

export function gorgeProfile(nd) {
  if (nd < 0.5) return 1.0;
  if (nd < 0.7) return 1.0 - ((nd - 0.5) / 0.2);
  return 0;
}
```

- [ ] **Step 3: Run tests, commit**

---

### Task 6: Implement valley carving

**Files:**
- Create: `src/regional/carveValleys.js`
- Create: `test/regional/carveValleys.test.js`

- [ ] **Step 1: Write tests**
- Verify elevation is lowered alongside rivers
- Verify hard rock produces narrower valleys than soft rock
- Verify gorge detection works (terrain rises on both sides)

- [ ] **Step 2: Implement carveValleys**

```js
export function carveValleys(riverPaths, elevation, erosionResistance, cellSize, seaLevel) {
  // Walk each river path
  // At each point: compute valley dimensions from accumulation
  // Modulate by erosionResistance at that cell
  // Detect gorges (terrain rises >10m on both sides within 200m)
  // Apply valley or gorge profile to terrain
  // min(existing, carved) — never raise terrain
}
```

- [ ] **Step 3: Run tests, commit**

---

### Task 7: Implement coastal floodplain flattening

**Files:**
- Modify: `src/regional/carveValleys.js` (add flattenCoastalFloodplains)
- Modify: `test/regional/carveValleys.test.js`

- [ ] **Step 1: Write test that terrain near river mouth is flatter than
upstream**

- [ ] **Step 2: Implement flattenCoastalFloodplains**

```js
export function flattenCoastalFloodplains(riverPaths, elevation, waterMask, erosionResistance, cellSize, seaLevel) {
  // For each river path point within 500m of coast:
  //   floodplainRadius = valleyHalfWidth * (1 + 2 * coastProximity)
  //   Flatten terrain toward river elevation within radius
  //   Soft rock = more flattening, hard rock = less
}
```

- [ ] **Step 3: Run tests, commit**

---

## Chunk 3: Meandering and Integration

### Task 8: Implement improved meandering

**Files:**
- Modify: `src/core/flowAccumulation.js` (replace smoothRiverPaths)
- Create: `test/core/meandering.test.js`

- [ ] **Step 1: Write tests**
- Verify flat terrain produces visible displacement
- Verify steep terrain produces no displacement
- Verify soft rock amplifies meanders
- Verify hard rock dampens meanders

- [ ] **Step 2: Implement new meandering**

Replace the current `smoothRiverPaths` with a post-process on vector
paths. The new approach:
- Compute local slope at each vertex
- Where slope < 0.03: sinusoidal displacement perpendicular to flow
- Amplitude = halfWidth × 3, wavelength = halfWidth × 12
- Transition blend over slope 0.03-0.08
- Geology: soft rock amplitude × 1.5, hard rock × 0.3

- [ ] **Step 3: Run tests, commit**

---

### Task 9: Wire valley carving and meandering into hydrology

**Files:**
- Modify: `src/regional/generateHydrology.js`
- Modify: `src/regional/pipeline.js`

- [ ] **Step 1: Integrate corridor accumulation**

In generateHydrology, after flow accumulation:
- Read `riverCorridors` from layers
- For each corridor, add its `entryAccumulation` to the flow
  accumulation grid at the entry point, then propagate downstream

- [ ] **Step 2: Call valley carving after stream extraction**

```js
// After extractStreams + smoothRiverPaths:
carveValleys(riverPaths, elevation, erosionResistance, cellSize, seaLevel);
flattenCoastalFloodplains(riverPaths, elevation, waterMask, erosionResistance, cellSize, seaLevel);
```

- [ ] **Step 3: Run full pipeline integration test**

Run: `npx vitest run test/regional/pipeline.test.js`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (except pre-existing failures)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: integrate valley carving and meandering into hydrology pipeline"
```
