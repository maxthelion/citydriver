# City Archetypes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement archetype-driven land reservation so cities have distinct character — commercial streets, industrial zones, parks, civic centres — shaped by geography.

**Architecture:** Define 5 archetype data objects. Compute 5 spatial layers (centrality, waterfrontness, edgeness, roadFrontage, downwindness) from existing map data. Fill the `reserveLandUse` pipeline stub with reservation logic that scores cells against archetype preferences and grows contiguous zones via radial or directional BFS. Score settlements against archetypes for automatic selection.

**Tech Stack:** JavaScript/ES6 modules, Vitest, Grid2D, FeatureMap layer bag

---

## Chunk 1: Archetype Data and Spatial Layers

### Task 1: Define archetype data objects

**Files:**
- Create: `src/city/archetypes.js`
- Create: `test/city/archetypes.test.js`

- [ ] **Step 1: Write test for archetype data structure**

Create `test/city/archetypes.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { ARCHETYPES, getArchetype } from '../../src/city/archetypes.js';

describe('ARCHETYPES', () => {
  it('contains all 5 archetypes', () => {
    expect(Object.keys(ARCHETYPES)).toHaveLength(5);
    expect(ARCHETYPES.marketTown).toBeDefined();
    expect(ARCHETYPES.portCity).toBeDefined();
    expect(ARCHETYPES.gridTown).toBeDefined();
    expect(ARCHETYPES.industrialTown).toBeDefined();
    expect(ARCHETYPES.civicCentre).toBeDefined();
  });

  it('each archetype has required fields', () => {
    for (const [id, arch] of Object.entries(ARCHETYPES)) {
      expect(arch.id).toBe(id);
      expect(arch.name).toBeTruthy();
      expect(arch.shares).toBeDefined();
      expect(arch.shares.commercial).toBeGreaterThan(0);
      expect(arch.shares.industrial).toBeGreaterThanOrEqual(0);
      expect(arch.shares.civic).toBeGreaterThan(0);
      expect(arch.shares.openSpace).toBeGreaterThan(0);
      expect(arch.reservationOrder).toHaveLength(4);
      expect(arch.placement).toBeDefined();
      expect(arch.growthMode).toBeDefined();
    }
  });

  it('shares sum to less than 1 (remainder is residential)', () => {
    for (const arch of Object.values(ARCHETYPES)) {
      const total = arch.shares.commercial + arch.shares.industrial
        + arch.shares.civic + arch.shares.openSpace;
      expect(total).toBeLessThan(1);
      expect(total).toBeGreaterThan(0.1);
    }
  });
});

describe('getArchetype', () => {
  it('returns archetype by id', () => {
    expect(getArchetype('marketTown').name).toBe('Organic Market Town');
  });

  it('returns null for unknown id', () => {
    expect(getArchetype('nonexistent')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/archetypes.test.js`
Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement archetypes.js**

Create `src/city/archetypes.js` with all 5 archetype objects as specified
in the design doc, but with `downwindness` added to industrial placement
weights. Key changes from design doc:

- `marketTown.placement.industrial`: `{ downwindness: 0.7, edgeness: 0.5 }`
  (was `{ edgeness: 0.9, waterfrontness: -0.3 }`)
- `portCity.placement.industrial`: `{ waterfrontness: 0.6, downwindness: 0.4, edgeness: 0.3 }`
- `gridTown.placement.industrial`: `{ edgeness: 0.7, downwindness: 0.5 }`
- `industrialTown.placement.industrial`: `{ waterfrontness: 0.4, downwindness: 0.3, centrality: 0.3 }`
- `civicCentre.placement.industrial`: `{ downwindness: 0.8, edgeness: 0.5 }`

Add:

```js
export const ARCHETYPES = { marketTown, portCity, gridTown, industrialTown, civicCentre };

export function getArchetype(id) {
  return ARCHETYPES[id] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/archetypes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/archetypes.js test/city/archetypes.test.js
git commit -m "feat: define 5 city archetype data objects"
```

---

### Task 2: Implement computeSpatialLayers pipeline step

**Files:**
- Create: `src/city/pipeline/computeSpatialLayers.js`
- Create: `test/city/pipeline/computeSpatialLayers.test.js`

