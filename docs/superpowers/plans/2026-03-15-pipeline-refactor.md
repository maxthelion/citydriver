# Pipeline Refactor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the city pipeline so FeatureMap is a layer bag with no side effects, each pipeline step is a standalone function, and composite masks are built explicitly.

**Architecture:** Remove `addFeature` side effects from FeatureMap. Extract each pipeline tick into a standalone function in `src/city/pipeline/`. Replace `buildability` with `terrainSuitability` (pure terrain) plus explicit composition functions. Each function signature is `(map, params?) → map`.

**Tech Stack:** JavaScript/ES6 modules, Vitest, Grid2D, FeatureMap, PlanarGraph

---

## Chunk 1: Layer Bag and Pipeline Function Extraction

### Task 1: Add layer bag to FeatureMap

**Files:**
- Modify: `src/core/FeatureMap.js`
- Modify: `test/core/FeatureMap.test.js`

- [ ] **Step 1: Write test for setLayer/getLayer/hasLayer**

Add to `test/core/FeatureMap.test.js`:

```js
describe('layer bag', () => {
  it('stores and retrieves named layers', () => {
    const map = makeMap();
    const grid = new Grid2D(50, 50, { type: 'float32' });
    grid.set(10, 10, 0.5);
    map.setLayer('testLayer', grid);

    expect(map.hasLayer('testLayer')).toBe(true);
    expect(map.getLayer('testLayer').get(10, 10)).toBe(0.5);
    expect(map.hasLayer('nonexistent')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/FeatureMap.test.js`
Expected: FAIL — `map.setLayer is not a function`

- [ ] **Step 3: Add setLayer/getLayer/hasLayer to FeatureMap**

In `src/core/FeatureMap.js`, add to the constructor:

```js
this.layers = new Map();
```

Add methods to the class:

```js
setLayer(name, grid) { this.layers.set(name, grid); }
getLayer(name) { return this.layers.get(name); }
hasLayer(name) { return this.layers.has(name); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/FeatureMap.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/FeatureMap.js test/core/FeatureMap.test.js
git commit -m "feat: add layer bag (setLayer/getLayer/hasLayer) to FeatureMap"
```

---

### Task 2: Add Grid2D composition utilities

**Files:**
- Modify: `src/core/Grid2D.js`
- Modify: `test/core/Grid2D.test.js`

- [ ] **Step 1: Write tests for combine and threshold**

Add to `test/core/Grid2D.test.js`:

```js
describe('composition utilities', () => {
  it('combine merges two grids cell-by-cell', () => {
    const a = new Grid2D(3, 3, { fill: 0.5 });
    const b = new Grid2D(3, 3, { fill: 0.3 });
    const result = Grid2D.combine(a, b, (va, vb) => va + vb);
    expect(result.get(1, 1)).toBeCloseTo(0.8);
    expect(result.width).toBe(3);
  });

  it('threshold converts to binary', () => {
    const g = new Grid2D(3, 3);
    g.set(0, 0, 0.1);
    g.set(1, 0, 0.5);
    g.set(2, 0, 0.9);
    const result = Grid2D.threshold(g, 0.5);
    expect(result.get(0, 0)).toBe(0);
    expect(result.get(1, 0)).toBe(1.0);
    expect(result.get(2, 0)).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/Grid2D.test.js`
Expected: FAIL — `Grid2D.combine is not a function`

- [ ] **Step 3: Implement combine and threshold**

Add static methods to `Grid2D` in `src/core/Grid2D.js`:

```js
static combine(a, b, fn) {
  return a.map((va, gx, gz) => fn(va, b.get(gx, gz)));
}

static threshold(grid, thresh) {
  return grid.map(v => v >= thresh ? 1.0 : 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/Grid2D.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/Grid2D.js test/core/Grid2D.test.js
git commit -m "feat: add Grid2D.combine and Grid2D.threshold static methods"
```

---

### Task 3: Add stampPolyline utility

**Files:**
- Modify: `src/core/Grid2D.js`
- Modify: `test/core/Grid2D.test.js`

This extracts the polyline stamping logic from `FeatureMap._stampRoad` into
a reusable static method so pipeline steps can stamp their own grids.

- [ ] **Step 1: Write test for stampPolyline**

Add to `test/core/Grid2D.test.js`:

```js
describe('stampPolyline', () => {
  it('stamps cells along a polyline within radius', () => {
    const grid = new Grid2D(20, 20, { type: 'uint8', cellSize: 10 });
    const polyline = [{ x: 0, z: 100 }, { x: 200, z: 100 }];
    Grid2D.stampPolyline(grid, polyline, 5, 1);

    // Cell at (10, 10) is at world (100, 100) — on the line
    expect(grid.get(10, 10)).toBe(1);
    // Cell at (10, 0) is at world (100, 0) — far from line
    expect(grid.get(10, 0)).toBe(0);
  });

  it('does not stamp out-of-bounds cells', () => {
    const grid = new Grid2D(10, 10, { type: 'uint8', cellSize: 10 });
    const polyline = [{ x: -50, z: 50 }, { x: 150, z: 50 }];
    // Should not throw
    Grid2D.stampPolyline(grid, polyline, 5, 1);
    expect(grid.get(5, 5)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/Grid2D.test.js`
Expected: FAIL — `Grid2D.stampPolyline is not a function`

- [ ] **Step 3: Implement stampPolyline**

