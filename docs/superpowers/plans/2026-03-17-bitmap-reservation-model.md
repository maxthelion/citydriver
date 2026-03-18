# Bitmap Reservation Model Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace on-the-fly cell scoring with precomputed per-use value bitmaps and generalised influence layers, on the `incremental-zoning` branch.

**Architecture:** Split the growth tick into three phases: compute influence layers (blur zone claims), compose value bitmaps (weighted sum), allocate (sort-and-claim). Each phase is a separate module. The archetype config provides value composition weights and influence radii.

**Tech Stack:** Vanilla JS, Grid2D, existing boxBlur utility, BitmapLogger.

---

## File Structure

| File | Role |
|------|------|
| `src/city/pipeline/influenceLayers.js` (create) | Blur zone claims into influence bitmaps |
| `src/city/pipeline/valueLayers.js` (create) | Compose per-use value bitmaps from spatial + influence layers |
| `src/city/pipeline/allocate.js` (create) | Sort-and-claim allocation from value bitmaps |
| `src/city/pipeline/growthTick.js` (rewrite) | Orchestrate: influence → value → allocate. Keep boxBlur. |
| `src/city/pipeline/growthAgents.js` (modify) | Add PORT reservation type. Remove scoreCell, findSeeds, spreadFromSeed (moved to allocate.js or deleted). Keep RESERVATION constants. |
| `src/city/archetypes.js` (modify) | Replace marketTown `affinity`/`seedsPerTick`/`spreadBehaviour`/`minSpacing` with `valueComposition`, `influenceRadii`, `budgetPerTick`, `minFootprint` |
| `src/rendering/debugLayers.js` (modify) | Add port colour, add value/influence layers to LAYERS array |
| `test/city/pipeline/influenceLayers.test.js` (create) | Tests for influence computation |
| `test/city/pipeline/valueLayers.test.js` (create) | Tests for value composition |
| `test/city/pipeline/allocate.test.js` (create) | Tests for allocation |

---

## Chunk 1: Influence Layers

### Task 1: Create influenceLayers.js

**Files:**
- Create: `src/city/pipeline/influenceLayers.js`
- Create: `test/city/pipeline/influenceLayers.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/city/pipeline/influenceLayers.test.js
import { describe, it, expect } from 'vitest';
import { computeInfluenceLayers, boxBlur } from '../../../src/city/pipeline/influenceLayers.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

describe('boxBlur', () => {
  it('blurs a single point into a gradient', () => {
    const src = new Float32Array(100); // 10x10
    src[55] = 1.0; // centre-ish
    const result = boxBlur(src, 10, 10, 3);
    // Centre should be highest
    expect(result[55]).toBeGreaterThan(0.5);
    // Corners should be lower
    expect(result[0]).toBeLessThan(result[55]);
    // All values 0-1
    for (let i = 0; i < 100; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThanOrEqual(1);
    }
  });
});

describe('computeInfluenceLayers', () => {
  it('produces influence layers from reservation grid', () => {
    const w = 20, h = 20;
    const resGrid = new Grid2D(w, h, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
    // Place some industrial cells
    for (let x = 8; x < 12; x++)
      for (let z = 8; z < 12; z++)
        resGrid.set(x, z, 2); // INDUSTRIAL

    const influenceRadii = { industrial: 5, port: 5, civic: 3, openSpace: 3, residential: 3 };
    const layers = computeInfluenceLayers(resGrid, w, h, influenceRadii);

    // Should have industrialProximity
    expect(layers.industrialProximity).toBeTruthy();
    // High near industrial cells
    expect(layers.industrialProximity.get(10, 10)).toBeGreaterThan(0.5);
    // Low far away
    expect(layers.industrialProximity.get(0, 0)).toBeLessThan(0.3);
    // developmentProximity should also exist
    expect(layers.developmentProximity).toBeTruthy();
    expect(layers.developmentProximity.get(10, 10)).toBeGreaterThan(0.5);
  });

  it('produces empty layers when nothing is reserved', () => {
    const w = 10, h = 10;
    const resGrid = new Grid2D(w, h, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
    const influenceRadii = { industrial: 5, port: 5, civic: 3, openSpace: 3, residential: 3 };
    const layers = computeInfluenceLayers(resGrid, w, h, influenceRadii);
    // All layers should exist but be zero
    expect(layers.industrialProximity.get(5, 5)).toBe(0);
    expect(layers.developmentProximity.get(5, 5)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/influenceLayers.test.js`