- [ ] **Step 1: Write tests**

Create `test/city/pipeline/computeSpatialLayers.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { computeSpatialLayers } from '../../../src/city/pipeline/computeSpatialLayers.js';

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

  map.setLayer('terrainSuitability', new Grid2D(width, height, { ...opts, fill: 0.8 }));
  map.setLayer('waterMask', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('waterDist', new Grid2D(width, height, { ...opts, fill: 50 }));
  map.setLayer('roadGrid', new Grid2D(width, height, { ...opts, type: 'uint8' }));

  return map;
}

describe('computeSpatialLayers', () => {
  it('sets centrality layer', () => {
    const map = makeTestMap();
    computeSpatialLayers(map);
    expect(map.hasLayer('centrality')).toBe(true);
    // Centre cell should have high centrality
    expect(map.getLayer('centrality').get(30, 30)).toBeGreaterThan(0.5);
    // Edge cell should have low centrality
    expect(map.getLayer('centrality').get(0, 0)).toBeLessThan(0.1);
  });

  it('sets waterfrontness layer', () => {
    const map = makeTestMap();
    // Put water at gx=29
    map.getLayer('waterMask').set(29, 30, 1);
    map.getLayer('waterDist').set(30, 30, 1); // 1 cell = 5m from water
    map.getLayer('waterDist').set(28, 30, 0); // water cell itself
    computeSpatialLayers(map);
    expect(map.hasLayer('waterfrontness')).toBe(true);
    // Cell near water should have high waterfrontness
    expect(map.getLayer('waterfrontness').get(30, 30)).toBeGreaterThan(0.5);
    // Cell far from water should have low waterfrontness
    expect(map.getLayer('waterfrontness').get(0, 0)).toBeLessThan(0.1);
  });

  it('sets edgeness layer (inverse of centrality)', () => {
    const map = makeTestMap();
    computeSpatialLayers(map);
    expect(map.hasLayer('edgeness')).toBe(true);
    const centre = map.getLayer('edgeness').get(30, 30);
    const edge = map.getLayer('edgeness').get(55, 55);
    expect(edge).toBeGreaterThan(centre);
  });

  it('sets roadFrontage layer', () => {
    const map = makeTestMap();
    // Stamp a road through the middle
    for (let gx = 0; gx < 60; gx++) map.getLayer('roadGrid').set(gx, 30, 1);
    computeSpatialLayers(map);
    expect(map.hasLayer('roadFrontage')).toBe(true);
    // Cell on road should have high frontage
    expect(map.getLayer('roadFrontage').get(20, 30)).toBeGreaterThan(0.3);
    // Cell far from road should have low frontage
    expect(map.getLayer('roadFrontage').get(20, 0)).toBeLessThan(0.1);
  });

  it('sets downwindness layer', () => {
    const map = makeTestMap();
    map.prevailingWindAngle = 0; // wind blows in +x direction
    computeSpatialLayers(map);
    expect(map.hasLayer('downwindness')).toBe(true);
    // Cell at high x (downwind) should score higher than cell at low x
    const downwind = map.getLayer('downwindness').get(55, 30);
    const upwind = map.getLayer('downwindness').get(5, 30);
    expect(downwind).toBeGreaterThan(upwind);
  });

  it('downwindness defaults to seed-derived angle when not set', () => {
    const map = makeTestMap();
    computeSpatialLayers(map);
    expect(map.hasLayer('downwindness')).toBe(true);
    // Should still produce a gradient (not all zeros)
    let hasNonZero = false;
    const grid = map.getLayer('downwindness');
    for (let gz = 0; gz < 60; gz += 10)
      for (let gx = 0; gx < 60; gx += 10)
        if (grid.get(gx, gz) > 0.01) hasNonZero = true;
    expect(hasNonZero).toBe(true);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    expect(computeSpatialLayers(map)).toBe(map);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/computeSpatialLayers.test.js`
Expected: FAIL

- [ ] **Step 3: Implement computeSpatialLayers**

Create `src/city/pipeline/computeSpatialLayers.js`:

