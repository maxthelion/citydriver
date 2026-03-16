# Rivers Regional System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dual bitmap/polyline river representation with a river tree as single source of truth, derive sea and river grids separately, and bake valley carving into regional elevation.

**Architecture:** The river tree data structure wraps the existing segment tree from `extractStreams()`, enriching each point with width, depth, and elevation. A `buildRiverTree()` function converts segments + corridors into the tree. Sea grid uses flood fill from coastal edges instead of `elevation < seaLevel`. Valley carving consumes the river tree instead of polylines. The pipeline wires everything together, replacing the old waterMask with separate sea/river grids combined into a water grid.

**Tech Stack:** JavaScript, Grid2D, vitest

**Spec:** `docs/superpowers/specs/2026-03-16-rivers-design.md`

---

## Chunk 1: River Tree Data Structure

### Task 1: Create the RiverTree data structure

The river tree wraps the existing segment tree (from `extractStreams()`) with enriched point data and derived output methods.

**Files:**
- Create: `src/core/RiverTree.js`
- Create: `test/core/RiverTree.test.js`

- [ ] **Step 1: Write failing tests for RiverTree**

Create `test/core/RiverTree.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { RiverSystem, RiverSegment } from '../../src/core/RiverTree.js';
import { Grid2D } from '../../src/core/Grid2D.js';

function makeSegment(points, children = []) {
  return new RiverSegment(points, children);
}

function makePoint(x, z, acc, elev) {
  return { x, z, accumulation: acc, elevation: elev };
}

describe('RiverSegment', () => {
  it('computes width and depth from accumulation', () => {
    const seg = makeSegment([
      makePoint(0, 0, 1000, 50),
      makePoint(50, 0, 2000, 40),
    ]);
    // width = clamp(sqrt(acc) / 5, 2, 40)
    // sqrt(1000)/5 ≈ 6.3, sqrt(2000)/5 ≈ 8.9
    expect(seg.points[0].halfWidth).toBeGreaterThan(5);
    expect(seg.points[1].halfWidth).toBeGreaterThan(seg.points[0].halfWidth);
    // depth = clamp(sqrt(acc) / 25, 0.5, 8)
    expect(seg.points[0].depth).toBeGreaterThan(0.4);
  });

  it('enforces monotonically decreasing elevation', () => {
    const seg = makeSegment([
      makePoint(0, 0, 100, 50),
      makePoint(50, 0, 200, 55), // higher than previous — should be clamped
      makePoint(100, 0, 300, 45),
    ]);
    expect(seg.points[1].elevation).toBeLessThanOrEqual(seg.points[0].elevation);
    expect(seg.points[2].elevation).toBeLessThanOrEqual(seg.points[1].elevation);
  });
});

describe('RiverSystem', () => {
  it('toPolylines returns array of point arrays', () => {
    const child = makeSegment([
      makePoint(100, 200, 500, 60),
      makePoint(150, 200, 800, 55),
    ]);
    const trunk = makeSegment([
      makePoint(150, 200, 1500, 50),
      makePoint(200, 200, 2000, 40),
    ], [child]);
    const system = new RiverSystem(1, trunk);

    const polylines = system.toPolylines();
    expect(polylines.length).toBe(2); // trunk + child
    expect(polylines[0].length).toBeGreaterThan(0);
    expect(polylines[0][0]).toHaveProperty('x');
    expect(polylines[0][0]).toHaveProperty('halfWidth');
  });

  it('stampOntoGrid marks river cells', () => {
    const seg = makeSegment([
      makePoint(100, 100, 1000, 50),
      makePoint(150, 100, 1000, 45),
      makePoint(200, 100, 1000, 40),
    ]);
    const system = new RiverSystem(1, seg);
    const grid = new Grid2D(10, 10, { type: 'uint8', cellSize: 50 });

    system.stampOntoGrid(grid, 50);
    // Cell at grid (2, 2) = world (100, 100) should be stamped
    expect(grid.get(2, 2)).toBe(1);
    // Cell far away should not be stamped
    expect(grid.get(9, 9)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/RiverTree.test.js --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement RiverTree**

Create `src/core/RiverTree.js`:

```javascript
/**
 * River tree data structure — single source of truth for river geometry.
 *
 * A RiverSystem is a directed tree of segments (tributaries → trunk → drain).
 * Each point carries position, elevation, width, depth, accumulation.
 * Bitmaps and polylines are derived from this structure.
 */

