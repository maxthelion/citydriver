# Coverage Layers Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered per-feature smoothing with a unified coverage layer system that produces organic boundaries for forests, coastlines, roads, and development zones.

**Architecture:** A new `coverageLayers.js` module stamps binary source data onto city-resolution grids, blurs each with a separable box filter, perturbs edges with hash noise, then enforces layer priority so higher-priority features (water > road > development > forest > landCover) claim visual space first. Consumers (`_buildTerrain`, `_buildTrees`) read continuous float values instead of raw cell lookups.

**Tech Stack:** Plain JS, Float32Array grids, vitest for testing.

**Spec:** `docs/superpowers/specs/2026-03-12-coverage-layers-design.md`

---

## Chunk 1: Core utilities and unit tests

### Task 1: Separable box blur utility

**Files:**
- Create: `src/city/coverageLayers.js`
- Create: `test/city/coverageLayers.test.js`

- [ ] **Step 1: Write failing test for separableBoxBlur**

```js
// test/city/coverageLayers.test.js
import { describe, it, expect } from 'vitest';
import { separableBoxBlur } from '../../src/city/coverageLayers.js';

describe('separableBoxBlur', () => {
  it('preserves total energy (sum of values)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    grid[5 * w + 5] = 1.0; // single bright cell
    const sumBefore = grid.reduce((a, b) => a + b, 0);

    const result = separableBoxBlur(grid, w, h, 2);

    const sumAfter = result.reduce((a, b) => a + b, 0);
    expect(sumAfter).toBeCloseTo(sumBefore, 4);
  });

  it('spreads a single cell into surrounding area', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    grid[5 * w + 5] = 1.0;

    const result = separableBoxBlur(grid, w, h, 2);

    // Center should be reduced, neighbors should be nonzero
    expect(result[5 * w + 5]).toBeLessThan(1.0);
    expect(result[5 * w + 5]).toBeGreaterThan(0);
    expect(result[5 * w + 6]).toBeGreaterThan(0);
    expect(result[6 * w + 5]).toBeGreaterThan(0);
  });

  it('returns all zeros for all-zero input', () => {
    const w = 8, h = 8;
    const grid = new Float32Array(w * h);
    const result = separableBoxBlur(grid, w, h, 3);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('returns uniform value for all-one input', () => {
    const w = 8, h = 8;
    const grid = new Float32Array(w * h).fill(1.0);
    const result = separableBoxBlur(grid, w, h, 3);
    // Every cell should remain ~1.0 (edge clamping pulls from boundary)
    for (let i = 0; i < w * h; i++) {
      expect(result[i]).toBeCloseTo(1.0, 4);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement separableBoxBlur**

```js
// src/city/coverageLayers.js
/**
 * Unified coverage layer system.
 * Produces continuous float layers from discrete cell data for organic rendering boundaries.
 */

/**
 * Two-pass separable box blur. Returns a new Float32Array.
 * Edge cells clamp to boundary (no wrap).
 */
export function separableBoxBlur(grid, w, h, radius) {
  const size = radius * 2 + 1;

  // Horizontal pass
  const tmp = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        sum += grid[z * w + Math.max(0, Math.min(w - 1, x + dx))];
      }
      tmp[z * w + x] = sum / size;
    }
  }

  // Vertical pass
  const out = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dz = -radius; dz <= radius; dz++) {
        sum += tmp[Math.max(0, Math.min(h - 1, z + dz)) * w + x];
      }
      out[z * w + x] = sum / size;
    }
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/city/coverageLayers.js test/city/coverageLayers.test.js
git commit -m "Add separableBoxBlur utility with tests"
```

---

### Task 2: Hash noise utility

**Files:**
- Modify: `src/city/coverageLayers.js`
- Modify: `test/city/coverageLayers.test.js`

- [ ] **Step 1: Write failing test for applyHashNoise**

```js
// append to test/city/coverageLayers.test.js
import { applyHashNoise } from '../../src/city/coverageLayers.js';