```js
/**
 * Pipeline step: compute spatial layers for archetype reservation.
 * Reads: terrainSuitability, waterDist, waterMask, roadGrid, nuclei
 * Writes: centrality, waterfrontness, edgeness, roadFrontage, downwindness (layers)
 */

import { Grid2D } from '../../core/Grid2D.js';

const CENTRALITY_FALLOFF_M = 300;
const WATERFRONT_RANGE_M = 100;
const ROAD_BLUR_RADIUS = 4; // cells

export function computeSpatialLayers(map) {
  const { width, height, cellSize, originX, originZ } = map;
  const terrain = map.getLayer('terrainSuitability');
  const waterDist = map.hasLayer('waterDist') ? map.getLayer('waterDist') : null;
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const opts = { type: 'float32', cellSize, originX, originZ };

  // --- Centrality ---
  const centrality = new Grid2D(width, height, opts);
  const falloffCells = CENTRALITY_FALLOFF_M / cellSize;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      let minDist = Infinity;
      for (const n of map.nuclei) {
        const dx = gx - n.gx, dz = gz - n.gz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < minDist) minDist = d;
      }
      const raw = 1 / (1 + minDist / falloffCells);
      centrality.set(gx, gz, raw * terrain.get(gx, gz));
    }
  }
  map.setLayer('centrality', centrality);

  // --- Waterfrontness ---
  const waterfrontness = new Grid2D(width, height, opts);
  if (waterDist) {
    const rangeCells = WATERFRONT_RANGE_M / cellSize;
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        const wd = waterDist.get(gx, gz);
        const raw = Math.max(0, 1 - wd / rangeCells);
        waterfrontness.set(gx, gz, raw * terrain.get(gx, gz));
      }
    }
  }
  map.setLayer('waterfrontness', waterfrontness);

  // --- Edgeness ---
  const edgeness = new Grid2D(width, height, opts);
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      edgeness.set(gx, gz, (1 - centrality.get(gx, gz)) * terrain.get(gx, gz));
    }
  }
  map.setLayer('edgeness', edgeness);

  // --- Road Frontage ---
  const roadFrontage = new Grid2D(width, height, opts);
  if (roadGrid) {
    const r = ROAD_BLUR_RADIUS;
    let maxVal = 0;
    // Box blur of roadGrid
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        let sum = 0;
        const x0 = Math.max(0, gx - r), x1 = Math.min(width - 1, gx + r);
        const z0 = Math.max(0, gz - r), z1 = Math.min(height - 1, gz + r);
        for (let nz = z0; nz <= z1; nz++) {
          for (let nx = x0; nx <= x1; nx++) {
            sum += roadGrid.get(nx, nz);
          }
        }
        roadFrontage.set(gx, gz, sum);
        if (sum > maxVal) maxVal = sum;
      }
    }
    // Normalise to 0-1 and mask by terrain
    if (maxVal > 0) {
      for (let gz = 0; gz < height; gz++) {
        for (let gx = 0; gx < width; gx++) {
          roadFrontage.set(gx, gz,
            (roadFrontage.get(gx, gz) / maxVal) * terrain.get(gx, gz));
        }
      }
    }
  }
  map.setLayer('roadFrontage', roadFrontage);

  // --- Downwindness ---
  // Prevailing wind direction: angle in radians, 0 = +x, pi/2 = +z
  // Derive from map property or seed. Default to prevailing westerlies (~pi, from west).
  const windAngle = map.prevailingWindAngle ?? (map.rng ? map.rng.next() * Math.PI * 2 : Math.PI);
  const windDirX = Math.cos(windAngle);
  const windDirZ = Math.sin(windAngle);
  const cx = width / 2, cz = height / 2;

  const downwindness = new Grid2D(width, height, opts);
  let minDot = Infinity, maxDot = -Infinity;
  // First pass: compute raw dot products
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const dot = (gx - cx) * windDirX + (gz - cz) * windDirZ;
      downwindness.set(gx, gz, dot);
      if (dot < minDot) minDot = dot;
      if (dot > maxDot) maxDot = dot;
    }
  }
  // Second pass: normalise to 0-1 and mask by terrain
  const dotRange = maxDot - minDot || 1;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const norm = (downwindness.get(gx, gz) - minDot) / dotRange;
      downwindness.set(gx, gz, norm * terrain.get(gx, gz));
    }
  }
  map.setLayer('downwindness', downwindness);

  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/computeSpatialLayers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/computeSpatialLayers.js test/city/pipeline/computeSpatialLayers.test.js
git commit -m "feat: add computeSpatialLayers pipeline step"
```