- [ ] **Step 3: Implement influenceLayers.js**

```js
// src/city/pipeline/influenceLayers.js
/**
 * Compute influence layers by blurring zone claims.
 * Each zone type's claims produce a proximity gradient that
 * feeds into the next tick's value bitmap composition.
 */

import { RESERVATION } from './growthAgents.js';

/**
 * Separable box blur. Returns a normalised Float32Array (0-1).
 */
export function boxBlur(src, w, h, radius) {
  if (radius <= 0) return new Float32Array(src);
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  // Horizontal pass
  for (let z = 0; z < h; z++) {
    let sum = 0;
    for (let x = 0; x < Math.min(radius, w); x++) sum += src[z * w + x];
    for (let x = 0; x < w; x++) {
      if (x + radius < w) sum += src[z * w + x + radius];
      if (x - radius - 1 >= 0) sum -= src[z * w + x - radius - 1];
      tmp[z * w + x] = sum;
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let z = 0; z < Math.min(radius, h); z++) sum += tmp[z * w + x];
    for (let z = 0; z < h; z++) {
      if (z + radius < h) sum += tmp[(z + radius) * w + x];
      if (z - radius - 1 >= 0) sum -= tmp[(z - radius - 1) * w + x];
      dst[z * w + x] = sum;
    }
  }
  // Normalise
  let max = 0;
  for (let i = 0; i < w * h; i++) if (dst[i] > max) max = dst[i];
  if (max > 0) for (let i = 0; i < w * h; i++) dst[i] /= max;
  return dst;
}

/** Wrap a Float32Array as a layer with .get(x,z) */
function asLayer(arr, w) {
  return { get: (x, z) => arr[z * w + x], width: w, height: arr.length / w, data: arr };
}

/**
 * Build a binary mask from the reservation grid for the given types.
 */
function buildMask(resGrid, w, h, types) {
  const mask = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (types.includes(resGrid.get(x, z))) mask[z * w + x] = 1.0;
    }
  }
  return mask;
}

/**
 * Compute all influence layers from current reservation state.
 *
 * @param {Grid2D} resGrid - reservation grid
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @param {object} influenceRadii - { port, industrial, civic, openSpace, residential }
 * @param {Array} [nuclei] - nucleus positions (for first-tick seeding)
 * @returns {object} - { portProximity, industrialProximity, civicProximity, parkProximity, residentialProximity, developmentProximity }
 */
export function computeInfluenceLayers(resGrid, w, h, influenceRadii, nuclei) {
  const R = RESERVATION;

  const portMask = buildMask(resGrid, w, h, [R.PORT]);
  const indMask = buildMask(resGrid, w, h, [R.INDUSTRIAL]);
  const civicMask = buildMask(resGrid, w, h, [R.CIVIC]);
  const parkMask = buildMask(resGrid, w, h, [R.OPEN_SPACE]);
  const resMask = buildMask(resGrid, w, h, [R.RESIDENTIAL_FINE, R.RESIDENTIAL_ESTATE, R.RESIDENTIAL_QUALITY]);

  // Development = everything except NONE and AGRICULTURE
  const devMask = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const v = resGrid.get(x, z);
      if (v !== R.NONE && v !== R.AGRICULTURE) devMask[z * w + x] = 1.0;
    }
  }
  // Seed from nuclei if provided (first tick bootstrap)
  if (nuclei) {
    for (const n of nuclei) {
      if (n.gx >= 0 && n.gx < w && n.gz >= 0 && n.gz < h) {
        devMask[n.gz * w + n.gx] = 1.0;
      }
    }
  }

  const radiusStep = influenceRadii.development || influenceRadii.residential || 40;

  return {
    portProximity: asLayer(boxBlur(portMask, w, h, influenceRadii.port || 80), w),
    industrialProximity: asLayer(boxBlur(indMask, w, h, influenceRadii.industrial || 60), w),
    civicProximity: asLayer(boxBlur(civicMask, w, h, influenceRadii.civic || 40), w),
    parkProximity: asLayer(boxBlur(parkMask, w, h, influenceRadii.openSpace || 40), w),
    residentialProximity: asLayer(boxBlur(resMask, w, h, influenceRadii.residential || 40), w),
    developmentProximity: asLayer(boxBlur(devMask, w, h, radiusStep), w),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/influenceLayers.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/influenceLayers.js test/city/pipeline/influenceLayers.test.js
git commit -m "feat: add influence layer computation (blur zone claims into proximity gradients)"
```