describe('applyHashNoise', () => {
  it('does not perturb cells at 0 or 1 (parabolic scaling)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h);
    // Some cells at 0, some at 1
    grid[0] = 0.0;
    grid[1] = 1.0;

    const result = applyHashNoise(grid, w, h, 0.2, 42);

    expect(result[0]).toBe(0.0);
    expect(result[1]).toBe(1.0);
  });

  it('perturbs cells in the middle range', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h).fill(0.5);

    const result = applyHashNoise(grid, w, h, 0.2, 42);

    // Not all cells should remain exactly 0.5
    let anyDifferent = false;
    for (let i = 0; i < w * h; i++) {
      if (Math.abs(result[i] - 0.5) > 0.001) anyDifferent = true;
    }
    expect(anyDifferent).toBe(true);
  });

  it('keeps all values in [0, 1]', () => {
    const w = 20, h = 20;
    const grid = new Float32Array(w * h).fill(0.5);

    const result = applyHashNoise(grid, w, h, 0.5, 99);

    for (let i = 0; i < w * h; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic (same seed = same result)', () => {
    const w = 10, h = 10;
    const grid = new Float32Array(w * h).fill(0.5);

    const a = applyHashNoise(grid, w, h, 0.2, 42);
    const b = applyHashNoise(grid, w, h, 0.2, 42);

    for (let i = 0; i < w * h; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: FAIL — applyHashNoise not exported

- [ ] **Step 3: Implement applyHashNoise**

Add to `src/city/coverageLayers.js`:

```js
/**
 * Deterministic hash → [0, 1].
 */
function hashNorm(a, b, seed) {
  let h = (a * 374761393 + b * 668265263 + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 1911520717);
  h = h ^ (h >>> 13);
  return ((h >>> 0) & 0xffffff) / 0xffffff;
}

/**
 * Perturb grid values with deterministic noise.
 * Amplitude scales parabolically: 4*v*(1-v), so cells at 0 or 1 are unaffected.
 * Returns a new Float32Array.
 */
export function applyHashNoise(grid, w, h, baseAmplitude, seed) {
  const out = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const idx = z * w + x;
      const v = grid[idx];
      const scale = 4 * v * (1 - v); // parabolic: 0 at extremes, 1 at v=0.5
      const noise = (hashNorm(x, z, seed) - 0.5) * 2 * baseAmplitude * scale;
      out[idx] = Math.max(0, Math.min(1, v + noise));
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/city/coverageLayers.js test/city/coverageLayers.test.js
git commit -m "Add applyHashNoise utility with parabolic edge scaling"
```

---

### Task 3: Priority suppression

**Files:**
- Modify: `src/city/coverageLayers.js`
- Modify: `test/city/coverageLayers.test.js`

- [ ] **Step 1: Write failing test for enforcePriority**

```js
import { enforcePriority } from '../../src/city/coverageLayers.js';

describe('enforcePriority', () => {
  it('ensures layers sum to <= 1.0 at every cell', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.6) },
      { data: new Float32Array(n).fill(0.6) },
      { data: new Float32Array(n).fill(0.6) },
    ];

    enforcePriority(layers, w, h);

    for (let i = 0; i < n; i++) {
      const sum = layers.reduce((s, l) => s + l.data[i], 0);
      expect(sum).toBeLessThanOrEqual(1.001);
    }
  });

  it('higher-priority layer claims space first', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.8) }, // priority 0 (highest)
      { data: new Float32Array(n).fill(0.8) }, // priority 1
    ];

    enforcePriority(layers, w, h);

    // First layer unchanged (0.8 <= 1.0)
    expect(layers[0].data[0]).toBeCloseTo(0.8);
    // Second layer capped at remaining 0.2
    expect(layers[1].data[0]).toBeCloseTo(0.2);
  });

  it('does nothing when layers already fit within budget', () => {
    const w = 4, h = 4, n = w * h;
    const layers = [
      { data: new Float32Array(n).fill(0.3) },
      { data: new Float32Array(n).fill(0.3) },
    ];

    enforcePriority(layers, w, h);

    expect(layers[0].data[0]).toBeCloseTo(0.3);
    expect(layers[1].data[0]).toBeCloseTo(0.3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: FAIL — enforcePriority not exported

- [ ] **Step 3: Implement enforcePriority**

Add to `src/city/coverageLayers.js`:

```js
/**
 * Enforce priority suppression across layers.
 * Layers are in priority order (index 0 = highest).
 * Each layer object must have a `.data` Float32Array.
 * Mutates layer data in-place.
 */
export function enforcePriority(layers, w, h) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    let available = 1.0;
    for (const layer of layers) {
      layer.data[i] = Math.min(layer.data[i], available);
      available -= layer.data[i];
      available = Math.max(0, available);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: PASS (all 11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/city/coverageLayers.js test/city/coverageLayers.test.js
git commit -m "Add enforcePriority for coverage layer interaction"
```

---

## Chunk 2: Layer computation and the main entry point

### Task 4: Stamp functions for each layer

**Files:**
- Modify: `src/city/coverageLayers.js`
- Modify: `test/city/coverageLayers.test.js`

- [ ] **Step 1: Write failing test for stamp functions**

```js
import { stampWater, stampRoad, stampDevelopment, stampForest, stampLandCover } from '../../src/city/coverageLayers.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('stamp functions', () => {
  function makeMap(w, h) {
    return {
      width: w, height: h, cellSize: 5,
      originX: 0, originZ: 0,
      waterMask: new Grid2D(w, h, { type: 'uint8' }),
      roadGrid: new Grid2D(w, h, { type: 'uint8' }),
      developmentZones: [],
      regionalLayers: {
        getGrid: () => new Grid2D(4, 4, { type: 'uint8' }),
        getData: () => ({ cellSize: 50, width: 4, height: 4 }),
      },
    };
  }

  it('stampWater marks water cells as 1.0', () => {
    const map = makeMap(10, 10);
    map.waterMask.set(3, 3, 1);
    map.waterMask.set(4, 3, 1);

    const out = stampWater(map);

    expect(out[3 * 10 + 3]).toBe(1.0);
    expect(out[3 * 10 + 4]).toBe(1.0);
    expect(out[0]).toBe(0.0);
  });

  it('stampRoad marks road cells and 2-cell buffer', () => {
    const map = makeMap(10, 10);
    map.roadGrid.set(5, 5, 1);

    const out = stampRoad(map);

    // Road cell itself
    expect(out[5 * 10 + 5]).toBe(1.0);
    // Buffer cell
    expect(out[5 * 10 + 6]).toBe(1.0);
    expect(out[6 * 10 + 5]).toBe(1.0);
    // Far away cell
    expect(out[0]).toBe(0.0);
  });

  it('stampDevelopment marks zone cells and settlement cells', () => {
    const map = makeMap(10, 10);
    map.developmentZones = [{ cells: [{ gx: 2, gz: 2 }, { gx: 3, gz: 2 }] }];

    const out = stampDevelopment(map);

    expect(out[2 * 10 + 2]).toBe(1.0);
    expect(out[2 * 10 + 3]).toBe(1.0);
    expect(out[0]).toBe(0.0);
  });

  it('stampForest marks forest as 1.0 and woodland as 0.6', () => {
    const map = makeMap(10, 10);
    const landCover = new Grid2D(4, 4, { type: 'uint8' });
    landCover.set(0, 0, 2); // forest
    landCover.set(1, 0, 6); // woodland
    map.regionalLayers = {
      getGrid: () => landCover,
      getData: () => ({ cellSize: 50, width: 4, height: 4 }),
    };

    const out = stampForest(map);

    // Cell at origin maps to regional (0,0) = forest
    expect(out[0]).toBe(1.0);
    // Cells with no forest/woodland cover
    const farIdx = 9 * 10 + 9; // maps to regional cell beyond forest
    expect(out[farIdx]).toBe(0.0);
  });

  it('stampLandCover populates dominantCover with correct cover type', () => {
    const map = makeMap(10, 10);
    const landCover = new Grid2D(4, 4, { type: 'uint8' });
    landCover.set(0, 0, 3); // moorland
    landCover.set(1, 0, 8); // scrubland
    map.regionalLayers = {
      getGrid: () => landCover,
      getData: () => ({ cellSize: 50, width: 4, height: 4 }),
    };

    const { data, dominantCover } = stampLandCover(map);

    expect(data[0]).toBe(1.0);
    expect(dominantCover[0]).toBe(3); // moorland
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: FAIL — stamp functions not exported

- [ ] **Step 3: Implement stamp functions**

Add to `src/city/coverageLayers.js`:

```js
/**
 * Stamp water mask onto a float grid. Returns Float32Array.
 */
export function stampWater(map) {
  const { width: w, height: h } = map;
  const out = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (map.waterMask.get(gx, gz) > 0) out[gz * w + gx] = 1.0;
    }
  }
  return out;
}

/**
 * Stamp road grid with 2-cell buffer. Returns Float32Array.
 */
export function stampRoad(map) {
  const { width: w, height: h } = map;
  const out = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (map.roadGrid.get(gx, gz) === 0) continue;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < w && nz < h) {
            out[nz * w + nx] = 1.0;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Stamp development zones + regional settlement cells. Returns Float32Array.
 */
export function stampDevelopment(map) {
  const { width: w, height: h, cellSize: cs } = map;
  const out = new Float32Array(w * h);

  // Zone cells
  if (map.developmentZones) {
    for (const zone of map.developmentZones) {
      for (const c of zone.cells) out[c.gz * w + c.gx] = 1.0;
    }
  }

  // Road cells + buffer (same as _buildDevelopedProximity)
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (map.roadGrid.get(gx, gz) === 0) continue;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < w && nz < h) {
            out[nz * w + nx] = 1.0;
          }
        }
      }
    }
  }

  // Regional settlement cells (cover=5)
  const regionalLandCover = map.regionalLayers.getGrid('landCover');
  const rcs = map.regionalLayers.getData('params').cellSize;
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (out[gz * w + gx] > 0) continue;
      const wx = map.originX + gx * cs;
      const wz = map.originZ + gz * cs;
      const rx = Math.min(Math.round(wx / rcs), regionalLandCover.width - 1);
      const rz = Math.min(Math.round(wz / rcs), regionalLandCover.height - 1);
      if (regionalLandCover.get(rx, rz) === 5) out[gz * w + gx] = 1.0;
    }
  }

  return out;
}

/**
 * Stamp forest cells (landCover=2 or 6) from regional grid. Returns Float32Array.
 * Uses nearest-neighbor lookup (blur handles smoothing).
 */
export function stampForest(map) {
  const { width: w, height: h, cellSize: cs } = map;
  const out = new Float32Array(w * h);
  const regionalLandCover = map.regionalLayers.getGrid('landCover');
  const rcs = map.regionalLayers.getData('params').cellSize;

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const wx = map.originX + gx * cs;
      const wz = map.originZ + gz * cs;
      const rx = Math.min(Math.round(wx / rcs), regionalLandCover.width - 1);
      const rz = Math.min(Math.round(wz / rcs), regionalLandCover.height - 1);
      const cover = regionalLandCover.get(rx, rz);
      if (cover === 2) out[gz * w + gx] = 1.0;
      else if (cover === 6) out[gz * w + gx] = 0.6; // woodland = lower density
    }
  }
  return out;
}

/**
 * Stamp remaining land cover types (farmland=1, moorland=3, marsh=4, bare rock=7, scrub=8).
 * Returns an object { data: Float32Array, dominantCover: Uint8Array }.
 * dominantCover records which cover type drives the color at each cell.
 */
export function stampLandCover(map) {
  const { width: w, height: h, cellSize: cs } = map;
  const data = new Float32Array(w * h);
  const dominantCover = new Uint8Array(w * h);
  const regionalLandCover = map.regionalLayers.getGrid('landCover');
  const rcs = map.regionalLayers.getData('params').cellSize;

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const wx = map.originX + gx * cs;
      const wz = map.originZ + gz * cs;
      const rx = Math.min(Math.round(wx / rcs), regionalLandCover.width - 1);
      const rz = Math.min(Math.round(wz / rcs), regionalLandCover.height - 1);
      const cover = regionalLandCover.get(rx, rz);
      // Only non-water, non-forest, non-settlement covers
      if (cover === 1 || cover === 3 || cover === 4 || cover === 7 || cover === 8) {
        data[gz * w + gx] = 1.0;
        dominantCover[gz * w + gx] = cover;
      }
    }
  }
  return { data, dominantCover };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: PASS (all 14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/city/coverageLayers.js test/city/coverageLayers.test.js
git commit -m "Add stamp functions for all coverage layer types"
```

---

### Task 5: Main computeCoverageLayers entry point

**Files:**
- Modify: `src/city/coverageLayers.js`
- Modify: `test/city/coverageLayers.test.js`

- [ ] **Step 1: Write failing test for computeCoverageLayers**

```js
import { computeCoverageLayers } from '../../src/city/coverageLayers.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('computeCoverageLayers', () => {
  function makeMap(w, h) {
    const landCover = new Grid2D(4, 4, { type: 'uint8' });
    return {
      width: w, height: h, cellSize: 5,
      originX: 0, originZ: 0,
      waterMask: new Grid2D(w, h, { type: 'uint8' }),
      roadGrid: new Grid2D(w, h, { type: 'uint8' }),
      developmentZones: [],
      regionalLayers: {
        getGrid: () => landCover,
        getData: () => ({ cellSize: 50, width: 4, height: 4 }),
      },
    };
  }

  it('returns all expected layer names', () => {
    const map = makeMap(20, 20);
    const layers = computeCoverageLayers(map);

    expect(layers.water).toBeInstanceOf(Float32Array);
    expect(layers.road).toBeInstanceOf(Float32Array);
    expect(layers.development).toBeInstanceOf(Float32Array);
    expect(layers.forest).toBeInstanceOf(Float32Array);
    expect(layers.landCover).toBeInstanceOf(Float32Array);
    expect(layers.dominantCover).toBeInstanceOf(Uint8Array);
  });

  it('all layers have correct size', () => {
    const map = makeMap(20, 20);
    const layers = computeCoverageLayers(map);
    const n = 20 * 20;

    expect(layers.water.length).toBe(n);
    expect(layers.road.length).toBe(n);
    expect(layers.development.length).toBe(n);
    expect(layers.forest.length).toBe(n);
    expect(layers.landCover.length).toBe(n);
  });

  it('layers sum to <= 1.0 at every cell after priority suppression', () => {
    const map = makeMap(20, 20);
    // Set some water and forest to create overlap
    for (let i = 0; i < 5; i++) map.waterMask.set(i, 5, 1);
    const landCover = map.regionalLayers.getGrid('landCover');
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) landCover.set(x, z, 2);

    const layers = computeCoverageLayers(map);

    for (let i = 0; i < 20 * 20; i++) {
      const sum = layers.water[i] + layers.road[i] + layers.development[i]
        + layers.forest[i] + layers.landCover[i];
      expect(sum).toBeLessThanOrEqual(1.01);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: FAIL — computeCoverageLayers not exported

- [ ] **Step 3: Implement computeCoverageLayers**

Add to `src/city/coverageLayers.js`:

```js
/** Layer definitions: name, stamp function, blur radius, noise amplitude, seed offset. */
const LAYER_DEFS = [
  { name: 'water',       stamp: stampWater,       blur: 6, noise: 0.15, seed: 1 },
  { name: 'road',        stamp: stampRoad,        blur: 3, noise: 0.10, seed: 2 },
  { name: 'development', stamp: stampDevelopment, blur: 8, noise: 0.15, seed: 3 },
  { name: 'forest',      stamp: stampForest,      blur: 4, noise: 0.20, seed: 4 },
];

/**
 * Compute all coverage layers for the given city map.
 * Returns { water, road, development, forest, landCover, dominantCover }.
 */
export function computeCoverageLayers(map, seed = 42) {
  const { width: w, height: h } = map;

  // Build standard layers: stamp → blur → noise
  const ordered = [];
  const result = {};
  for (const def of LAYER_DEFS) {
    let data = def.stamp(map);
    data = separableBoxBlur(data, w, h, def.blur);
    data = applyHashNoise(data, w, h, def.noise, seed + def.seed);
    ordered.push({ data });
    result[def.name] = data;
  }

  // Land cover layer (has extra dominantCover output)
  const lc = stampLandCover(map);
  lc.data = separableBoxBlur(lc.data, w, h, 4);
  lc.data = applyHashNoise(lc.data, w, h, 0.15, seed + 5);
  ordered.push({ data: lc.data });
  result.landCover = lc.data;
  result.dominantCover = lc.dominantCover;

  // Priority suppression (order: water > road > development > forest > landCover)
  enforcePriority(ordered, w, h);

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/coverageLayers.test.js`
Expected: PASS (all 17 tests)

- [ ] **Step 5: Commit**

```bash
git add src/city/coverageLayers.js test/city/coverageLayers.test.js
git commit -m "Add computeCoverageLayers entry point with full pipeline"
```

---

## Chunk 3: Wire into CityScreen consumers

### Task 6: Replace _buildDevelopedProximity and update all consumers atomically

**Files:**
- Modify: `src/ui/CityScreen.js`

This task must be done as a single unit — removing `_devProximity` while `_buildTerrain` and `_buildTrees` still reference it would cause a runtime crash.

**Note on color blending:** The new `_buildTerrain` uses sequential lerps rather than an additive weighted sum. This is intentional — sequential lerps compound naturally and the priority suppression already ensures layers don't exceed 1.0, so the visual result is correct. The road layer is for ground coloring only (pavement apron), not replacing the road ribbon mesh. `SAND_COLOR` is defined inline near its use.

**Note on tree sizing:** `stampForest` gives woodland cells a value of 0.6. In the old code, woodland trees were ~60% the height of forest trees (max 9m vs 15m). To preserve this, the new code uses separate sizing based on the forest value: below 0.7 uses woodland dimensions, above uses forest dimensions.

- [ ] **Step 1: Add import**

In `src/ui/CityScreen.js`, add import at top:

```js
import { computeCoverageLayers } from '../city/coverageLayers.js';
```

- [ ] **Step 2: Replace _devProximity with coverage layers**

Replace line 84-85:
```js
    // Smoothed development proximity grid — used for terrain blending + tree clearing
    this._devProximity = this._buildDevelopedProximity();
```

With:
```js
    // Unified coverage layers — continuous float grids for organic rendering boundaries
    this._coverage = computeCoverageLayers(this._map, this._seed);
```

- [ ] **Step 3: Rewrite _buildTerrain color computation**

Replace the body of the per-cell loop (lines 426-482) with:

```js
        // Coverage-layer-driven color blending
        const ci = gz * w + gx;
        const cov = this._coverage;

        // Start with base grass color
        let r = DEFAULT_COLOR[0], g = DEFAULT_COLOR[1], b = DEFAULT_COLOR[2];

        // Blend land cover (lowest priority — sets base terrain color)
        if (cov.landCover[ci] > 0.01) {
          const cover = cov.dominantCover[ci];
          const cc = COVER_COLORS[cover] || DEFAULT_COLOR;
          const t = cov.landCover[ci];
          r = r + (cc[0] - r) * t;
          g = g + (cc[1] - g) * t;
          b = b + (cc[2] - b) * t;
        }

        // Blend forest
        if (cov.forest[ci] > 0.01) {
          const fc = COVER_COLORS[2]; // forest green
          const t = cov.forest[ci];
          r = r + (fc[0] - r) * t;
          g = g + (fc[1] - g) * t;
          b = b + (fc[2] - b) * t;

          // Dappled canopy noise on forested areas
          const hash = ((gx * 2654435761 + gz * 2246822519) >>> 0) & 0xffff;
          const noise = (hash / 0xffff) * 0.15 - 0.075;
          r = Math.max(0, Math.min(1, r + noise * 0.5 * t));
          g = Math.max(0, Math.min(1, g + noise * t));
          b = Math.max(0, Math.min(1, b + noise * 0.3 * t));
        }

        // Blend development (urban ground tone)
        if (cov.development[ci] > 0.01) {
          const dc = COVER_COLORS[5]; // settlement color
          const t = cov.development[ci];
          r = r + (dc[0] - r) * t;
          g = g + (dc[1] - g) * t;
          b = b + (dc[2] - b) * t;
        }

        // Blend road (pavement apron — ground coloring only, road ribbon mesh is separate)
        if (cov.road[ci] > 0.01) {
          const t = cov.road[ci];
          r = r + (PAVED_COLOR[0] - r) * t;
          g = g + (PAVED_COLOR[1] - g) * t;
          b = b + (PAVED_COLOR[2] - b) * t;
        }

        // Blend water → sand/beach in transition zone
        if (cov.water[ci] > 0.01) {
          const SAND_COLOR = [0.76, 0.70, 0.50];
          const WATER_COLOR = COVER_COLORS[0];
          // 0.0–0.4: blend toward sand; 0.4–1.0: blend toward water
          if (cov.water[ci] < 0.4) {
            const t = cov.water[ci] / 0.4;
            r = r + (SAND_COLOR[0] - r) * t;
            g = g + (SAND_COLOR[1] - g) * t;
            b = b + (SAND_COLOR[2] - b) * t;
          } else {
            const t = (cov.water[ci] - 0.4) / 0.6;
            r = SAND_COLOR[0] + (WATER_COLOR[0] - SAND_COLOR[0]) * t;
            g = SAND_COLOR[1] + (WATER_COLOR[1] - SAND_COLOR[1]) * t;
            b = SAND_COLOR[2] + (WATER_COLOR[2] - SAND_COLOR[2]) * t;
          }
        }

        const rgb = [r, g, b];
```

Keep the surrounding code (elevation assignment at line 424, color write at lines 484-486) unchanged. Remove the old bilinear interpolation block, dev proximity blend, and forest noise block.

- [ ] **Step 4: Rewrite _buildTrees to use forest layer**

Replace lines 631-691 (everything before the instanced mesh creation) with:

```js
    const map = this._map;
    const cs = map.cellSize;
    const cov = this._coverage;
    const w = map.width;

    // Deterministic hash with proper bit mixing → 0-1
    function hash(a, b, seed) {
      let h = (a * 374761393 + b * 668265263 + seed) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h = Math.imul(h ^ (h >>> 16), 1911520717);
      h = h ^ (h >>> 13);
      return ((h >>> 0) & 0xffffff) / 0xffffff;
    }

    const treeData = [];
    for (let gz = 1; gz < map.height - 1; gz++) {
      for (let gx = 1; gx < map.width - 1; gx++) {
        const ci = gz * w + gx;
        const forestVal = cov.forest[ci];

        // Skip cells with negligible forest coverage
        if (forestVal < 0.1) continue;
        // Skip water
        if (cov.water[ci] > 0.3) continue;

        // Tree count scales with forest coverage: 0-4 trees
        const maxTrees = Math.round(forestVal * 4);
        const count = Math.floor(hash(gx, gz, 0) * (maxTrees + 1));

        for (let t = 0; t < count; t++) {
          const rx = hash(gx, gz, t * 3 + 1);
          const rz = hash(gx, gz, t * 3 + 2);
          const rv = hash(gx, gz, t * 3 + 3);

          const x = (gx + rx) * cs;
          const z = (gz + rz) * cs;
          const y = map.elevation.sample(x / cs, z / cs);

          // Tree size: woodland (forestVal < 0.7) vs forest dimensions
          // Matches old behavior: woodland ~60% height, ~65% radius of forest
          let treeH, rad;
          if (forestVal < 0.7) {
            treeH = 4 + rv * 5;   // 4-9m (old woodland range)
            rad = 1.5 + rx * 2;   // 1.5-3.5m
          } else {
            treeH = 7 + rv * 8;   // 7-15m (old forest range)
            rad = 2.5 + rx * 2.5; // 2.5-5m
          }

          treeData.push(x, y, z, treeH, rad);
        }
      }
    }
```

Keep the instanced mesh creation code (from `if (treeData.length === 0)` onward) unchanged.

- [ ] **Step 5: Delete `_buildDevelopedProximity` method**

Remove the entire `_buildDevelopedProximity()` method (lines 329-400 of `CityScreen.js`).

- [ ] **Step 6: Verify the app renders correctly**

Run: `npx vite dev` and open in browser.
Expected: Terrain shows smooth color transitions. Beaches visible at coastlines. Forest edges organic. Trees thin out at development boundaries. No console errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/CityScreen.js
git commit -m "Wire coverage layers into _buildTerrain and _buildTrees, remove _buildDevelopedProximity"
```

**Note:** `_buildWater()` is not modified here — it renders a flat plane at sea level and does not read `waterMask` per-cell. The beach effect comes entirely from terrain ground coloring in `_buildTerrain` via the water coverage layer's transition zone. If a per-cell water mesh is desired later, it would be a separate feature.

---

## Chunk 4: Debug layers and cleanup

### Task 7: Add debug layer visualizations for coverage layers

**Files:**
- Modify: `src/rendering/debugLayers.js`
- Modify: `src/ui/CityScreen.js` (pass coverage to debug layer render)

- [ ] **Step 1: Add coverage layer heatmap renderers**

Add to `src/rendering/debugLayers.js` before the `LAYERS` export:

```js
/**
 * Generic coverage layer heatmap renderer.
 * Reads from map._coverage[layerName].
 */
function renderCoverageLayer(ctx, map, layerName, color) {
  const { width, height } = map;
  const layer = map._coverage && map._coverage[layerName];
  if (!layer) return;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const v = layer[gz * width + gx];
      const r = Math.round(color[0] * v * 255);
      const g = Math.round(color[1] * v * 255);
      const b = Math.round(color[2] * v * 255);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}
```

Add entries to the `LAYERS` array:

```js
  { name: 'Coverage: Water', render: (ctx, map) => renderCoverageLayer(ctx, map, 'water', [0.2, 0.4, 1.0]) },
  { name: 'Coverage: Road', render: (ctx, map) => renderCoverageLayer(ctx, map, 'road', [0.8, 0.8, 0.7]) },
  { name: 'Coverage: Development', render: (ctx, map) => renderCoverageLayer(ctx, map, 'development', [1.0, 0.7, 0.3]) },
  { name: 'Coverage: Forest', render: (ctx, map) => renderCoverageLayer(ctx, map, 'forest', [0.1, 0.7, 0.1]) },
  { name: 'Coverage: Land Cover', render: (ctx, map) => renderCoverageLayer(ctx, map, 'landCover', [0.7, 0.6, 0.3]) },
```

- [ ] **Step 2: Attach coverage layers to map for debug access**

In `src/ui/CityScreen.js`, after `this._coverage = computeCoverageLayers(this._map);`, add:

```js
    this._map._coverage = this._coverage;
```

This lets debug layer renderers access the coverage data through the map object they already receive.

- [ ] **Step 3: Verify debug overlays work**

Run: `npx vite dev`, open browser, select "Coverage: Water" from the overlay dropdown.
Expected: Heatmap showing smooth water coverage gradients (bright at water, fading to black on land).

- [ ] **Step 4: Commit**

```bash
git add src/rendering/debugLayers.js src/ui/CityScreen.js
git commit -m "Add debug layer visualizations for coverage layers"
```

---

### Task 8: Clean up unused imports and dead code

**Files:**
- Modify: `src/ui/CityScreen.js`

- [ ] **Step 1: Remove unused regional land cover references**

Check if `COVER_COLORS` entries for water (0) and settlement (5) are still needed. The terrain blending now uses inline colors for sand/water. If entries 0 and 5 are only used by the old bilinear code path, they can stay (they're still used for debug layers and reference). No removal needed — leave the color table intact.

Check if any other code in `_buildTerrain` or `_buildTrees` still references `map.regionalLayers` or `map.roadGrid` directly for rendering purposes. Remove any dead branches.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, including the new coverageLayers tests.

- [ ] **Step 3: Visual regression check**

Run: `npx vite dev` and compare the rendered city to the previous version. Key things to check:
- Forest edges are smoother (no stair-stepping)
- Coastlines have a sand/beach transition
- Road cells blend into surrounding terrain
- Development zone edges are organic
- Debug overlays all render correctly
- No visual glitches or black patches

- [ ] **Step 4: Commit**

```bash
git add src/ui/CityScreen.js
git commit -m "Clean up dead code after coverage layer migration"
```