---

### Task 3: Wire computeSpatialLayers into the pipeline

**Files:**
- Modify: `src/city/strategies/landFirstDevelopment.js`

- [ ] **Step 1: Add computeSpatialLayers as tick 4**

Update `src/city/strategies/landFirstDevelopment.js`:

```js
import { computeSpatialLayers } from '../pipeline/computeSpatialLayers.js';

// In tick():
case 4: this.map = computeSpatialLayers(this.map); return true;
case 5: this.map = reserveLandUse(this.map, this.archetype); return true;
case 6: this.map = layoutRibbons(this.map); return true;
case 7: this.map = connectToNetwork(this.map); return true;
```

Update the comment header to reflect 7 ticks.

- [ ] **Step 2: Run integration test**

Run: `npx vitest run test/city/strategies/landFirstDevelopment.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/city/strategies/landFirstDevelopment.js
git commit -m "feat: wire computeSpatialLayers into pipeline as tick 4"
```

---

### Task 4: Add debug layer renderers for spatial layers

**Files:**
- Modify: `src/rendering/debugLayers.js`

- [ ] **Step 1: Add 5 heatmap renderers**

Add before the closing `];` of the LAYERS array in `debugLayers.js`:

```js
{ name: 'Centrality', render: renderNamedHeatLayer('centrality') },
{ name: 'Waterfrontness', render: renderNamedHeatLayer('waterfrontness') },
{ name: 'Edgeness', render: renderNamedHeatLayer('edgeness') },
{ name: 'Road Frontage', render: renderNamedHeatLayer('roadFrontage') },
{ name: 'Downwindness', render: renderNamedHeatLayer('downwindness') },
```

Add a generic named-layer heatmap renderer factory:

```js
function renderNamedHeatLayer(layerName) {
  return function(ctx, map) {
    const grid = map.hasLayer ? map.getLayer(layerName) : null;
    if (!grid) return;
    const { width, height } = map;
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        const v = grid.get(gx, gz);
        if (v > 0.01) {
          ctx.fillStyle = heatColor(v);
          ctx.fillRect(gx, gz, 1, 1);
        }
      }
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/rendering/debugLayers.js
git commit -m "feat: add debug layer renderers for spatial layers"
```

---

## Chunk 2: Reservation Logic

### Task 5: Implement reservation zone growth (radial and directional)

**Files:**
- Modify: `src/city/pipeline/reserveLandUse.js`
- Modify: `test/city/pipeline/reserveLandUse.test.js`

This is the core of the archetype system. The reservation logic scores
zone cells against archetype placement preferences, then grows contiguous
zones using two BFS modes.

- [ ] **Step 1: Write tests for reservation logic**