---

## Chunk 2: Value Layers

### Task 2: Create valueLayers.js

**Files:**
- Create: `src/city/pipeline/valueLayers.js`
- Create: `test/city/pipeline/valueLayers.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/city/pipeline/valueLayers.test.js
import { describe, it, expect } from 'vitest';
import { composeValueLayer, composeAllValueLayers } from '../../../src/city/pipeline/valueLayers.js';

describe('composeValueLayer', () => {
  it('computes weighted sum of layers', () => {
    const w = 10, h = 10;
    const layerA = { get: (x, z) => 0.5 };
    const layerB = { get: (x, z) => 1.0 };
    const composition = { layerA: 0.6, layerB: 0.4 };
    const layers = { layerA, layerB };

    const result = composeValueLayer(composition, layers, w, h);
    // 0.6 * 0.5 + 0.4 * 1.0 = 0.7
    expect(result.get(5, 5)).toBeCloseTo(0.7);
  });

  it('handles negative weights', () => {
    const w = 10, h = 10;
    const layerA = { get: () => 0.8 };
    const layerB = { get: () => 0.6 };
    const composition = { layerA: 1.0, layerB: -0.5 };
    const layers = { layerA, layerB };

    const result = composeValueLayer(composition, layers, w, h);
    // 1.0 * 0.8 + (-0.5) * 0.6 = 0.5
    expect(result.get(5, 5)).toBeCloseTo(0.5);
  });

  it('skips missing layers', () => {
    const w = 10, h = 10;
    const layerA = { get: () => 1.0 };
    const composition = { layerA: 0.5, missing: 0.5 };
    const layers = { layerA };

    const result = composeValueLayer(composition, layers, w, h);
    expect(result.get(5, 5)).toBeCloseTo(0.5);
  });
});

describe('composeAllValueLayers', () => {
  it('produces a value layer per zone type', () => {
    const w = 10, h = 10;
    const layers = {
      centrality: { get: () => 0.5 },
      roadFrontage: { get: () => 0.8 },
    };
    const valueComposition = {
      commercial: { centrality: 0.6, roadFrontage: 2.0 },
      industrial: { centrality: -0.2 },
    };

    const result = composeAllValueLayers(valueComposition, layers, w, h);
    expect(result.commercialValue).toBeTruthy();
    expect(result.industrialValue).toBeTruthy();
    // commercial: 0.6*0.5 + 2.0*0.8 = 1.9
    expect(result.commercialValue.get(5, 5)).toBeCloseTo(1.9);
    // industrial: -0.2*0.5 = -0.1
    expect(result.industrialValue.get(5, 5)).toBeCloseTo(-0.1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/valueLayers.test.js`

- [ ] **Step 3: Implement valueLayers.js**

```js
// src/city/pipeline/valueLayers.js
/**
 * Compose per-use value bitmaps from spatial + influence layers.
 * Each value bitmap is a weighted sum of available layers.
 */

/** Wrap a Float32Array as a layer with .get(x,z) */
function asLayer(arr, w) {
  return { get: (x, z) => arr[z * w + x], width: w, height: arr.length / w, data: arr };
}

/**
 * Compose a single value layer from a weighted sum of input layers.
 *
 * @param {object} composition - { layerName: weight, ... }
 * @param {object} layers - { layerName: { get(x,z) }, ... }
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @returns {{ get(x,z), width, height, data }} value layer
 */
export function composeValueLayer(composition, layers, w, h) {
  const data = new Float32Array(w * h);
  // Collect active layer/weight pairs
  const active = [];
  for (const [name, weight] of Object.entries(composition)) {
    if (layers[name]) active.push({ layer: layers[name], weight });
  }

  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (const { layer, weight } of active) {
        sum += weight * layer.get(x, z);
      }
      data[z * w + x] = sum;
    }
  }

  return asLayer(data, w);
}

/**
 * Compose value layers for all zone types.
 *
 * @param {object} valueComposition - { zoneType: { layerName: weight, ... }, ... }
 * @param {object} layers - all available spatial + influence layers
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @returns {object} - { commercialValue, industrialValue, ... }
 */
export function composeAllValueLayers(valueComposition, layers, w, h) {
  const result = {};
  for (const [zoneType, composition] of Object.entries(valueComposition)) {
    result[`${zoneType}Value`] = composeValueLayer(composition, layers, w, h);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/valueLayers.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/valueLayers.js test/city/pipeline/valueLayers.test.js
git commit -m "feat: add value layer composition (weighted sum of spatial + influence layers)"
```