Add to `src/core/Grid2D.js`. Extract the core loop from
`FeatureMap._stampRoad` (lines 265-318). The method mutates the grid
in-place (it's a stamping operation, not a pure transform):

```js
/**
 * Stamp cells along a polyline within a radius.
 * Mutates grid in place — sets cells within radius of polyline to value.
 *
 * @param {Grid2D} grid - Grid to stamp onto
 * @param {Array<{x, z}>} polyline - World-coordinate polyline
 * @param {number} radius - World-unit radius around the line
 * @param {number} value - Value to set on stamped cells
 */
static stampPolyline(grid, polyline, radius, value) {
  if (!polyline || polyline.length < 2) return;

  const cs = grid.cellSize;
  const ox = grid.originX;
  const oz = grid.originZ;
  const stepSize = cs * 0.5;

  for (let i = 0; i < polyline.length - 1; i++) {
    const ax = polyline[i].x, az = polyline[i].z;
    const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 0.01) continue;

    const steps = Math.ceil(segLen / stepSize);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = ax + dx * t;
      const pz = az + dz * t;

      const effectiveRadius = Math.max(radius, cs * 0.75);
      const cellRadius = Math.ceil(effectiveRadius / cs);
      const cgx = Math.round((px - ox) / cs);
      const cgz = Math.round((pz - oz) / cs);

      for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
        for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
          const gx = cgx + ddx, gz = cgz + ddz;
          if (gx < 0 || gx >= grid.width || gz < 0 || gz >= grid.height) continue;
          const cellX = ox + gx * cs;
          const cellZ = oz + gz * cs;
          const distSq = (cellX - px) ** 2 + (cellZ - pz) ** 2;
          if (distSq <= effectiveRadius * effectiveRadius) {
            grid.set(gx, gz, value);
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/Grid2D.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/Grid2D.js test/core/Grid2D.test.js
git commit -m "feat: add Grid2D.stampPolyline static method"
```

---

### Task 4: Create composeMask.js

**Files:**
- Create: `src/core/composeMask.js`
- Create: `test/core/composeMask.test.js`

- [ ] **Step 1: Write tests for composeBuildability and composeResidentialMask**

Create `test/core/composeMask.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { composeBuildability, composeResidentialMask } from '../../src/core/composeMask.js';

function makeLayers(width = 10, height = 10) {
  const opts = { type: 'float32', cellSize: 5 };
  const map = {
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    _layers: new Map(),
  };

  const terrain = new Grid2D(width, height, { ...opts, fill: 0.8 });
  const water = new Grid2D(width, height, { type: 'uint8', cellSize: 5 });
  const roads = new Grid2D(width, height, { type: 'uint8', cellSize: 5 });

  map._layers.set('terrainSuitability', terrain);
  map._layers.set('waterMask', water);
  map._layers.set('roadGrid', roads);

  return map;
}

describe('composeBuildability', () => {
  it('returns terrain value for clear cells', () => {
    const map = makeLayers();
    const result = composeBuildability(map);
    expect(result.get(5, 5)).toBeCloseTo(0.8);
  });

  it('returns 0 for water cells', () => {
    const map = makeLayers();
    map.getLayer('waterMask').set(5, 5, 1);
    const result = composeBuildability(map);
    expect(result.get(5, 5)).toBe(0);
  });

  it('returns 0 for road cells', () => {
    const map = makeLayers();
    map.getLayer('roadGrid').set(5, 5, 1);
    const result = composeBuildability(map);
    expect(result.get(5, 5)).toBe(0);
  });
});

describe('composeResidentialMask', () => {
  it('returns 0 for cells outside development zones', () => {
    const map = makeLayers();
    const zones = new Grid2D(10, 10, { type: 'uint8' });
    map._layers.set('zoneGrid', zones);
    const result = composeResidentialMask(map);
    expect(result.get(5, 5)).toBe(0);
  });

  it('returns terrain value for zoned unreserved cells', () => {
    const map = makeLayers();
    const zones = new Grid2D(10, 10, { type: 'uint8' });
    zones.set(5, 5, 1);
    map._layers.set('zoneGrid', zones);
    const result = composeResidentialMask(map);
    expect(result.get(5, 5)).toBeCloseTo(0.8);
  });

  it('returns 0 for reserved cells', () => {
    const map = makeLayers();
    const zones = new Grid2D(10, 10, { type: 'uint8' });
    zones.set(5, 5, 1);
    const reservations = new Grid2D(10, 10, { type: 'uint8' });
    reservations.set(5, 5, 1); // reserved for some use
    map._layers.set('zoneGrid', zones);
    map._layers.set('reservationGrid', reservations);
    const result = composeResidentialMask(map);
    expect(result.get(5, 5)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/composeMask.test.js`
Expected: FAIL — cannot resolve `composeMask.js`

- [ ] **Step 3: Implement composeMask.js**

Create `src/core/composeMask.js`:

```js
/**
 * Explicit composition functions that build derived masks from source layers.
 *
 * Each function takes a map (with getLayer/hasLayer) and returns a new Grid2D.
 * No side effects — the map is read-only.
 */

/**
 * Build a buildability mask from terrain, water, and roads.
 * Returns terrain suitability with water and road cells zeroed.
 */
export function composeBuildability(map) {
  const terrain = map.getLayer('terrainSuitability');
  const water = map.getLayer('waterMask');
  const roads = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;

  return terrain.map((value, gx, gz) => {
    if (water.get(gx, gz) > 0) return 0;
    if (roads && roads.get(gx, gz) > 0) return 0;
    return value;
  });
}

/**
 * Build a residential placement mask.
 * Cells where ribbon layout and house placement may operate:
 * terrain suitable, not water, not road, in a development zone,
 * not reserved for other use.
 */
export function composeResidentialMask(map) {
  const terrain = map.getLayer('terrainSuitability');
  const water = map.getLayer('waterMask');
  const roads = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const zones = map.hasLayer('zoneGrid') ? map.getLayer('zoneGrid') : null;
  const reservations = map.hasLayer('reservationGrid')
    ? map.getLayer('reservationGrid') : null;

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/composeMask.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/composeMask.js test/core/composeMask.test.js
git commit -m "feat: add composeBuildability and composeResidentialMask"
```

---

### Task 5: Extract terrainSuitability computation

**Files:**
- Create: `src/core/terrainSuitability.js`
- Create: `test/core/terrainSuitability.test.js`

This extracts `FeatureMap._computeInitialBuildability` into a standalone
pure function that returns a Grid2D without mutating anything.

- [ ] **Step 1: Write test for computeTerrainSuitability**

Create `test/core/terrainSuitability.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { computeTerrainSuitability } from '../../src/core/terrainSuitability.js';

describe('computeTerrainSuitability', () => {
  it('returns high value for flat interior cells', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });

    const result = computeTerrainSuitability(elevation, slope, waterMask);
    expect(result.get(25, 25)).toBeGreaterThan(0.5);
  });

  it('returns 0 for edge cells', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });

    const result = computeTerrainSuitability(elevation, slope, waterMask);
    expect(result.get(0, 0)).toBe(0);
  });

  it('returns 0 for water cells', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    waterMask.set(25, 25, 1);

    const result = computeTerrainSuitability(elevation, slope, waterMask);
    expect(result.get(25, 25)).toBe(0);
  });

  it('returns low value for steep cells', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.6 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });

    const result = computeTerrainSuitability(elevation, slope, waterMask);
    expect(result.get(25, 25)).toBeLessThan(0.2);
  });

  it('does not mutate input grids', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    const origSlope = slope.get(25, 25);

    computeTerrainSuitability(elevation, slope, waterMask);
    expect(slope.get(25, 25)).toBe(origSlope);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/terrainSuitability.test.js`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement computeTerrainSuitability**

Create `src/core/terrainSuitability.js`. Extract the logic from
`FeatureMap._computeInitialBuildability` (lines 133-174 of FeatureMap.js)
but return a new grid instead of mutating `this.buildability`. Also include
the `slopeScore` function and the waterfront bonus from `_computeWaterDistance`:

```js
/**
 * Compute terrain suitability — pure function of terrain, not mutated
 * by features. This replaces FeatureMap._computeInitialBuildability.
 */
import { Grid2D } from './Grid2D.js';

// Buildability constants (meters)
const EDGE_MARGIN_M = 60;
const EDGE_TAPER_M = 160;
const WATERFRONT_RANGE_M = 200;
const WATERFRONT_BONUS = 0.3;
const WATER_DIST_CUTOFF_M = 300;

function slopeScore(slope) {
  if (slope < 0.05) return 1.0;
  if (slope < 0.15) return 0.9;
  if (slope < 0.3) return 0.7;
  if (slope < 0.5) return 0.4;
  if (slope < 0.7) return 0.15;
  return 0;
}

/**
 * BFS water distance from water cells, 4-connected.
 */
function computeWaterDistance(waterMask, cutoffCells) {
  const { width, height } = waterMask;
  const dist = new Grid2D(width, height, {
    type: 'float32',
    cellSize: waterMask.cellSize,
    fill: cutoffCells + 1,
  });

  const queue = [];
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (waterMask.get(gx, gz) > 0) {
        dist.set(gx, gz, 0);
        queue.push(gx | (gz << 16));
      }
    }
  }

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let head = 0;
  while (head < queue.length) {
    const packed = queue[head++];
    const cx = packed & 0xFFFF;
    const cz = packed >> 16;
    const cd = dist.get(cx, cz);
    if (cd >= cutoffCells) continue;

    for (const [dx, dz] of dirs) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      if (dist.get(nx, nz) > cd + 1) {
        dist.set(nx, nz, cd + 1);
        queue.push(nx | (nz << 16));
      }
    }
  }

  return dist;
}

/**
 * Compute terrain suitability grid.
 *
 * @param {Grid2D} elevation
 * @param {Grid2D} slope
 * @param {Grid2D} waterMask
 * @returns {{ suitability: Grid2D, waterDist: Grid2D }}
 */
export function computeTerrainSuitability(elevation, slope, waterMask) {
  const width = elevation.width;
  const height = elevation.height;
  const cellSize = elevation.cellSize;

  const edgeMargin = Math.round(EDGE_MARGIN_M / cellSize);
  const edgeTaper = Math.round(EDGE_TAPER_M / cellSize);
  const waterfrontRange = Math.round(WATERFRONT_RANGE_M / cellSize);
  const cutoffCells = Math.round(WATER_DIST_CUTOFF_M / cellSize);

  const waterDist = computeWaterDistance(waterMask, cutoffCells);

  const suitability = new Grid2D(width, height, {
    type: 'float32',
    cellSize,
    originX: elevation.originX,
    originZ: elevation.originZ,
  });

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const edgeDist = Math.min(gx, gz, width - 1 - gx, height - 1 - gz);
      if (edgeDist < edgeMargin) continue; // stays 0

      if (waterMask.get(gx, gz) > 0) continue; // stays 0

      let score = slopeScore(slope.get(gx, gz));

      // Edge taper
      if (edgeDist < edgeTaper) {
        score *= edgeDist / edgeTaper;
      }

      // Waterfront bonus
      const wd = waterDist.get(gx, gz);
      if (wd > 0 && wd < waterfrontRange) {
        score = Math.min(1, score + WATERFRONT_BONUS * (1 - wd / waterfrontRange));
      }

      suitability.set(gx, gz, score);
    }
  }

  return suitability;
}

export { computeWaterDistance };
```

Note: the function returns just the suitability grid. `waterDist` is
computed internally but also exported for use by other pipeline steps
(land value, nucleus placement). The caller can get it via the separate
export if needed. Actually — change the return to include both:

Return `{ suitability, waterDist }` so callers can store both as layers.
Update the function signature doc and the test accordingly:

```js
// In test — update to destructure:
const { suitability } = computeTerrainSuitability(elevation, slope, waterMask);
// then use suitability.get(...) instead of result.get(...)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/terrainSuitability.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/terrainSuitability.js test/core/terrainSuitability.test.js
git commit -m "feat: extract computeTerrainSuitability as standalone pure function"
```

---

### Task 6: Extract computeLandValue as standalone function

**Files:**
- Create: `src/city/pipeline/computeLandValue.js`
- Create: `test/city/pipeline/computeLandValue.test.js`

Move the logic from `FeatureMap.computeLandValue()` (lines 750-840 of
FeatureMap.js) into a standalone function that reads layers from the map
and sets the `landValue` layer.

- [ ] **Step 1: Write test**

Create `test/city/pipeline/computeLandValue.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { computeLandValue } from '../../../src/city/pipeline/computeLandValue.js';

function makeTestMap() {
  const width = 60, height = 60, cellSize = 5;
  const opts = { cellSize, originX: 0, originZ: 0 };
  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    nuclei: [{ gx: 30, gz: 30, type: 'market' }],
  };

  map.setLayer('elevation', new Grid2D(width, height, { ...opts, fill: 100 }));
  map.setLayer('slope', new Grid2D(width, height, { ...opts, fill: 0.02 }));
  map.setLayer('waterMask', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('terrainSuitability', new Grid2D(width, height, { ...opts, fill: 0.9 }));
  map.setLayer('waterDist', new Grid2D(width, height, { ...opts, fill: 100 }));

  return map;
}

describe('computeLandValue', () => {
  it('flat ground near nucleus has high value', () => {
    const map = makeTestMap();
    computeLandValue(map);
    expect(map.getLayer('landValue').get(30, 30)).toBeGreaterThan(0.7);
  });

  it('flat ground far from nucleus has lower value', () => {
    const map = makeTestMap();
    computeLandValue(map);
    const center = map.getLayer('landValue').get(30, 30);
    const far = map.getLayer('landValue').get(55, 55);
    expect(center).toBeGreaterThan(far);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    const result = computeLandValue(map);
    expect(result).toBe(map);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/computeLandValue.test.js`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement**

Create `src/city/pipeline/computeLandValue.js`. Move the logic from
`FeatureMap.computeLandValue()` but read layers via `map.getLayer()` and
write the result via `map.setLayer('landValue', grid)`. The function reads:
`slope`, `waterMask`, `waterDist`, `terrainSuitability`. It writes:
`landValue`. Copy the constants (LV_FLATNESS_WEIGHT etc.) into the new file.

Signature: `export function computeLandValue(map) { ... return map; }`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/computeLandValue.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/computeLandValue.js test/city/pipeline/computeLandValue.test.js
git commit -m "feat: extract computeLandValue as standalone pipeline function"
```

---

### Task 7: Extract extractZones as standalone pipeline function

**Files:**
- Create: `src/city/pipeline/extractZones.js`
- Create: `test/city/pipeline/extractZones.test.js`

This wraps the existing `extractDevelopmentZones` from `zoneExtraction.js`
as a pipeline function that reads layers and stores zones + zoneGrid on
the map.

- [ ] **Step 1: Write test**

Create `test/city/pipeline/extractZones.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { extractZones } from '../../../src/city/pipeline/extractZones.js';

function makeTestMap() {
  const width = 60, height = 60, cellSize = 5;
  const opts = { cellSize, originX: 0, originZ: 0 };
  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    nuclei: [{ gx: 30, gz: 30, type: 'market' }],
    developmentZones: [],
  };

  map.setLayer('slope', new Grid2D(width, height, { ...opts, fill: 0.02 }));
  map.setLayer('waterMask', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('roadGrid', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('landValue', new Grid2D(width, height, { ...opts, fill: 0.6 }));
  map.setLayer('terrainSuitability', new Grid2D(width, height, { ...opts, fill: 0.8 }));

  return map;
}

describe('extractZones', () => {
  it('produces development zones for buildable land near nucleus', () => {
    const map = makeTestMap();
    extractZones(map);
    expect(map.developmentZones.length).toBeGreaterThan(0);
  });

  it('sets zoneGrid layer', () => {
    const map = makeTestMap();
    extractZones(map);
    expect(map.hasLayer('zoneGrid')).toBe(true);
    // At least some cells should be in a zone
    let zoneCells = 0;
    const grid = map.getLayer('zoneGrid');
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) > 0) zoneCells++;
    expect(zoneCells).toBeGreaterThan(0);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    expect(extractZones(map)).toBe(map);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/extractZones.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `src/city/pipeline/extractZones.js`:

```js
import { Grid2D } from '../../core/Grid2D.js';
import { extractDevelopmentZones } from '../zoneExtraction.js';
import { composeBuildability } from '../../core/composeMask.js';

/**
 * Pipeline step: extract development zones from land value and terrain.
 * Reads: slope, waterMask, roadGrid, landValue, terrainSuitability, nuclei
 * Writes: developmentZones (array), zoneGrid (layer)
 */
export function extractZones(map) {
  // extractDevelopmentZones currently reads map.waterMask, map.landValue,
  // map.buildability, map.slope, map.roadGrid directly.
  // Create a compatibility shim that delegates to layers until
  // zoneExtraction.js is updated to use layers directly.
  const buildability = composeBuildability(map);
  const shim = {
    width: map.width,
    height: map.height,
    cellSize: map.cellSize,
    originX: map.originX,
    originZ: map.originZ,
    nuclei: map.nuclei,
    waterMask: map.getLayer('waterMask'),
    landValue: map.getLayer('landValue'),
    buildability,
    slope: map.getLayer('slope'),
    roadGrid: map.getLayer('roadGrid'),
    elevation: map.getLayer('elevation'),
  };

  const zones = extractDevelopmentZones(shim);
  map.developmentZones = zones;

  // Build zoneGrid — mark cells that belong to any zone
  const zoneGrid = new Grid2D(map.width, map.height, {
    type: 'uint8',
    cellSize: map.cellSize,
    originX: map.originX,
    originZ: map.originZ,
  });
  for (const zone of zones) {
    for (const cell of zone.cells) {
      zoneGrid.set(cell.gx, cell.gz, zone.id || 1);
    }
  }
  map.setLayer('zoneGrid', zoneGrid);

  return map;
}
```

Note: This uses a shim object to bridge between the old
`extractDevelopmentZones` (which reads `map.buildability` etc.) and the
new layer system. This is intentionally temporary — when we clean up
`zoneExtraction.js` in a later task, the shim goes away and the function
reads layers directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/extractZones.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/extractZones.js test/city/pipeline/extractZones.test.js
git commit -m "feat: extract extractZones as standalone pipeline function"
```

---

## Chunk 2: Wire Up Pipeline and Remove Old Code

### Task 8: Extract buildSkeletonRoads as pipeline function

**Files:**
- Create: `src/city/pipeline/buildSkeletonRoads.js`

The skeleton builder is the most complex step because it's stateful
internally (pathfinds roads sequentially, each affecting cost for the
next). This task wraps it as a pipeline function that:
1. Composes a buildability grid from layers
2. Calls the existing `buildSkeletonRoads` from `skeleton.js`
3. Stamps road results onto a new roadGrid layer
4. Sets the layer and appends features

- [ ] **Step 1: Create the pipeline wrapper**

Create `src/city/pipeline/buildSkeletonRoads.js`:

```js
import { buildSkeletonRoads as buildSkeleton } from '../skeleton.js';

/**
 * Pipeline step: build skeleton road network.
 * Reads: terrainSuitability, waterMask, elevation, slope, nuclei
 * Writes: roadGrid (layer), bridgeGrid (layer), roads (features), graph
 *
 * Internally stateful — pathfinds roads sequentially. From the pipeline's
 * perspective, this is a single function call.
 */
export function buildSkeletonRoads(map) {
  // skeleton.js currently reads map.buildability, map.waterMask, etc.
  // directly. It also calls map.addFeature which stamps roadGrid.
  // For now, delegate to the existing function unchanged.
  // This will be cleaned up in a later task when addFeature side effects
  // are removed.
  buildSkeleton(map);
  return map;
}
```

This is a thin wrapper for now. The skeleton builder still uses the old
interface internally — that gets cleaned up in Task 12.

- [ ] **Step 2: Verify existing skeleton test still passes**

Run: `npx vitest run test/city/skeleton.test.js`
Expected: PASS (no behaviour change)

- [ ] **Step 3: Commit**

```bash
git add src/city/pipeline/buildSkeletonRoads.js
git commit -m "feat: add buildSkeletonRoads pipeline wrapper"
```

---

### Task 9: Extract layoutRibbons and connectToNetwork as pipeline functions

**Files:**
- Create: `src/city/pipeline/layoutRibbons.js`
- Create: `src/city/pipeline/connectToNetwork.js`

Extract the `_layoutRibbons` and `_connectToNetwork` methods from
`LandFirstDevelopment` into standalone functions.

- [ ] **Step 1: Create layoutRibbons.js**

Create `src/city/pipeline/layoutRibbons.js`. Move the `_layoutRibbons`
method body from `landFirstDevelopment.js` (lines 59-108). Change `this.map`
to `map` and `this._zones` to `map.developmentZones`. Change
`this._addRoad` to a local helper that calls the same logic. Import the
ribbon layout functions from `../ribbonLayout.js`.

Signature: `export function layoutRibbons(map) { ... return map; }`

- [ ] **Step 2: Create connectToNetwork.js**

Create `src/city/pipeline/connectToNetwork.js`. Move the
`_connectToNetwork` method body from `landFirstDevelopment.js` (lines
111-160). Same conversion — `this.map` → `map`, inline the `_addRoad`
and `_findOrCreateNode` helpers.

Signature: `export function connectToNetwork(map) { ... return map; }`

- [ ] **Step 3: Verify existing landFirstDevelopment test still passes**

Run: `npx vitest run test/city/strategies/landFirstDevelopment.test.js -- --timeout 60000`
Expected: PASS (these are still called by the old class for now)

- [ ] **Step 4: Commit**

```bash
git add src/city/pipeline/layoutRibbons.js src/city/pipeline/connectToNetwork.js
git commit -m "feat: extract layoutRibbons and connectToNetwork as pipeline functions"
```

---

### Task 10: Rewrite LandFirstDevelopment as thin sequencer

**Files:**
- Modify: `src/city/strategies/landFirstDevelopment.js`
- Modify: `test/city/strategies/landFirstDevelopment.test.js`

Replace all inlined logic with calls to pipeline functions. Delete the
`_layoutRibbons`, `_connectToNetwork`, `_addRoad`, `_findOrCreateNode`
methods and the `_clipStreetToGrid` helper function.

- [ ] **Step 1: Rewrite the class**

Replace `src/city/strategies/landFirstDevelopment.js` with:

```js
import { buildSkeletonRoads } from '../pipeline/buildSkeletonRoads.js';
import { computeLandValue } from '../pipeline/computeLandValue.js';
import { extractZones } from '../pipeline/extractZones.js';
import { layoutRibbons } from '../pipeline/layoutRibbons.js';
import { connectToNetwork } from '../pipeline/connectToNetwork.js';

/**
 * Land-First Development strategy.
 * Thin sequencer — each tick calls a pipeline function.
 */
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
      case 4: this.map = layoutRibbons(this.map); return true;
      case 5: this.map = connectToNetwork(this.map); return true;
      default: return false;
    }
  }
}
```

Note: `reserveLandUse` is not included yet — that's Task 14 (Chunk 3).
The reservation tick will be inserted between extractZones and
layoutRibbons once it exists.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run test/city/strategies/landFirstDevelopment.test.js -- --timeout 60000`
Expected: PASS — same behaviour, different code structure

- [ ] **Step 3: Delete old _clipStreetToGrid from landFirstDevelopment.js**

Verify that `_clipStreetToGrid` has been moved into `layoutRibbons.js`
and is no longer in the old file. The old file should now be ~25 lines.

- [ ] **Step 4: Commit**

```bash
git add src/city/strategies/landFirstDevelopment.js
git commit -m "refactor: rewrite LandFirstDevelopment as thin pipeline sequencer"
```

---

### Task 11: Wire setup.js to set layers

**Files:**
- Modify: `src/city/setup.js`

Update `setupCity` to set named layers on the map in addition to (for now)
the old properties. This is preparation for removing the old properties.

- [ ] **Step 1: Add layer setting calls to setupCity**

After each grid is computed in `setupCity`, also call `map.setLayer()`:

```js
// After map.setTerrain(elevation, slope):
map.setLayer('elevation', elevation);
map.setLayer('slope', slope);

// After waterMask is populated:
map.setLayer('waterMask', map.waterMask);

// After classifyWater:
map.setLayer('waterType', map.waterType);

// After carveChannels (which recomputes slope and buildability):
// Compute terrainSuitability as the initial buildability (before features)
import { computeTerrainSuitability } from '../core/terrainSuitability.js';
const { suitability, waterDist } = computeTerrainSuitability(elevation, slope, map.waterMask);
map.setLayer('terrainSuitability', suitability);
map.setLayer('waterDist', waterDist);

// After computeWaterDepth:
map.setLayer('waterDepth', map.waterDepth);

// After computeLandValue:
map.setLayer('landValue', map.landValue);
```

Note: `computeTerrainSuitability` needs to be called after
`carveChannels()` because channel carving modifies elevation and slope.
The returned `suitability` grid is the pure terrain assessment.

Also note: `computeTerrainSuitability` returns `{ suitability, waterDist }`
— update the function accordingly if not already done.

- [ ] **Step 2: Run setup test**

Run: `npx vitest run test/city/setup.test.js`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/city/setup.js
git commit -m "feat: setup.js sets named layers on FeatureMap"
```

---

### Task 12: Update FeatureMap — remove addFeature side effects and old grids

**Files:**
- Modify: `src/core/FeatureMap.js`
- Modify: `test/core/FeatureMap.test.js`

This is the big cleanup. Remove `addFeature`, all `_stamp*` methods,
`_computeInitialBuildability`, `setTerrain`, `computeLandValue`, and the
hardcoded grid properties. FeatureMap becomes a layer bag + feature arrays
+ graph + metadata.

- [ ] **Step 1: Rewrite FeatureMap**

Keep: constructor (with `layers` Map, feature arrays, graph, metadata),
`setLayer`/`getLayer`/`hasLayer`, `clone`, `createPathCost`,
`classifyWater`, `carveChannels`, `computeWaterDepth`, `extractFaces`,
and the geometry helpers (`_polygonBounds`, `_pointInPolygon`,
`_traceContour`, `_simplifyContour`).

Remove: `addFeature`, `_stampRoad`, `_stampRiver`, `_stampPlot`,
`_stampBuilding`, `_computeInitialBuildability`, `setTerrain`,
`computeLandValue`, `_stampRoadValue`, `_computeWaterDistance`.

Remove from constructor: `this.buildability`, `this.waterMask`,
`this.bridgeGrid`, `this.roadGrid`, `this.landValue`, `this.waterType`,
`this.features`. Keep `this.roads`, `this.rivers`, `this.plots`,
`this.buildings`.

Update `createPathCost` to read from layers:
```js
createPathCost(preset = 'growth') {
  // ... same presets ...
  const elevation = this.getLayer('elevation');
  const roadGrid = this.getLayer('roadGrid');
  const bridgeGrid = this.getLayer('bridgeGrid');
  const waterDepth = this.getLayer('waterDepth');
  const waterType = this.getLayer('waterType');
  const buildability = composeBuildability(this);
  // ... rest of logic unchanged, using these locals ...
}
```

Import `composeBuildability` from `./composeMask.js`.

Update `classifyWater` to read `this.getLayer('waterMask')` and write
`this.setLayer('waterType', ...)`.

Update `carveChannels` to read `this.getLayer('elevation')` and
`this.getLayer('slope')`.

Update `computeWaterDepth` to read `this.getLayer('waterMask')` and
write `this.setLayer('waterDepth', ...)`.

Update `extractFaces` to read layers.

Update `clone` to clone all layers from the `layers` Map.

- [ ] **Step 2: Rewrite FeatureMap tests**

Update `test/core/FeatureMap.test.js` to use the new interface:
- Remove tests for `addFeature` side effects (buildability zeroing, etc.)
- Update remaining tests to use `map.getLayer()` instead of
  `map.buildability`, `map.roadGrid`, etc.
- The `makeMap` helper should set layers via `setLayer` and call
  `computeTerrainSuitability` instead of `setTerrain`.

- [ ] **Step 3: Update all consumers**

The following files read `map.buildability`, `map.roadGrid`, etc. directly.
Update each to use `map.getLayer('...')`:

**Active code (used by LandFirstDevelopment):**
- `src/city/setup.js` — reads `map.buildability` in `placeNuclei`.
  Replace with `composeBuildability(map)` or `map.getLayer('terrainSuitability')`.
  (Nucleus placement happens before roads exist, so terrainSuitability is
  equivalent to buildability at that point.)
- `src/city/zoneExtraction.js` — reads `map.waterMask`, `map.landValue`,
  `map.buildability`, `map.slope`, `map.roadGrid`. Already shimmed by
  `extractZones.js` pipeline wrapper (Task 7). Remove the shim and update
  `extractDevelopmentZones` to accept layers directly, or keep passing
  the shim object.
- `src/city/placeBuildings.js` — reads `map.buildability`, `map.waterMask`.
  Use `composeBuildability(map)` and `map.getLayer('waterMask')`.
- `src/rendering/debugLayers.js` — reads `map.buildability`, `map.roadGrid`,
  `map.waterMask`, etc. (~30 references). Mechanical find-and-replace:
  `map.buildability` → `map.getLayer('terrainSuitability')` (or compose),
  `map.roadGrid` → `map.getLayer('roadGrid')`, etc.
- `src/rendering/prepareCityScene.js` — reads `map.elevation`. Use
  `map.getLayer('elevation')`.
- `src/city/skeleton.js` — reads `map.buildability` via `createPathCost`.
  Already handled by updating `createPathCost`. Also calls `map.addFeature`
  — replace with `map.roads.push(...)` and `Grid2D.stampPolyline` on a
  working roadGrid.
- `src/city/skeletonStrategies.js` — reads `map.waterMask`,
  `map.buildability`. Update to use layers.
- `src/city/coverageLayers.js` — check if it reads any old properties.

**Archived strategies (not used in production, but should still compile):**
- `src/city/strategies/stripDevelopment.js`
- `src/city/strategies/desireLines.js`
- `src/city/strategies/frontagePressure.js`
- `src/city/strategies/faceSubdivision.js`
- `src/city/strategies/offsetInfill.js`
- `src/city/strategies/triangleMergeSubdiv.js`

These all call `map.addFeature('road', ...)` and read `map.buildability`
etc. Update them to use `map.roads.push(...)` and `map.getLayer(...)`.
Since they're not in the active pipeline, just make them compile — don't
worry about behavioural testing.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove addFeature side effects, replace buildability with layers"
```

---

### Task 13: Update skeleton.js to use layers internally

**Files:**
- Modify: `src/city/skeleton.js`
- Modify: `src/city/pipeline/buildSkeletonRoads.js`

Update the skeleton builder to create its own working roadGrid internally,
stamp each road as it goes (for the reuse discount), and output the
finished roadGrid as a layer.

- [ ] **Step 1: Update skeleton.js**

In `buildSkeletonRoads` (the function in `skeleton.js`):
- At the start, create a working roadGrid:
  ```js
  const roadGrid = new Grid2D(map.width, map.height, {
    type: 'uint8', cellSize: map.cellSize,
    originX: map.originX, originZ: map.originZ,
  });
  const bridgeGrid = new Grid2D(map.width, map.height, {
    type: 'uint8', cellSize: map.cellSize,
    originX: map.originX, originZ: map.originZ,
  });
  ```
- Replace `map.addFeature('road', ...)` calls with:
  ```js
  map.roads.push({ type: 'road', ...data });
  Grid2D.stampPolyline(roadGrid, data.polyline, (data.width || 6) / 2, 1);
  ```
- For bridge roads, also stamp bridgeGrid where waterMask is set.
- Update `createPathCost` calls to pass the working roadGrid (so the
  reuse discount works mid-build). This may mean passing roadGrid as a
  parameter or temporarily setting it as a layer.
- At the end, set both layers:
  ```js
  map.setLayer('roadGrid', roadGrid);
  map.setLayer('bridgeGrid', bridgeGrid);
  ```

- [ ] **Step 2: Update pipeline wrapper**

`src/city/pipeline/buildSkeletonRoads.js` can now be simplified — the
skeleton function handles layers directly.

- [ ] **Step 3: Run skeleton tests**

Run: `npx vitest run test/city/skeleton.test.js`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/skeleton.js src/city/pipeline/buildSkeletonRoads.js
git commit -m "refactor: skeleton builder manages own roadGrid internally"
```

---

## Chunk 3: Reservation Step and Cleanup

### Task 14: Add reserveLandUse pipeline step (stub)

**Files:**
- Create: `src/city/pipeline/reserveLandUse.js`
- Create: `test/city/pipeline/reserveLandUse.test.js`
- Modify: `src/city/strategies/landFirstDevelopment.js`

A stub that accepts an archetype and produces a reservationGrid. For now
it just creates an empty grid (no reservations). This validates the
pipeline slot works before implementing archetype logic.

- [ ] **Step 1: Write test**

Create `test/city/pipeline/reserveLandUse.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { reserveLandUse } from '../../../src/city/pipeline/reserveLandUse.js';

function makeTestMap() {
  const width = 60, height = 60, cellSize = 5;
  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    developmentZones: [],
  };
  map.setLayer('zoneGrid', new Grid2D(width, height, { type: 'uint8', cellSize }));
  return map;
}