Extend `test/city/pipeline/reserveLandUse.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { reserveLandUse, RESERVATION } from '../../../src/city/pipeline/reserveLandUse.js';
import { ARCHETYPES } from '../../../src/city/archetypes.js';

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

  map.setLayer('zoneGrid', new Grid2D(width, height, { ...opts, type: 'uint8' }));
  map.setLayer('centrality', new Grid2D(width, height, { ...opts, fill: 0.5 }));
  map.setLayer('waterfrontness', new Grid2D(width, height, opts));
  map.setLayer('edgeness', new Grid2D(width, height, { ...opts, fill: 0.3 }));
  map.setLayer('roadFrontage', new Grid2D(width, height, opts));

  // Create a development zone: 40x40 block in the centre
  const zoneCells = [];
  const zoneGrid = map.getLayer('zoneGrid');
  for (let gz = 10; gz < 50; gz++) {
    for (let gx = 10; gx < 50; gx++) {
      zoneCells.push({ gx, gz });
      zoneGrid.set(gx, gz, 1);
    }
  }
  map.developmentZones = [{ id: 1, cells: zoneCells, nucleusIdx: 0 }];

  // Make centrality peak at centre
  const centrality = map.getLayer('centrality');
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const dx = gx - 30, dz = gz - 30;
      centrality.set(gx, gz, Math.max(0, 1 - Math.sqrt(dx*dx + dz*dz) / 30));
    }
  }

  // Make edgeness inverse of centrality
  const edgeness = map.getLayer('edgeness');
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      edgeness.set(gx, gz, 1 - centrality.get(gx, gz));
    }
  }

  return map;
}

describe('reserveLandUse with archetype', () => {
  it('reserves cells for each use type', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    const grid = map.getLayer('reservationGrid');

    let counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++) {
        const v = grid.get(gx, gz);
        if (v > 0) counts[v]++;
      }

    expect(counts[RESERVATION.COMMERCIAL]).toBeGreaterThan(0);
    expect(counts[RESERVATION.INDUSTRIAL]).toBeGreaterThan(0);
    expect(counts[RESERVATION.CIVIC]).toBeGreaterThan(0);
    expect(counts[RESERVATION.OPEN_SPACE]).toBeGreaterThan(0);
  });

  it('civic reserves are near the centre (market town)', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    const grid = map.getLayer('reservationGrid');

    // Find centroid of civic cells
    let cx = 0, cz = 0, count = 0;
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) === RESERVATION.CIVIC) { cx += gx; cz += gz; count++; }

    if (count > 0) {
      cx /= count; cz /= count;
      // Civic centroid should be within 15 cells of map centre
      const dist = Math.sqrt((cx - 30) ** 2 + (cz - 30) ** 2);
      expect(dist).toBeLessThan(15);
    }
  });

  it('industrial reserves are near the edge (market town)', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    const grid = map.getLayer('reservationGrid');

    let cx = 0, cz = 0, count = 0;
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) === RESERVATION.INDUSTRIAL) { cx += gx; cz += gz; count++; }

    if (count > 0) {
      cx /= count; cz /= count;
      const dist = Math.sqrt((cx - 30) ** 2 + (cz - 30) ** 2);
      // Industrial centroid should be farther from centre than civic
      expect(dist).toBeGreaterThan(8);
    }
  });

  it('reserved cell count approximately matches share budget', () => {
    const map = makeTestMap();
    const arch = ARCHETYPES.marketTown;
    reserveLandUse(map, arch);
    const grid = map.getLayer('reservationGrid');

    const totalZoneCells = map.developmentZones.reduce((sum, z) => sum + z.cells.length, 0);
    let civicCount = 0;
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) === RESERVATION.CIVIC) civicCount++;

    const expectedCivic = Math.round(totalZoneCells * arch.shares.civic);
    // Allow 20% tolerance
    expect(civicCount).toBeGreaterThan(expectedCivic * 0.5);
    expect(civicCount).toBeLessThan(expectedCivic * 1.5);
  });

  it('reserved zones are contiguous (no scattered cells)', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    const grid = map.getLayer('reservationGrid');

    // Check civic cells form a single connected component
    const civicCells = [];
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) === RESERVATION.CIVIC) civicCells.push({ gx, gz });

    if (civicCells.length > 0) {
      // BFS from first civic cell
      const visited = new Set();
      const queue = [civicCells[0]];
      visited.add(`${civicCells[0].gx},${civicCells[0].gz}`);
      while (queue.length > 0) {
        const { gx, gz } = queue.shift();
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = gx + dx, nz = gz + dz;
          const key = `${nx},${nz}`;
          if (!visited.has(key) && grid.get(nx, nz) === RESERVATION.CIVIC) {
            visited.add(key);
            queue.push({ gx: nx, gz: nz });
          }
        }
      }
      // All civic cells should be reachable from the first
      expect(visited.size).toBe(civicCells.length);
    }
  });

  it('still produces empty grid when no archetype given', () => {
    const map = makeTestMap();
    reserveLandUse(map, null);
    const grid = map.getLayer('reservationGrid');
    let nonZero = 0;
    grid.forEach((gx, gz, v) => { if (v > 0) nonZero++; });
    expect(nonZero).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/city/pipeline/reserveLandUse.test.js`
Expected: FAIL — archetype tests fail (stub produces empty grid)

- [ ] **Step 3: Implement reservation logic**

Replace the `if (archetype)` block in `src/city/pipeline/reserveLandUse.js`
with the full implementation. The key functions:

**`scoreCell(gx, gz, placement, spatialLayers)`** — compute weighted sum
of spatial layer values at (gx,gz) using the archetype's placement weights
for a given use type.

**`growRadial(seed, budget, grid, reservationType, scoreGrid, zoneGrid, reservationGrid)`**
— BFS outward from seed in score order, claiming cells until budget met.
Uses a priority queue (sorted array is fine for the cell counts involved).

**`growDirectional(seed, budget, grid, reservationType, scoreGrid, zoneGrid, reservationGrid, dominantLayer)`**
— Like radial but prioritises neighbours along the axis. Determine axis
from the gradient of the dominant spatial layer at the seed. Neighbours
along-axis get a 2× score bonus; perpendicular neighbours get 0.5×.

**Main flow:**
1. Count total zone cells from `map.developmentZones`
2. For each use type in `archetype.reservationOrder`:
   a. Compute budget = round(totalZoneCells × share)
   b. Score all unreserved zone cells
   c. Find highest-scoring cell as seed
   d. Grow (radial or directional) until budget met
   e. Paint claimed cells on reservationGrid
3. Store reservation zone objects on `map.reservationZones`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/city/pipeline/reserveLandUse.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/reserveLandUse.js test/city/pipeline/reserveLandUse.test.js
git commit -m "feat: implement archetype-driven reservation logic with radial/directional growth"
```

---

### Task 6: Integration test with real pipeline

**Files:**
- Modify: `test/city/strategies/landFirstDevelopment.test.js`

- [ ] **Step 1: Add archetype integration test**

Add to `test/city/strategies/landFirstDevelopment.test.js`:

```js
import { ARCHETYPES } from '../../../src/city/archetypes.js';
import { RESERVATION } from '../../../src/city/pipeline/reserveLandUse.js';