---

## Chunk 3: Allocation

### Task 3: Create allocate.js

**Files:**
- Create: `src/city/pipeline/allocate.js`
- Create: `test/city/pipeline/allocate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/city/pipeline/allocate.test.js
import { describe, it, expect } from 'vitest';
import { allocateFromValueBitmap } from '../../../src/city/pipeline/allocate.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

describe('allocateFromValueBitmap', () => {
  function makeGrid(w, h, type = 'uint8') {
    return new Grid2D(w, h, { type, cellSize: 5, originX: 0, originZ: 0 });
  }

  it('claims highest-value eligible cells up to budget', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    // All in zone
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    // Value layer: high in top-left
    const valueData = new Float32Array(w * h);
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        valueData[z * w + x] = 1.0 - (x + z) / 20;
    const valueLayer = { get: (x, z) => valueData[z * w + x], data: valueData };

    const devProximity = { get: () => 1.0 }; // all eligible

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, devProximity,
      resType: 1, budget: 10, minFootprint: 1, w, h,
    });

    expect(claimed).toBe(10);
    // Top-left cells should be claimed (highest value)
    expect(resGrid.get(0, 0)).toBe(1);
  });

  it('respects existing reservations', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);
    // Pre-fill top-left
    resGrid.set(0, 0, 2);

    const valueLayer = { get: () => 1.0, data: new Float32Array(w * h).fill(1) };
    const devProximity = { get: () => 1.0 };

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, devProximity,
      resType: 1, budget: 5, minFootprint: 1, w, h,
    });

    expect(resGrid.get(0, 0)).toBe(2); // not overwritten
    expect(claimed).toBe(5);
  });

  it('enforces minFootprint contiguity', () => {
    const w = 10, h = 10;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    // Two separate high-value patches
    const valueData = new Float32Array(w * h);
    valueData[0 * w + 0] = 1.0; // isolated top-left
    valueData[5 * w + 5] = 0.9; // patch at centre
    valueData[5 * w + 6] = 0.9;
    valueData[6 * w + 5] = 0.9;
    valueData[6 * w + 6] = 0.9;
    const valueLayer = { get: (x, z) => valueData[z * w + x], data: valueData };
    const devProximity = { get: () => 1.0 };

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, devProximity,
      resType: 1, budget: 10, minFootprint: 3, w, h,
    });

    // The isolated cell (0,0) should NOT be claimed because minFootprint=3
    // and it can't form a cluster of 3
    // The 4-cell patch at (5,5) should be claimed
    expect(resGrid.get(0, 0)).toBe(0); // not claimed
    expect(resGrid.get(5, 5)).toBe(1); // claimed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/allocate.test.js`

- [ ] **Step 3: Implement allocate.js**