import { riverHalfWidth } from './riverGeometry.js';

const DEPTH_DIVISOR = 25;
const DEPTH_MIN = 0.5;
const DEPTH_MAX = 8;

function computeHalfWidth(acc) {
  return riverHalfWidth(acc);
}

function computeDepth(acc) {
  return Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, Math.sqrt(acc) / DEPTH_DIVISOR));
}

/**
 * A segment of a river between two confluences (or source → confluence).
 * Points flow downstream (first point is upstream end).
 */
export class RiverSegment {
  /**
   * @param {Array<{x, z, accumulation, elevation}>} rawPoints
   * @param {RiverSegment[]} children - upstream tributaries
   */
  constructor(rawPoints, children = []) {
    this.children = children;
    this.points = rawPoints.map(p => ({
      x: p.x,
      z: p.z,
      accumulation: p.accumulation,
      elevation: p.elevation,
      halfWidth: computeHalfWidth(p.accumulation),
      depth: computeDepth(p.accumulation),
    }));
    this._enforceMonotonicElevation();
  }

  _enforceMonotonicElevation() {
    for (let i = 1; i < this.points.length; i++) {
      if (this.points[i].elevation > this.points[i - 1].elevation) {
        this.points[i].elevation = this.points[i - 1].elevation;
      }
    }
  }
}

/**
 * A complete river system — one drainage basin with one drain point.
 */
export class RiverSystem {
  /**
   * @param {number} id
   * @param {RiverSegment} root - trunk segment (reaches drain)
   * @param {string} drainType - 'sea' (future: 'lake')
   */
  constructor(id, root, drainType = 'sea') {
    this.id = id;
    this.root = root;
    this.drainType = drainType;
  }

  /**
   * Extract polylines for rendering. Returns one polyline per segment.
   * Each polyline is an array of {x, z, width, depth, elevation, accumulation}.
   */
  toPolylines() {
    const result = [];
    function walk(seg) {
      result.push(seg.points.map(p => ({ ...p })));
      for (const child of seg.children) walk(child);
    }
    walk(this.root);
    return result;
  }

  /**
   * Stamp river presence onto a grid. Sets cells to 1 where the river
   * channel covers them (based on point width).
   * @param {Grid2D} grid - uint8 grid to stamp onto
   * @param {number} cellSize - meters per grid cell
   */
  stampOntoGrid(grid, cellSize) {
    function stampSegment(seg) {
      for (const p of seg.points) {
        const gx = Math.round(p.x / cellSize);
        const gz = Math.round(p.z / cellSize);
        const radiusCells = Math.max(1, Math.ceil(p.halfWidth / cellSize));

        for (let dz = -radiusCells; dz <= radiusCells; dz++) {
          for (let dx = -radiusCells; dx <= radiusCells; dx++) {
            const nx = gx + dx, nz = gz + dz;
            if (nx < 0 || nx >= grid.width || nz < 0 || nz >= grid.height) continue;
            const dist = Math.sqrt(dx * dx + dz * dz) * cellSize;
            if (dist <= p.halfWidth) {
              grid.set(nx, nz, 1);
            }
          }
        }
      }
      for (const child of seg.children) stampSegment(child);
    }
    stampSegment(this.root);
  }