describe('LandFirstDevelopment with archetype', () => {
  it('produces reservation zones when archetype is set', { timeout: 30000 }, () => {
    const seed = 42;
    const { layers, settlement } = generateRegionFromSeed(seed);
    const rng = new SeededRandom(seed);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
    while (strategy.tick()) {}

    expect(map.hasLayer('reservationGrid')).toBe(true);
    const grid = map.getLayer('reservationGrid');
    let reserved = 0;
    for (let gz = 0; gz < map.height; gz++)
      for (let gx = 0; gx < map.width; gx++)
        if (grid.get(gx, gz) > 0) reserved++;

    expect(reserved).toBeGreaterThan(0);
    // Should still have roads (ribbon layout ran on unreserved land)
    const localRoads = map.roads.filter(r => r.hierarchy === 'local');
    expect(localRoads.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run test/city/strategies/landFirstDevelopment.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/city/strategies/landFirstDevelopment.test.js
git commit -m "test: add integration test for archetype reservation in pipeline"
```

---

## Chunk 3: Archetype Scoring and Comparison

### Task 7: Implement archetype scoring

**Files:**
- Create: `src/city/archetypeScoring.js`
- Create: `test/city/archetypeScoring.test.js`

- [ ] **Step 1: Write tests**

Create `test/city/archetypeScoring.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { scoreSettlement } from '../../src/city/archetypeScoring.js';

function makeTestMap(opts = {}) {
  const width = 60, height = 60, cellSize = 5;
  const gridOpts = { cellSize, originX: 0, originZ: 0 };
  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    nuclei: opts.nuclei || [{ gx: 30, gz: 30, type: 'market' }],
    roads: opts.roads || [],
    rivers: opts.rivers || [],
    settlement: opts.settlement || { tier: 3 },
  };

  map.setLayer('terrainSuitability', new Grid2D(width, height, {
    ...gridOpts, fill: opts.flatness || 0.8,
  }));
  map.setLayer('waterMask', new Grid2D(width, height, { ...gridOpts, type: 'uint8' }));
  map.setLayer('waterDist', new Grid2D(width, height, { ...gridOpts, fill: opts.waterDist || 100 }));

  return map;
}

describe('scoreSettlement', () => {
  it('returns scores for all 5 archetypes', () => {
    const map = makeTestMap();
    const results = scoreSettlement(map);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.archetype).toBeDefined();
      expect(typeof r.score).toBe('number');
      expect(r.factors).toBeInstanceOf(Array);
    }
  });

  it('market town is always viable', () => {
    const map = makeTestMap();
    const results = scoreSettlement(map);
    const mt = results.find(r => r.archetype.id === 'marketTown');
    expect(mt.score).toBeGreaterThan(0);
  });

  it('port city scores high with waterfront', () => {
    const map = makeTestMap();
    // Add waterfront: left 10 columns are water
    const wm = map.getLayer('waterMask');
    const wd = map.getLayer('waterDist');
    for (let gz = 0; gz < 60; gz++) {
      for (let gx = 0; gx < 10; gx++) wm.set(gx, gz, 1);
      for (let gx = 10; gx < 20; gx++) wd.set(gx, gz, gx - 10);
    }
    const results = scoreSettlement(map);
    const port = results.find(r => r.archetype.id === 'portCity');
    expect(port.score).toBeGreaterThan(0.3);
  });

  it('port city scores low without waterfront', () => {
    const map = makeTestMap({ waterDist: 200 });
    const results = scoreSettlement(map);
    const port = results.find(r => r.archetype.id === 'portCity');
    expect(port.score).toBeLessThan(0.2);
  });

  it('results are sorted by score descending', () => {
    const map = makeTestMap();
    const results = scoreSettlement(map);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/city/archetypeScoring.test.js`
Expected: FAIL

- [ ] **Step 3: Implement scoreSettlement**

Create `src/city/archetypeScoring.js`:

```js
/**
 * Score a settlement against all archetypes.
 * Returns array of { archetype, score, factors } sorted by score desc.
 */

import { ARCHETYPES } from './archetypes.js';

const WATERFRONT_THRESHOLD = 0.10; // 10% of buildable cells must be near water
const WATERFRONT_RANGE = 20;       // cells within this distance count as waterfront

export function scoreSettlement(map) {
  const terrain = map.getLayer('terrainSuitability');
  const waterDist = map.hasLayer('waterDist') ? map.getLayer('waterDist') : null;
  const { width, height } = map;
  const tier = map.settlement?.tier || 3;
  const roadCount = map.roads.filter(r => r.hierarchy === 'arterial' || r.importance > 0.5).length;
  const hasRivers = map.rivers && map.rivers.length > 0;

  // Precompute stats
  let buildableCells = 0, waterfrontCells = 0, suitabilitySum = 0, suitabilitySqSum = 0;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const t = terrain.get(gx, gz);
      if (t > 0.1) {
        buildableCells++;
        suitabilitySum += t;
        suitabilitySqSum += t * t;
        if (waterDist && waterDist.get(gx, gz) < WATERFRONT_RANGE) waterfrontCells++;
      }
    }
  }
  const avgSuitability = buildableCells > 0 ? suitabilitySum / buildableCells : 0;
  const variance = buildableCells > 0
    ? suitabilitySqSum / buildableCells - avgSuitability * avgSuitability : 0;
  const waterfrontFraction = buildableCells > 0 ? waterfrontCells / buildableCells : 0;

  const scorers = {
    portCity(arch) {
      const factors = [`${(waterfrontFraction * 100).toFixed(0)}% waterfront cells`];
      if (waterfrontFraction < WATERFRONT_THRESHOLD) {
        return { archetype: arch, score: waterfrontFraction, factors: [...factors, 'No significant waterfront'] };
      }
      return { archetype: arch, score: Math.min(1, waterfrontFraction * 3), factors };
    },
    marketTown(arch) {
      const base = Math.min(1, roadCount / 4);
      const factors = [`${roadCount} road connections`];
      const hasMarket = map.nuclei.some(n => n.type === 'market');
      const score = hasMarket ? Math.min(1, base + 0.2) : base;
      if (hasMarket) factors.push('Has market nucleus');
      return { archetype: arch, score: Math.max(0.3, score), factors };
    },
    gridTown(arch) {
      const factors = [`Average flatness ${avgSuitability.toFixed(2)}`];
      let score = avgSuitability;
      if (variance > 0.04) {
        score *= 0.5;
        factors.push('Terrain too varied for planned grid');
      }
      return { archetype: arch, score, factors };
    },
    industrialTown(arch) {
      const riverScore = hasRivers ? 0.5 : 0;
      const flatScore = avgSuitability > 0.6 ? 0.5 : avgSuitability * 0.5;
      const factors = [];
      if (hasRivers) factors.push('River present');
      else factors.push('No river');
      factors.push(`Flat area score ${flatScore.toFixed(2)}`);
      return { archetype: arch, score: riverScore + flatScore, factors };
    },
    civicCentre(arch) {
      const tierScore = tier <= 2 ? 0.8 : 0.3;
      const connScore = Math.min(0.4, roadCount / 8);
      const factors = [`Settlement tier ${tier}`, `${roadCount} road connections`];
      if (tier > 2) factors.push('Settlement tier too low for regional capital');
      return { archetype: arch, score: tierScore + connScore, factors };
    },
  };

  const results = Object.entries(ARCHETYPES).map(([id, arch]) => {
    return scorers[id](arch);
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/city/archetypeScoring.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/archetypeScoring.js test/city/archetypeScoring.test.js
git commit -m "feat: implement archetype-geography scoring"
```

---

### Task 8: Archetype comparison function

**Files:**
- Modify: `src/city/archetypeScoring.js`
- Modify: `test/city/archetypeScoring.test.js`

A diagnostic function that runs all 5 archetypes on the same map and
returns the reservation grids for side-by-side comparison.

- [ ] **Step 1: Write test**

Add to `test/city/archetypeScoring.test.js`:

```js
import { compareArchetypes } from '../../src/city/archetypeScoring.js';
import { computeSpatialLayers } from '../../src/city/pipeline/computeSpatialLayers.js';
import { RESERVATION } from '../../src/city/pipeline/reserveLandUse.js';

describe('compareArchetypes', () => {
  it('returns results for all 5 archetypes with reservation grids', () => {
    const map = makeTestMap();

    // Need zone cells and spatial layers for reservation to work
    const zoneCells = [];
    const zoneGrid = new Grid2D(60, 60, { type: 'uint8', cellSize: 5 });
    for (let gz = 10; gz < 50; gz++) {
      for (let gx = 10; gx < 50; gx++) {
        zoneCells.push({ gx, gz });
        zoneGrid.set(gx, gz, 1);
      }
    }
    map.setLayer('zoneGrid', zoneGrid);
    map.developmentZones = [{ id: 1, cells: zoneCells, nucleusIdx: 0 }];
    map.setLayer('roadGrid', new Grid2D(60, 60, { type: 'uint8', cellSize: 5 }));
    computeSpatialLayers(map);

    const results = compareArchetypes(map);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.archetype).toBeDefined();
      expect(r.score).toBeDefined();
      expect(r.reservationGrid).toBeInstanceOf(Grid2D);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/archetypeScoring.test.js`
Expected: FAIL

- [ ] **Step 3: Implement compareArchetypes**

Add to `src/city/archetypeScoring.js`:

```js
import { reserveLandUse } from './pipeline/reserveLandUse.js';

/**
 * Run all 5 archetypes on the same map and return the results.
 * Each result includes the score, factors, and a reservationGrid.
 * The map is not modified — each archetype runs on a fresh grid.
 */
export function compareArchetypes(map) {
  const scores = scoreSettlement(map);

  return scores.map(({ archetype, score, factors }) => {
    // Create a temporary map-like object with the same layers but a fresh reservationGrid
    const tempMap = {
      width: map.width,
      height: map.height,
      cellSize: map.cellSize,
      originX: map.originX,
      originZ: map.originZ,
      _layers: new Map(map._layers || map.layers),
      getLayer(name) { return this._layers.get(name); },
      hasLayer(name) { return this._layers.has(name); },
      setLayer(name, grid) { this._layers.set(name, grid); },
      nuclei: map.nuclei,
      developmentZones: map.developmentZones,
    };

    reserveLandUse(tempMap, archetype);

    return {
      archetype,
      score,
      factors,
      reservationGrid: tempMap.getLayer('reservationGrid'),
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/city/archetypeScoring.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/archetypeScoring.js test/city/archetypeScoring.test.js
git commit -m "feat: add compareArchetypes diagnostic function"
```

---

### Task 9: Final integration — run full test suite

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Commit any remaining fixes**

If any tests needed fixing, commit them.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: city archetypes — complete implementation with scoring, spatial layers, and reservation logic"
```