```js
// src/city/pipeline/allocate.js
/**
 * Allocate cells from a precomputed value bitmap.
 * Sorts eligible cells by value, claims contiguous clusters.
 */

import { RESERVATION } from './growthAgents.js';

const DEV_PROXIMITY_THRESHOLD = 0.01;

/**
 * Allocate cells for a single zone type from its value bitmap.
 *
 * @param {object} opts
 * @param {{ get(x,z), data }} opts.valueLayer - precomputed value bitmap
 * @param {Grid2D} opts.resGrid - reservation grid (read + write)
 * @param {Grid2D} opts.zoneGrid - zone eligibility
 * @param {{ get(x,z) }} opts.devProximity - development proximity layer
 * @param {number} opts.resType - reservation type to write
 * @param {number} opts.budget - max cells to claim this tick
 * @param {number} opts.minFootprint - min cluster size
 * @param {number} opts.w - grid width
 * @param {number} opts.h - grid height
 * @returns {number} cells claimed
 */
export function allocateFromValueBitmap({ valueLayer, resGrid, zoneGrid, devProximity, resType, budget, minFootprint, w, h }) {
  // 1. Collect eligible cells with positive value
  const eligible = [];
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (zoneGrid.get(x, z) === 0) continue;
      if (resGrid.get(x, z) !== RESERVATION.NONE) continue;
      if (devProximity.get(x, z) < DEV_PROXIMITY_THRESHOLD) continue;
      const v = valueLayer.get(x, z);
      if (v <= 0) continue;
      eligible.push({ gx: x, gz: z, value: v });
    }
  }

  if (eligible.length === 0) return 0;

  // 2. Sort by value descending
  eligible.sort((a, b) => b.value - a.value);

  // 3. Claim cells, enforcing contiguity
  let claimed = 0;
  const key = (x, z) => x | (z << 16);

  // Track which cells we've claimed this allocation for contiguity checks
  const claimedSet = new Set();

  // Also include existing same-type cells for contiguity
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (resGrid.get(x, z) === resType) claimedSet.add(key(x, z));
    }
  }

  for (const cell of eligible) {
    if (claimed >= budget) break;

    // Check contiguity: cell must be adjacent to existing same-type claim
    // OR we start a new cluster (if we can reach minFootprint)
    const isAdjacent = claimedSet.size === 0 || hasAdjacentClaim(cell.gx, cell.gz, claimedSet, w, h);

    if (isAdjacent) {
      resGrid.set(cell.gx, cell.gz, resType);
      claimedSet.add(key(cell.gx, cell.gz));
      claimed++;
    } else if (minFootprint <= 1) {
      // No contiguity required — claim freely
      resGrid.set(cell.gx, cell.gz, resType);
      claimedSet.add(key(cell.gx, cell.gz));
      claimed++;
    } else {
      // Try to start a new cluster: can we find minFootprint contiguous cells?
      const cluster = tryCluster(cell, eligible, resGrid, zoneGrid, resType, minFootprint, w, h);
      if (cluster.length >= minFootprint) {
        for (const c of cluster) {
          resGrid.set(c.gx, c.gz, resType);
          claimedSet.add(key(c.gx, c.gz));
          claimed++;
          if (claimed >= budget) break;
        }
      }
    }
  }

  return claimed;
}

function hasAdjacentClaim(gx, gz, claimedSet, w, h) {
  const key = (x, z) => x | (z << 16);
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = gx + dx, nz = gz + dz;
    if (nx >= 0 && nx < w && nz >= 0 && nz < h && claimedSet.has(key(nx, nz))) {
      return true;
    }
  }
  return false;
}

/**
 * Try to form a contiguous cluster of at least minFootprint cells
 * starting from the given seed, using BFS over eligible unclaimed cells.
 */
function tryCluster(seed, eligible, resGrid, zoneGrid, resType, minFootprint, w, h) {
  const key = (x, z) => x | (z << 16);
  const visited = new Set([key(seed.gx, seed.gz)]);
  const cluster = [{ gx: seed.gx, gz: seed.gz }];
  const queue = [{ gx: seed.gx, gz: seed.gz }];

  while (queue.length > 0 && cluster.length < minFootprint) {
    const curr = queue.shift();
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = curr.gx + dx, nz = curr.gz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      const k = key(nx, nz);
      if (visited.has(k)) continue;
      visited.add(k);
      if (zoneGrid.get(nx, nz) === 0) continue;
      if (resGrid.get(nx, nz) !== 0) continue;
      cluster.push({ gx: nx, gz: nz });
      queue.push({ gx: nx, gz: nz });
      if (cluster.length >= minFootprint) break;
    }
  }

  return cluster;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/allocate.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/allocate.js test/city/pipeline/allocate.test.js
git commit -m "feat: add sort-and-claim allocation from precomputed value bitmaps"
```

---

## Chunk 4: Integration

### Task 4: Add PORT reservation type

**Files:**
- Modify: `src/city/pipeline/growthAgents.js`
- Modify: `src/rendering/debugLayers.js`

- [ ] **Step 1: Add PORT to RESERVATION constants**

In `growthAgents.js`, add after RESIDENTIAL_QUALITY:

```js
PORT: 9,
```

And add to AGENT_TYPE_TO_RESERVATION:

```js
port: RESERVATION.PORT,
```

- [ ] **Step 2: Add port colour to debug layer**

In `debugLayers.js` `renderReservations`, add to colors:

```js
9: 'rgba(0, 180, 180, 0.6)',  // port — teal
```

- [ ] **Step 3: Commit**