describe('reserveLandUse', () => {
  it('sets reservationGrid layer', () => {
    const map = makeTestMap();
    reserveLandUse(map, null);
    expect(map.hasLayer('reservationGrid')).toBe(true);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    expect(reserveLandUse(map, null)).toBe(map);
  });

  it('produces empty grid when no archetype given', () => {
    const map = makeTestMap();
    reserveLandUse(map, null);
    const grid = map.getLayer('reservationGrid');
    let nonZero = 0;
    grid.forEach((gx, gz, v) => { if (v > 0) nonZero++; });
    expect(nonZero).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/reserveLandUse.test.js`
Expected: FAIL

- [ ] **Step 3: Implement stub**

Create `src/city/pipeline/reserveLandUse.js`:

```js
import { Grid2D } from '../../core/Grid2D.js';

/**
 * Pipeline step: reserve land for non-residential uses based on archetype.
 * Reads: zoneGrid, developmentZones
 * Writes: reservationGrid (layer)
 *
 * Reservation types (uint8 values in reservationGrid):
 *   0 = unreserved (available for residential)
 *   1 = commercial
 *   2 = industrial
 *   3 = civic
 *   4 = open space
 */
export const RESERVATION = {
  NONE: 0,
  COMMERCIAL: 1,
  INDUSTRIAL: 2,
  CIVIC: 3,
  OPEN_SPACE: 4,
};

export function reserveLandUse(map, archetype) {
  const grid = new Grid2D(map.width, map.height, {
    type: 'uint8',
    cellSize: map.cellSize,
    originX: map.originX,
    originZ: map.originZ,
  });

  if (archetype) {
    // TODO: implement archetype-driven reservation logic
    // See specs/v5/city-archetypes.md
  }

  map.setLayer('reservationGrid', grid);
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/reserveLandUse.test.js`
Expected: PASS

- [ ] **Step 5: Insert into LandFirstDevelopment sequencer**

Update `src/city/strategies/landFirstDevelopment.js` to add the
reservation tick between extractZones and layoutRibbons:

```js
import { reserveLandUse } from '../pipeline/reserveLandUse.js';

// In tick():
case 4: this.map = reserveLandUse(this.map, this.archetype); return true;
case 5: this.map = layoutRibbons(this.map); return true;
case 6: this.map = connectToNetwork(this.map); return true;
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/city/pipeline/reserveLandUse.js test/city/pipeline/reserveLandUse.test.js src/city/strategies/landFirstDevelopment.js
git commit -m "feat: add reserveLandUse pipeline step (stub)"
```

---

### Task 15: Update layoutRibbons to respect reservations

**Files:**
- Modify: `src/city/pipeline/layoutRibbons.js`

Update `layoutRibbons` to use `composeResidentialMask` instead of raw
buildability/zone checks. This means ribbons only get placed on cells
that are in a development zone, not reserved, and terrain-suitable.

- [ ] **Step 1: Update layoutRibbons to use composeResidentialMask**

In `src/city/pipeline/layoutRibbons.js`, at the start of the function:

```js
import { composeResidentialMask } from '../../core/composeMask.js';

export function layoutRibbons(map) {
  const residentialMask = composeResidentialMask(map);
  // Use residentialMask instead of map.buildability/map.roadGrid
  // in the _clipStreetToGrid function
  // ...
}
```

Update `_clipStreetToGrid` (or its equivalent) to check `residentialMask`
instead of `roadGrid` + `waterMask` separately.

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/city/strategies/landFirstDevelopment.test.js -- --timeout 60000`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/city/pipeline/layoutRibbons.js
git commit -m "feat: layoutRibbons uses composeResidentialMask"
```

---

### Task 16: Update debugLayers.js to use layers

**Files:**
- Modify: `src/rendering/debugLayers.js`

Mechanical find-and-replace. Each `map.X` reference becomes
`map.getLayer('X')`. Add a null check since some layers may not exist
at all ticks.

- [ ] **Step 1: Replace all direct property access**

Replacements:
- `map.elevation` → `map.getLayer('elevation')`
- `map.slope` → `map.getLayer('slope')`
- `map.buildability` → `map.getLayer('terrainSuitability')`
  (or compose if needed)
- `map.waterMask` → `map.getLayer('waterMask')`
- `map.waterType` → `map.getLayer('waterType')`
- `map.bridgeGrid` → `map.getLayer('bridgeGrid')`
- `map.roadGrid` → `map.getLayer('roadGrid')`
- `map.landValue` → `map.getLayer('landValue')`
- `map.waterDepth` → `map.getLayer('waterDepth')`

Add `if (!layer) return;` guards at the top of each renderer since layers
are set progressively through the pipeline.

Also add a new renderer for reservationGrid:

```js
export function renderReservations(ctx, map) {
  const grid = map.getLayer('reservationGrid');
  if (!grid) return;
  const colors = {
    1: 'rgba(255, 165, 0, 0.6)',  // commercial — orange
    2: 'rgba(128, 128, 128, 0.6)', // industrial — gray
    3: 'rgba(0, 0, 255, 0.6)',     // civic — blue
    4: 'rgba(0, 200, 0, 0.6)',     // open space — green
  };
  for (let gz = 0; gz < map.height; gz++) {
    for (let gx = 0; gx < map.width; gx++) {
      const v = grid.get(gx, gz);
      if (v > 0 && colors[v]) {
        ctx.fillStyle = colors[v];
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }
}
```

Register it in the LAYERS array.

- [ ] **Step 2: Run rendering test**

Run: `npx vitest run test/rendering/prepareCityScene.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/rendering/debugLayers.js
git commit -m "refactor: debugLayers reads from named layers"
```

---

### Task 17: Update prepareCityScene.js

**Files:**
- Modify: `src/rendering/prepareCityScene.js`

- [ ] **Step 1: Replace map.elevation with map.getLayer('elevation')**

Mechanical replacement — `map.elevation` → `map.getLayer('elevation')` in
all references (lines 36, 55, 60, 143 approximately).

- [ ] **Step 2: Run test**

Run: `npx vitest run test/rendering/prepareCityScene.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/rendering/prepareCityScene.js
git commit -m "refactor: prepareCityScene reads elevation from layer bag"
```

---

### Task 18: Final cleanup and full test run

**Files:**
- Modify: `src/core/FeatureMap.js` (verify minimal)
- Modify: `src/city/setup.js` (remove old property writes)

- [ ] **Step 1: Verify FeatureMap is clean**

Check that `FeatureMap` no longer has:
- `addFeature`, `_stampRoad`, `_stampRiver`, `_stampPlot`, `_stampBuilding`
- `_computeInitialBuildability`, `setTerrain`, `_computeWaterDistance`
- `computeLandValue`, `_stampRoadValue`
- `this.buildability`, `this.roadGrid`, `this.waterMask`, `this.bridgeGrid`
- `this.landValue`, `this.waterType`, `this.waterDist`, `this.waterDepth`
- `this.features`

It should have: constructor with `layers` Map + feature arrays + graph +
nuclei + metadata, `setLayer`/`getLayer`/`hasLayer`, `createPathCost`,
`classifyWater`, `carveChannels`, `computeWaterDepth`, `extractFaces`,
`clone`, geometry helpers.

- [ ] **Step 2: Verify setup.js doesn't write old properties**

Check that `setupCity` only uses `map.setLayer()` and direct array access
(`map.rivers`, `map.roads`). No `map.waterMask.set(...)`,
`map.buildability`, etc.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: final cleanup — FeatureMap is now a clean layer bag"
```