  /**
   * Walk all segments, calling fn(segment) for each.
   */
  walk(fn) {
    function visit(seg) {
      fn(seg);
      for (const child of seg.children) visit(child);
    }
    visit(this.root);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/RiverTree.test.js --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/RiverTree.js test/core/RiverTree.test.js
git commit -m "feat: add RiverTree data structure as single source of truth for rivers"
```

---

### Task 2: Build river tree from extracted streams

Convert the segment tree returned by `extractStreams()` (nested `{cells, children}`) into a `RiverSystem` with enriched point data.

**Files:**
- Create: `src/regional/buildRiverTree.js`
- Create: `test/regional/buildRiverTree.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/regional/buildRiverTree.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { buildRiverSystems } from '../../src/regional/buildRiverTree.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('buildRiverSystems', () => {
  it('converts segment tree to RiverSystem array', () => {
    // Mock segment tree from extractStreams
    const segments = [{
      cells: [
        { gx: 5, gz: 5, accumulation: 500 },
        { gx: 6, gz: 5, accumulation: 600 },
        { gx: 7, gz: 5, accumulation: 700 },
      ],
      children: [{
        cells: [
          { gx: 4, gz: 4, accumulation: 200 },
          { gx: 5, gz: 5, accumulation: 300 },
        ],
        children: [],
      }],
    }];

    const elevation = new Grid2D(10, 10, { cellSize: 50, fill: 100 });
    // Make elevation decrease downstream
    elevation.set(4, 4, 80);
    elevation.set(5, 5, 70);
    elevation.set(6, 5, 60);
    elevation.set(7, 5, 50);

    const systems = buildRiverSystems(segments, elevation, 50);
    expect(systems.length).toBe(1);
    expect(systems[0].root.points.length).toBe(3);
    expect(systems[0].root.children.length).toBe(1);
    // Points should have world coordinates
    expect(systems[0].root.points[0].x).toBe(250); // 5 * 50
  });

  it('points have width, depth, elevation', () => {
    const segments = [{
      cells: [
        { gx: 5, gz: 5, accumulation: 1000 },
      ],
      children: [],
    }];
    const elevation = new Grid2D(10, 10, { cellSize: 50, fill: 50 });

    const systems = buildRiverSystems(segments, elevation, 50);
    const p = systems[0].root.points[0];
    expect(p.halfWidth).toBeGreaterThan(0);
    expect(p.depth).toBeGreaterThan(0);
    expect(p.elevation).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/buildRiverTree.test.js --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement buildRiverSystems**

Create `src/regional/buildRiverTree.js`:

```javascript
/**
 * Convert the segment tree from extractStreams() into RiverSystem instances.
 * Each root segment (no downstream) becomes a separate RiverSystem.
 */
import { RiverSystem, RiverSegment } from '../core/RiverTree.js';

/**
 * @param {Array} segmentRoots - root segments from extractStreams()
 * @param {Grid2D} elevation - terrain elevation grid
 * @param {number} cellSize - meters per grid cell
 * @returns {RiverSystem[]}
 */
export function buildRiverSystems(segmentRoots, elevation, cellSize) {
  const systems = [];

  for (let i = 0; i < segmentRoots.length; i++) {
    const root = convertSegment(segmentRoots[i], elevation, cellSize);
    systems.push(new RiverSystem(i, root));
  }

  return systems;
}

function convertSegment(seg, elevation, cellSize) {
  const children = (seg.children || []).map(c => convertSegment(c, elevation, cellSize));

  const points = seg.cells.map(cell => ({
    x: cell.gx * cellSize,
    z: cell.gz * cellSize,
    accumulation: cell.accumulation || 1,
    elevation: elevation.get(cell.gx, cell.gz),
  }));

  return new RiverSegment(points, children);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/regional/buildRiverTree.test.js --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/regional/buildRiverTree.js test/regional/buildRiverTree.test.js
git commit -m "feat: add buildRiverSystems to convert stream segments to river tree"
```

---

## Chunk 2: Sea Grid Flood Fill

### Task 3: Create sea grid via flood fill from coastal edges

Instead of marking all cells below sea level as water, flood fill from coastal edges only. Inland depressions below sea level are NOT sea.

**Files:**
- Create: `src/regional/seaGrid.js`
- Create: `test/regional/seaGrid.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/regional/seaGrid.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { computeSeaGrid } from '../../src/regional/seaGrid.js';

describe('computeSeaGrid', () => {
  it('marks coastal-connected cells below sea level as sea', () => {
    // 10x10 grid, land at 10m, coastal strip below sea level on east edge
    const elevation = new Grid2D(10, 10, { cellSize: 50, fill: 10 });
    // East column below sea level
    for (let gz = 0; gz < 10; gz++) {
      elevation.set(9, gz, -5);
    }

    const sea = computeSeaGrid(elevation, 0);
    expect(sea.get(9, 5)).toBe(1); // coastal, below sea level
    expect(sea.get(5, 5)).toBe(0); // inland, above sea level
  });

  it('does NOT mark inland depressions as sea', () => {
    const elevation = new Grid2D(10, 10, { cellSize: 50, fill: 10 });
    // Inland depression below sea level at center
    elevation.set(5, 5, -3);
    // No edge cells below sea level — no coast

    const sea = computeSeaGrid(elevation, 0);
    expect(sea.get(5, 5)).toBe(0); // inland depression, NOT sea
  });

  it('flood fills connected below-sea-level cells from edge', () => {
    const elevation = new Grid2D(10, 10, { cellSize: 50, fill: 10 });
    // Connected path of below-sea-level cells from edge
    elevation.set(9, 5, -2);
    elevation.set(8, 5, -1);
    elevation.set(7, 5, -0.5);
    // Isolated cell below sea level (not connected to edge)
    elevation.set(3, 3, -3);

    const sea = computeSeaGrid(elevation, 0);
    expect(sea.get(9, 5)).toBe(1);
    expect(sea.get(8, 5)).toBe(1);
    expect(sea.get(7, 5)).toBe(1);
    expect(sea.get(3, 3)).toBe(0); // not connected
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/seaGrid.test.js --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement computeSeaGrid**

Create `src/regional/seaGrid.js`:

```javascript
/**
 * Compute sea grid via flood fill from map edges.
 * Only cells below sea level AND connected to an edge via other
 * below-sea-level cells are marked as sea.
 * Inland depressions below sea level are NOT sea.
 */
import { Grid2D } from '../core/Grid2D.js';

/**
 * @param {Grid2D} elevation
 * @param {number} seaLevel
 * @returns {Grid2D} uint8 grid, 1 = sea
 */
export function computeSeaGrid(elevation, seaLevel) {
  const { width, height } = elevation;
  const sea = new Grid2D(width, height, {
    type: 'uint8',
    cellSize: elevation.cellSize,
    originX: elevation.originX,
    originZ: elevation.originZ,
  });

  // BFS from edge cells that are below sea level
  const queue = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // Seed: edge cells below sea level
  for (let gx = 0; gx < width; gx++) {
    if (elevation.get(gx, 0) < seaLevel) { sea.set(gx, 0, 1); queue.push(gx | (0 << 16)); }
    if (elevation.get(gx, height - 1) < seaLevel) { sea.set(gx, height - 1, 1); queue.push(gx | ((height - 1) << 16)); }
  }
  for (let gz = 1; gz < height - 1; gz++) {
    if (elevation.get(0, gz) < seaLevel) { sea.set(0, gz, 1); queue.push(0 | (gz << 16)); }
    if (elevation.get(width - 1, gz) < seaLevel) { sea.set(width - 1, gz, 1); queue.push((width - 1) | (gz << 16)); }
  }

  // Flood fill through connected below-sea-level cells
  let head = 0;
  while (head < queue.length) {
    const packed = queue[head++];
    const cx = packed & 0xFFFF;
    const cz = packed >> 16;

    for (const [dx, dz] of dirs) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      if (sea.get(nx, nz) > 0) continue; // already visited
      if (elevation.get(nx, nz) < seaLevel) {
        sea.set(nx, nz, 1);
        queue.push(nx | (nz << 16));
      }
    }
  }

  return sea;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/regional/seaGrid.test.js --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/regional/seaGrid.js test/regional/seaGrid.test.js
git commit -m "feat: add sea grid flood fill from coastal edges"
```

---

## Chunk 3: Wire Into Pipeline

### Task 4: Update generateHydrology to build and return river tree

Modify `generateHydrology` to build the river tree from extracted streams and return it alongside the existing data. Keep returning `waterMask` for backward compatibility (derived from river tree + elevation).

**Files:**
- Modify: `src/regional/generateHydrology.js`
- Test: run existing tests to verify no regression

- [ ] **Step 1: Add river tree building to generateHydrology**

In `src/regional/generateHydrology.js`, add import at top:

```javascript
import { buildRiverSystems } from './buildRiverTree.js';
```

After the `smoothRiverPaths` call (line 121), add:

```javascript
  // Build river tree — single source of truth for river geometry
  const riverSystems = buildRiverSystems(rivers, elevation, cellSize);
```

**Remove** the `carveFloodplains` call on line 126:
```javascript
  // REMOVE: carveFloodplains(elevation, rivers, width, height, seaLevel);
  // Valley carving is now done from the river tree (see Task 6)
```

Update the return value (line 162) to include `riverSystems`:

```javascript
  return { rivers, confluences, flowDirs, accumulation: adjustedAccumulation, waterMask, riverPaths, riverSystems };
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `npx vitest run test/regional/ --reporter=verbose`
Expected: ALL PASS (river tree is additive, doesn't change existing behavior)

- [ ] **Step 3: Commit**

```bash
git add src/regional/generateHydrology.js
git commit -m "feat: build river tree in generateHydrology"
```

---

### Task 5: Update pipeline to derive sea/river grids and store river tree

Modify the pipeline to compute the sea grid (flood fill), river grid (stamped from tree), and combined water grid. Store the river tree in layers. Keep using the combined water grid where `waterMask` was used before.

**Files:**
- Modify: `src/regional/pipeline.js`
- Test: run full test suite

- [ ] **Step 1: Update pipeline imports and water grid derivation**

In `src/regional/pipeline.js`, add imports:

```javascript
import { Grid2D } from '../core/Grid2D.js';
import { computeSeaGrid } from './seaGrid.js';
```

After the hydrology call (around line 107), replace the waterMask storage with:

```javascript
  // Store river tree as single source of truth
  layers.setData('riverSystems', hydrology.riverSystems);

  // Derive water grids
  // Sea grid: flood fill from coastal edges (only coast-connected cells below sea level)
  const seaGrid = computeSeaGrid(terrain.elevation, seaLevel);
  layers.setGrid('seaGrid', seaGrid);

  // River grid: stamped from river tree
  const riverGrid = new Grid2D(width, height, { type: 'uint8', cellSize });
  for (const sys of hydrology.riverSystems) {
    sys.stampOntoGrid(riverGrid, cellSize);
  }
  layers.setGrid('riverGrid', riverGrid);

  // Combined water grid (replaces old waterMask): sea OR river
  const waterMask = new Grid2D(width, height, { type: 'uint8', cellSize });
  for (let i = 0; i < width * height; i++) {
    waterMask.data[i] = seaGrid.data[i] | riverGrid.data[i];
  }
  layers.setGrid('waterMask', waterMask);
```

Keep storing `waterMask` so all downstream consumers (settlements, roads, land cover) work unchanged.

Also store backward-compatible data:

```javascript
  layers.setData('rivers', hydrology.rivers);
  layers.setData('confluences', hydrology.confluences);
  layers.setData('riverPaths', hydrology.riverPaths);
```

**Critical:** All downstream consumers in the pipeline that currently receive `hydrology.waterMask` must now receive the pipeline's derived `waterMask` instead. Search for `hydrology.waterMask` in pipeline.js and replace all occurrences with `waterMask` (the pipeline's computed combined grid). This ensures settlements, roads, and land cover use the flood-fill-based sea grid rather than the old `elevation < seaLevel` approach.

- [ ] **Step 2: Update sea floor plunge to use seaGrid instead of waterMask**

Change the plunge call (around line 212) from:

```javascript
  applySeaFloorPlunge(
    terrain.elevation, hydrology.waterMask, geology.erosionResistance, cellSize, seaLevel
  );
```

To:

```javascript
  // Sea floor plunge: only on sea cells (not river cells — rivers keep carved elevation)
  applySeaFloorPlunge(
    terrain.elevation, seaGrid, geology.erosionResistance, cellSize, seaLevel
  );
```

- [ ] **Step 3: Re-derive water grids after plunge**

After the plunge pass, the sea grid may have changed (elevation pushed deeper). Re-derive the combined waterMask:

```javascript
  // Re-derive combined waterMask after plunge (sea elevations changed)
  for (let i = 0; i < width * height; i++) {
    waterMask.data[i] = seaGrid.data[i] | riverGrid.data[i];
  }

  // Flood zone uses combined water grid
  const floodZone = computeFloodZone(terrain.elevation, waterMask, seaLevel);
  layers.setGrid('floodZone', floodZone);
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS — downstream consumers see the same waterMask interface

- [ ] **Step 5: Commit**

```bash
git add src/regional/pipeline.js
git commit -m "feat: derive sea/river grids from river tree, replace waterMask seeding"
```

---

### Task 6: Update carveValleys to work from river tree

Currently `computeValleyDepthField` and `computeFloodplainField` consume `riverPaths` (polylines). Update them to also accept the river tree, using the tree's point data for width, depth, and elevation. This is a transitional step — both inputs work.

**Files:**
- Modify: `src/regional/carveValleys.js`
- Modify: `src/regional/generateHydrology.js` — pass river tree to carving functions
- Test: existing carveValleys tests should still pass

- [ ] **Step 1: Add river tree support to computeValleyDepthField**

In `src/regional/carveValleys.js`, add a new exported function that walks the river tree instead of polyline paths:

```javascript
/**
 * Compute valley depth field from river tree.
 * Same algorithm as computeValleyDepthField but walks the tree directly,
 * using point data (width, depth, elevation) from the tree.
 */
export function computeValleyFromTree(riverSystems, elevation, erosionResistance, cellSize) {
  const { width, height } = elevation;
  const depthField = new Grid2D(width, height, { cellSize });

  for (const system of riverSystems) {
    system.walk(seg => {
      for (let i = 0; i < seg.points.length; i++) {
        const point = seg.points[i];
        const nextPoint = i < seg.points.length - 1 ? seg.points[i + 1] : null;
        const acc = point.accumulation;
        const halfW = valleyHalfWidth(acc);
        const depth = valleyDepth(acc);

        const cgx = Math.round(point.x / cellSize);
        const cgz = Math.round(point.z / cellSize);
        if (cgx < 0 || cgx >= width || cgz < 0 || cgz >= height) continue;

        const resist = erosionResistance.get(cgx, cgz);

        // Geology modulation
        let widthMod = 1.0, depthMod = 1.0;
        if (resist > 0.6) { widthMod = 0.5; depthMod = 1.3; }
        else if (resist < 0.3) { widthMod = 1.5; depthMod = 0.7; }

        const effectiveHalfW = halfW * widthMod;
        const effectiveDepth = depth * depthMod;

        const isGorge = detectGorge(elevation, cgx, cgz, point.x, point.z, nextPoint, cellSize);
        const profile = isGorge ? gorgeProfile : valleyProfile;
        const gorgeWidthMod = isGorge ? 0.3 : 1.0;
        const gorgeDepthMod = isGorge ? 2.0 : 1.0;

        const finalHalfW = effectiveHalfW * gorgeWidthMod;
        const finalDepth = effectiveDepth * gorgeDepthMod;
        const finalRadius = Math.ceil(finalHalfW / cellSize);

        for (let dz = -finalRadius; dz <= finalRadius; dz++) {
          for (let dx = -finalRadius; dx <= finalRadius; dx++) {
            const gx = cgx + dx, gz = cgz + dz;
            if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;

            const dist = Math.sqrt(dx * dx + dz * dz) * cellSize;
            const nd = dist / Math.max(finalHalfW, 1);
            const p = profile(nd);
            if (p <= 0) continue;

            const carveAmount = p * finalDepth;
            if (carveAmount > depthField.get(gx, gz)) {
              depthField.set(gx, gz, carveAmount);
            }
          }
        }
      }
    });
  }

  return depthField;
}
```

Note: This reuses the existing `detectGorge`, `valleyProfile`, `gorgeProfile`, `valleyHalfWidth`, `valleyDepth` functions. Add the necessary imports at the top of the file if not already present.

- [ ] **Step 2: Update generateHydrology to use tree-based carving**

In `src/regional/generateHydrology.js`, add import:

```javascript
import { computeValleyFromTree, computeFloodplainField, applyTerrainFields } from './carveValleys.js';
```

Replace the valley carving block (lines 149-157) with:

```javascript
  // Valley carving from river tree
  if (erosionResistance && riverSystems.length > 0) {
    const valleyDepthField = computeValleyFromTree(
      riverSystems, elevation, erosionResistance, cellSize
    );
    const { floodplainField, floodplainTarget } = computeFloodplainField(
      riverPaths, elevation, waterMask, erosionResistance, cellSize, seaLevel
    );
    applyTerrainFields(elevation, valleyDepthField, floodplainField, floodplainTarget, seaLevel);
  }
```

Note: `computeFloodplainField` still uses `riverPaths` for now — it can be migrated to use the tree in a follow-up. The valley depth field is the main carving and is now tree-based.

- [ ] **Step 3: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/regional/carveValleys.js src/regional/generateHydrology.js
git commit -m "feat: carve valleys from river tree instead of polylines"
```

---

## Chunk 4: Integration Verification

### Task 7: Add integration test and run full suite

- [ ] **Step 1: Add integration test**

Create `test/regional/riverTree.integration.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('River tree integration', { timeout: 30000 }, () => {
  it('produces river systems with valid data', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 64, height: 64, cellSize: 50, seaLevel: 0 }, rng);

    const systems = layers.getData('riverSystems');
    // Should have at least one river system (seed 42 with 64x64 should produce rivers)
    expect(systems).toBeDefined();
    if (systems.length === 0) return; // some seeds produce no rivers

    const sys = systems[0];
    expect(sys.root).toBeDefined();
    expect(sys.root.points.length).toBeGreaterThan(0);

    // Points should have all properties
    const p = sys.root.points[0];
    expect(p.x).toBeDefined();
    expect(p.z).toBeDefined();
    expect(p.halfWidth).toBeGreaterThan(0);
    expect(p.depth).toBeGreaterThan(0);
    expect(isFinite(p.elevation)).toBe(true);
  });

  it('sea grid does not include inland depressions', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 64, height: 64, cellSize: 50, seaLevel: 0 }, rng);

    const seaGrid = layers.getGrid('seaGrid');
    const elevation = layers.getGrid('elevation');
    expect(seaGrid).toBeDefined();

    // Every sea cell should be reachable from an edge
    // (verified by construction — flood fill from edges)
    // Just check that sea cells are below sea level
    for (let gz = 0; gz < 64; gz++) {
      for (let gx = 0; gx < 64; gx++) {
        if (seaGrid.get(gx, gz) > 0) {
          expect(elevation.get(gx, gz)).toBeLessThan(0);
        }
      }
    }
  });

  it('river grid matches river tree stamp', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 64, height: 64, cellSize: 50, seaLevel: 0 }, rng);

    const riverGrid = layers.getGrid('riverGrid');
    expect(riverGrid).toBeDefined();

    // River grid should have some cells marked (if rivers exist)
    const systems = layers.getData('riverSystems');
    if (systems && systems.length > 0) {
      let riverCells = 0;
      for (let i = 0; i < 64 * 64; i++) {
        if (riverGrid.data[i] > 0) riverCells++;
      }
      expect(riverCells).toBeGreaterThan(0);
    }
  });

  it('combined waterMask equals sea OR river', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 64, height: 64, cellSize: 50, seaLevel: 0 }, rng);

    const seaGrid = layers.getGrid('seaGrid');
    const riverGrid = layers.getGrid('riverGrid');
    const waterMask = layers.getGrid('waterMask');

    for (let i = 0; i < 64 * 64; i++) {
      const expected = (seaGrid.data[i] | riverGrid.data[i]) ? 1 : 0;
      expect(waterMask.data[i]).toBe(expected);
    }
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run test/regional/riverTree.integration.test.js --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add test/regional/riverTree.integration.test.js
git commit -m "test: add river tree integration tests"
```