```bash
git add src/city/pipeline/growthAgents.js src/rendering/debugLayers.js
git commit -m "feat: add PORT reservation type (9) with teal debug colour"
```

### Task 5: Update marketTown archetype config

**Files:**
- Modify: `src/city/archetypes.js`

- [ ] **Step 1: Replace the growth config**

Replace the entire `growth` block in marketTown with the spec's config: `valueComposition`, `influenceRadii`, and `agents` with `share`, `budgetPerTick`, `minFootprint`. Remove `affinity`, `seedStrategy`, `spreadBehaviour`, `seedsPerTick`, `minSpacing`, `footprint`.

Use the exact config from the spec (lines 94-136).

- [ ] **Step 2: Commit**

```bash
git add src/city/archetypes.js
git commit -m "feat: update marketTown to valueComposition + influenceRadii config"
```

### Task 6: Rewrite growthTick.js

**Files:**
- Modify: `src/city/pipeline/growthTick.js`

- [ ] **Step 1: Rewrite to influence → value → allocate loop**

Replace the contents of `runGrowthTick` with:

```js
import { computeInfluenceLayers } from './influenceLayers.js';
import { composeAllValueLayers } from './valueLayers.js';
import { allocateFromValueBitmap } from './allocate.js';
import { RESERVATION, AGENT_TYPE_TO_RESERVATION } from './growthAgents.js';
import { Grid2D } from '../../core/Grid2D.js';

export function initGrowthState(map, archetype) {
  // same as current — init claimedCounts, totalZoneCells, tick counter
  // but remove activeSeeds and nucleusRadii (no longer needed)
  const claimedCounts = new Map();
  for (const agentType of archetype.growth.agentPriority) {
    claimedCounts.set(agentType, 0);
  }

  if (!map.hasLayer('reservationGrid')) {
    map.setLayer('reservationGrid', new Grid2D(map.width, map.height, {
      type: 'uint8', cellSize: map.cellSize,
      originX: map.originX, originZ: map.originZ,
    }));
  }

  let totalZoneCells = 0;
  if (map.developmentZones) {
    for (const zone of map.developmentZones) totalZoneCells += zone.cells.length;
  }

  return { tick: 0, claimedCounts, totalZoneCells };
}

export function runGrowthTick(map, archetype, state) {
  const growth = archetype.growth;
  if (state.tick >= (growth.maxGrowthTicks || 20)) return true;
  state.tick++;

  const w = map.width, h = map.height;
  const resGrid = map.getLayer('reservationGrid');
  const zoneGrid = map.getLayer('zoneGrid');

  // Load base spatial layers
  const layers = {};
  for (const name of ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage',
                       'downwindness', 'terrainSuitability', 'elevation']) {
    if (map.hasLayer(name)) layers[name] = map.getLayer(name);
  }

  // Phase 1: INFLUENCE
  const nuclei = state.tick === 1 ? map.nuclei : null;
  const influence = computeInfluenceLayers(resGrid, w, h, growth.influenceRadii, nuclei);
  Object.assign(layers, influence);

  // Phase 2: VALUE
  const valueLayers = composeAllValueLayers(growth.valueComposition, layers, w, h);
  // Store on map for debugging
  for (const [name, layer] of Object.entries(valueLayers)) {
    map.setLayer(name, layer);
  }

  // Phase 3: ALLOCATE
  const devProximity = layers.developmentProximity;

  // Agriculture retreat
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (resGrid.get(x, z) === RESERVATION.AGRICULTURE && devProximity.get(x, z) >= 0.01) {
        resGrid.set(x, z, RESERVATION.NONE);
      }
    }
  }

  let anyAllocated = false;
  for (const agentType of growth.agentPriority) {
    if (agentType === 'agriculture') continue;
    const agentConfig = growth.agents[agentType];
    if (!agentConfig) continue;
    const resType = AGENT_TYPE_TO_RESERVATION[agentType];
    if (resType === undefined) continue;

    const cap = Math.round(agentConfig.share * state.totalZoneCells);
    const alreadyClaimed = state.claimedCounts.get(agentType) || 0;
    if (alreadyClaimed >= cap) continue;

    const tickBudget = Math.round(agentConfig.budgetPerTick * state.totalZoneCells);
    const budget = Math.min(tickBudget, cap - alreadyClaimed);

    const valueKey = `${agentType}Value`;
    const valueLayer = valueLayers[valueKey];
    if (!valueLayer) continue;

    const claimed = allocateFromValueBitmap({
      valueLayer, resGrid, zoneGrid, devProximity,
      resType, budget, minFootprint: agentConfig.minFootprint || 1, w, h,
    });

    state.claimedCounts.set(agentType, alreadyClaimed + claimed);
    if (claimed > 0) anyAllocated = true;
  }

  // Agriculture fill — cells beyond frontier
  const agriConfig = growth.agents.agriculture;
  if (agriConfig) {
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        if (zoneGrid.get(x, z) === 0) continue;
        if (resGrid.get(x, z) !== RESERVATION.NONE) continue;
        const dp = devProximity.get(x, z);
        if (dp < 0.01 && dp > 0.001) {
          resGrid.set(x, z, RESERVATION.AGRICULTURE);
        }
      }
    }
  }

  map.growthState = state;
  return !anyAllocated; // terminate when nothing was allocated
}
```

- [ ] **Step 2: Update imports in growthTick.js**

Remove old imports (`scoreCell`, `findSeeds`, `spreadFromSeed`). Add new imports for `computeInfluenceLayers`, `composeAllValueLayers`, `allocateFromValueBitmap`.

- [ ] **Step 3: Update LandFirstDevelopment if needed**

The `LandFirstDevelopment` strategy should still work — it calls `initGrowthState` and `runGrowthTick` which have the same interface. Verify the phase state machine still works.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run --exclude 'test/rendering/prepareCityScene.test.js' --exclude 'test/city/strategies/landFirstDevelopment.test.js'`

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/growthTick.js
git commit -m "feat: rewrite growthTick to influence → value → allocate pipeline"
```

### Task 7: Add value/influence layers to debug view

**Files:**
- Modify: `src/rendering/debugLayers.js`

- [ ] **Step 1: Add value and influence layers to LAYERS array**

After the existing reservation and spatial layer entries, add entries for the value and influence layers so they're viewable in the debug screen:

```js
// Influence layers
{ name: 'Port Proximity', render: renderNamedHeatLayer('portProximity') },
{ name: 'Industrial Proximity', render: renderNamedHeatLayer('industrialProximity') },
{ name: 'Civic Proximity', render: renderNamedHeatLayer('civicProximity') },
{ name: 'Park Proximity', render: renderNamedHeatLayer('parkProximity') },
{ name: 'Residential Proximity', render: renderNamedHeatLayer('residentialProximity') },
// Value layers
{ name: 'Commercial Value', render: renderNamedHeatLayer('commercialValue') },
{ name: 'Port Value', render: renderNamedHeatLayer('portValue') },
{ name: 'Industrial Value', render: renderNamedHeatLayer('industrialValue') },
{ name: 'Civic Value', render: renderNamedHeatLayer('civicValue') },
{ name: 'Residential Fine Value', render: renderNamedHeatLayer('residentialFineValue') },
{ name: 'Residential Quality Value', render: renderNamedHeatLayer('residentialQualityValue') },
```

- [ ] **Step 2: Commit**

```bash
git add src/rendering/debugLayers.js
git commit -m "feat: add value and influence layers to debug view"
```

### Task 8: Render and verify

- [ ] **Step 1: Run tests**

Run: `npx vitest run --exclude 'test/rendering/prepareCityScene.test.js' --exclude 'test/city/strategies/landFirstDevelopment.test.js'`

- [ ] **Step 2: Generate trace**

Run: `bun scripts/trace-pipeline.js 884469 27 95 marketTown`

Update `scripts/trace-pipeline.js` to also log the value and influence layers during growth ticks.

- [ ] **Step 3: Generate renders from multiple seeds**

```bash
bun scripts/render-reservations.js 884469 27 95 50
bun scripts/render-reservations.js 42 15 50 50
bun scripts/render-reservations.js 12345 20 60 50
```

Convert to PNG and inspect. Verify:
- No circular growth patterns
- Commercial follows roads (high roadFrontage weight)
- Port on waterfront (high waterfrontness weight)
- Residential avoids port/industrial areas (negative proximity weights)
- Value and influence layers are viewable in trace output

- [ ] **Step 4: Commit**

```bash
git add -u && git add output/
git commit -m "feat: bitmap reservation model complete — renders from 3 seeds"
```
