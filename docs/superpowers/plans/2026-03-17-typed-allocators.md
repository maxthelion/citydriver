# Typed Allocators Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single BFS allocator with typed allocators — frontage for commercial, ribbon for residential — and add incremental road growth during ticks.

**Architecture:** Create `allocateFrontage.js` (commercial walks along roads, claims depth proportional to value), `allocateRibbon.js` (residential claims strips with gaps that become streets), and `growRoads.js` (marks ribbon gaps as roads, places cross streets, closes paths). The `growthTick.js` dispatches to the correct allocator based on the agent's `allocator` field and runs road growth after allocation. Existing BFS allocator kept for industrial/civic/openSpace.

**Tech Stack:** Vanilla JS, Grid2D, existing ribbon orientation logic from `ribbonLayout.js`.

---

## File Structure

| File | Role |
|------|------|
| `src/city/pipeline/allocateFrontage.js` (new) | Commercial: walk roads, claim depth from value bitmap |
| `src/city/pipeline/allocateRibbon.js` (new) | Residential: claim strips with gaps, terrain-aware orientation |
| `src/city/pipeline/growRoads.js` (new) | Mark ribbon gaps as roads, cross streets, path closing |
| `src/city/pipeline/allocate.js` (keep) | BFS blob for industrial/civic/openSpace — unchanged |
| `src/city/pipeline/growthTick.js` (modify) | Dispatch allocators, add road growth step |
| `src/city/archetypes.js` (modify) | Add `allocator` type and params per agent |
| `test/city/pipeline/allocateFrontage.test.js` (new) | Tests |
| `test/city/pipeline/allocateRibbon.test.js` (new) | Tests |
| `test/city/pipeline/growRoads.test.js` (new) | Tests |

---

## Chunk 1: Commercial Frontage Allocator

### Task 1: allocateFrontage.js

**Files:**
- Create: `src/city/pipeline/allocateFrontage.js`
- Create: `test/city/pipeline/allocateFrontage.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/city/pipeline/allocateFrontage.test.js
import { describe, it, expect } from 'vitest';
import { allocateFrontage } from '../../../src/city/pipeline/allocateFrontage.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

function makeGrid(w, h, type = 'uint8') {
  return new Grid2D(w, h, { type, cellSize: 5, originX: 0, originZ: 0 });
}

describe('allocateFrontage', () => {
  it('claims cells along a road proportional to value', () => {
    const w = 30, h = 30;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);

    // All in zone
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    // Horizontal road along row 15
    for (let x = 0; x < w; x++) roadGrid.set(x, 15, 1);

    // Value bitmap: high near road centre, lower at edges
    const valueLayer = new Float32Array(w * h);
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        valueLayer[z * w + x] = Math.max(0, 1.0 - Math.abs(x - 15) / 15);

    const devProximity = new Float32Array(w * h).fill(1.0);

    const claimed = allocateFrontage({
      valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
      resType: 1, budget: 200, maxDepth: 3, valueThreshold: 0.3,
      w, h,
    });

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.length).toBeLessThanOrEqual(200);

    // All claimed cells should be near the road (within maxDepth cells)
    for (const c of claimed) {
      expect(Math.abs(c.gz - 15)).toBeLessThanOrEqual(3);
    }

    // Centre of road should have deeper frontage than edges
    let centreCells = claimed.filter(c => Math.abs(c.gx - 15) < 5).length;
    let edgeCells = claimed.filter(c => Math.abs(c.gx - 15) > 10).length;
    // Centre has higher value → more depth per road cell → more claims
    expect(centreCells).toBeGreaterThan(edgeCells);
  });

  it('does not claim road cells themselves', () => {
    const w = 20, h = 20;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);
    for (let x = 0; x < w; x++) roadGrid.set(x, 10, 1);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    allocateFrontage({
      valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
      resType: 1, budget: 100, maxDepth: 2, valueThreshold: 0.1,
      w, h,
    });

    // Road cells should not be claimed
    for (let x = 0; x < w; x++) {
      expect(resGrid.get(x, 10)).toBe(0);
    }
  });

  it('respects existing reservations', () => {
    const w = 20, h = 20;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);
    for (let x = 0; x < w; x++) roadGrid.set(x, 10, 1);

    // Pre-fill row 11 with industrial
    for (let x = 0; x < w; x++) resGrid.set(x, 11, 2);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    const claimed = allocateFrontage({
      valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
      resType: 1, budget: 100, maxDepth: 2, valueThreshold: 0.1,
      w, h,
    });

    // Should only claim on the other side of the road (row 9)
    for (const c of claimed) {
      expect(c.gz).not.toBe(11);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/allocateFrontage.test.js`

- [ ] **Step 3: Implement allocateFrontage.js**

```js
// src/city/pipeline/allocateFrontage.js
/**
 * Commercial frontage allocation.
 * Walks along road cells and claims cells perpendicular to the road,
 * with depth proportional to the local value bitmap.
 */

import { RESERVATION } from './growthAgents.js';

/**
 * Determine road direction at a cell by looking at road neighbours.
 * Returns a unit vector along the road, or null if isolated.
 */
function roadDirection(gx, gz, roadGrid, w, h) {
  // Check 4-connected neighbours for road cells
  const neighbours = [];
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = gx + dx, nz = gz + dz;
    if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
      neighbours.push({ dx, dz });
    }
  }
  if (neighbours.length === 0) return null;

  // Average direction of road neighbours relative to this cell
  let ax = 0, az = 0;
  for (const n of neighbours) { ax += n.dx; az += n.dz; }
  const len = Math.sqrt(ax * ax + az * az);
  if (len < 0.01) return { dx: 1, dz: 0 }; // fallback
  return { dx: ax / len, dz: az / len };
}

/**
 * Allocate commercial frontage along roads.
 *
 * @param {object} opts
 * @param {Float32Array} opts.valueLayer - commercial value bitmap
 * @param {Grid2D} opts.resGrid - reservation grid (read + write)
 * @param {Grid2D} opts.zoneGrid - zone eligibility
 * @param {Grid2D} opts.roadGrid - road cells
 * @param {Float32Array|null} opts.devProximity - development proximity
 * @param {number} opts.resType - reservation type to write
 * @param {number} opts.budget - max cells to claim
 * @param {number} opts.maxDepth - max cells perpendicular to road
 * @param {number} opts.valueThreshold - min value to claim
 * @param {number} opts.w - grid width
 * @param {number} opts.h - grid height
 * @returns {Array<{gx,gz}>} claimed cells
 */
export function allocateFrontage({
  valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
  resType, budget, maxDepth, valueThreshold, w, h,
}) {
  if (budget <= 0) return [];

  // Step 1: Find road cells with high commercial value nearby
  const roadCells = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (roadGrid.get(gx, gz) === 0) continue;
      // Check value in adjacent non-road cells
      let maxVal = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
          maxVal = Math.max(maxVal, valueLayer[nz * w + nx]);
        }
      }
      if (maxVal >= valueThreshold) {
        roadCells.push({ gx, gz, value: maxVal });
      }
    }
  }

  // Sort by value — claim best road frontage first
  roadCells.sort((a, b) => b.value - a.value);

  // Step 2: For each road cell, claim perpendicular cells
  const claimed = [];

  for (const rc of roadCells) {
    if (claimed.length >= budget) break;

    const dir = roadDirection(rc.gx, rc.gz, roadGrid, w, h);
    if (!dir) continue;

    // Perpendicular direction (both sides)
    const perpX = -dir.dz;
    const perpZ = dir.dx;

    // Depth scales with local value: high value = more depth
    const localValue = valueLayer[rc.gz * w + rc.gx] || rc.value;
    const depth = Math.max(1, Math.round(maxDepth * Math.min(1, localValue)));

    // Claim on both sides of road
    for (const side of [1, -1]) {
      for (let d = 1; d <= depth; d++) {
        if (claimed.length >= budget) break;

        const gx = rc.gx + Math.round(perpX * side * d);
        const gz = rc.gz + Math.round(perpZ * side * d);

        if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
        if (zoneGrid.get(gx, gz) === 0) continue;
        if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
        if (roadGrid.get(gx, gz) > 0) continue; // don't claim road cells
        if (devProximity !== null && devProximity[gz * w + gx] === 0) continue;

        resGrid.set(gx, gz, resType);
        claimed.push({ gx, gz });
      }
    }
  }

  return claimed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/allocateFrontage.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/allocateFrontage.js test/city/pipeline/allocateFrontage.test.js
git commit -m "feat: add commercial frontage allocator (walks roads, depth from value bitmap)"
```

---

## Chunk 2: Residential Ribbon Allocator

### Task 2: allocateRibbon.js

**Files:**
- Create: `src/city/pipeline/allocateRibbon.js`
- Create: `test/city/pipeline/allocateRibbon.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/city/pipeline/allocateRibbon.test.js
import { describe, it, expect } from 'vitest';
import { allocateRibbon } from '../../../src/city/pipeline/allocateRibbon.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

function makeGrid(w, h, type = 'uint8') {
  return new Grid2D(w, h, { type, cellSize: 5, originX: 0, originZ: 0 });
}

describe('allocateRibbon', () => {
  it('claims strips with gaps along a road', () => {
    const w = 40, h = 40;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);
    const slope = makeGrid(w, h, 'float32'); // flat

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    // Horizontal road along row 20
    for (let x = 0; x < w; x++) roadGrid.set(x, 20, 1);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    const result = allocateRibbon({
      valueLayer, resGrid, zoneGrid, roadGrid, slope, devProximity,
      resType: 6, budget: 500, plotDepth: 3, gapWidth: 1,
      maxRibbonLength: 30, seedCount: 4, noise: 0.1,
      w, h, cellSize: 5,
    });

    expect(result.claimed.length).toBeGreaterThan(0);

    // Should produce ribbonGaps (cells that should become roads)
    expect(result.ribbonGaps.length).toBeGreaterThan(0);

    // Claimed cells should be near the road but not ON the road
    for (const c of result.claimed) {
      expect(roadGrid.get(c.gx, c.gz)).toBe(0);
    }

    // Gap cells should also not be on the original road
    for (const g of result.ribbonGaps) {
      expect(roadGrid.get(g.gx, g.gz)).toBe(0);
    }
  });

  it('creates parallel strips separated by gaps', () => {
    const w = 40, h = 40;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);
    const slope = makeGrid(w, h, 'float32');

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    for (let x = 0; x < w; x++) roadGrid.set(x, 20, 1);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    const result = allocateRibbon({
      valueLayer, resGrid, zoneGrid, roadGrid, slope, devProximity,
      resType: 6, budget: 1000, plotDepth: 2, gapWidth: 1,
      maxRibbonLength: 30, seedCount: 2, noise: 0,
      w, h, cellSize: 5,
    });

    // Check that there are gaps between claimed rows
    // Above the road, rows should alternate: claimed, claimed, gap, claimed, claimed, gap...
    // (plotDepth=2 means 2 rows of claims, gapWidth=1 means 1 row gap)
    const aboveRoad = result.claimed.filter(c => c.gz < 20);
    if (aboveRoad.length > 0) {
      const rows = new Set(aboveRoad.map(c => c.gz));
      // Should not have every row claimed — gaps should exist
      const minRow = Math.min(...rows);
      const maxRow = Math.max(...rows);
      const totalRows = maxRow - minRow + 1;
      expect(rows.size).toBeLessThan(totalRows); // some rows should be gaps
    }
  });

  it('returns ribbon metadata for cross street placement', () => {
    const w = 30, h = 30;
    const resGrid = makeGrid(w, h);
    const zoneGrid = makeGrid(w, h);
    const roadGrid = makeGrid(w, h);
    const slope = makeGrid(w, h, 'float32');

    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        zoneGrid.set(x, z, 1);

    for (let x = 0; x < w; x++) roadGrid.set(x, 15, 1);

    const valueLayer = new Float32Array(w * h).fill(0.8);
    const devProximity = new Float32Array(w * h).fill(1.0);

    const result = allocateRibbon({
      valueLayer, resGrid, zoneGrid, roadGrid, slope, devProximity,
      resType: 6, budget: 500, plotDepth: 2, gapWidth: 1,
      maxRibbonLength: 15, seedCount: 2, noise: 0,
      w, h, cellSize: 5,
    });

    // Should return ribbon endpoints for cross street placement
    expect(result.ribbonEndpoints).toBeDefined();
    expect(result.ribbonEndpoints.length).toBeGreaterThan(0);
    // Each endpoint has position and direction
    for (const ep of result.ribbonEndpoints) {
      expect(ep.gx).toBeDefined();
      expect(ep.gz).toBeDefined();
      expect(ep.dx).toBeDefined();
      expect(ep.dz).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/allocateRibbon.test.js`

- [ ] **Step 3: Implement allocateRibbon.js**

```js
// src/city/pipeline/allocateRibbon.js
/**
 * Residential ribbon allocation.
 * Claims strips of cells perpendicular to roads, with gaps between
 * strips that become streets. Respects terrain contours.
 */

import { RESERVATION } from './growthAgents.js';

const CONTOUR_SLOPE_THRESHOLD = 0.1;

/**
 * Compute ribbon direction at a point.
 * On slopes: perpendicular to slope (follow contours).
 * On flat: along the road direction.
 */
function ribbonDirection(gx, gz, roadGrid, slope, w, h) {
  // Check if terrain is sloped
  const s = slope ? slope.get(gx, gz) : 0;
  if (s > CONTOUR_SLOPE_THRESHOLD && slope) {
    // Estimate slope direction from gradient
    const sl = gx > 0 ? slope.get(gx - 1, gz) : s;
    const sr = gx < w - 1 ? slope.get(gx + 1, gz) : s;
    const su = gz > 0 ? slope.get(gx, gz - 1) : s;
    const sd = gz < h - 1 ? slope.get(gx, gz + 1) : s;
    const gradX = sr - sl;
    const gradZ = sd - su;
    const glen = Math.sqrt(gradX * gradX + gradZ * gradZ);
    if (glen > 0.001) {
      // Perpendicular to slope = contour-following
      return { dx: -gradZ / glen, dz: gradX / glen };
    }
  }

  // Flat: follow road direction
  let rdx = 0, rdz = 0;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = gx + dx, nz = gz + dz;
    if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
      rdx += dx; rdz += dz;
    }
  }
  const rlen = Math.sqrt(rdx * rdx + rdz * rdz);
  if (rlen > 0.01) return { dx: rdx / rlen, dz: rdz / rlen };
  return { dx: 1, dz: 0 };
}

/**
 * Allocate residential ribbons along roads.
 *
 * @param {object} opts
 * @param {Float32Array} opts.valueLayer - residential value bitmap
 * @param {Grid2D} opts.resGrid - reservation grid (read + write)
 * @param {Grid2D} opts.zoneGrid - zone eligibility
 * @param {Grid2D} opts.roadGrid - road cells
 * @param {Grid2D} opts.slope - slope grid
 * @param {Float32Array|null} opts.devProximity
 * @param {number} opts.resType - reservation type to write
 * @param {number} opts.budget - max cells to claim
 * @param {number} opts.plotDepth - cells per strip
 * @param {number} opts.gapWidth - cells between strips (becomes street)
 * @param {number} opts.maxRibbonLength - max cells along road before cross street
 * @param {number} opts.seedCount - number of road seed locations
 * @param {number} opts.noise - random noise for organic shapes
 * @param {number} opts.w - grid width
 * @param {number} opts.h - grid height
 * @param {number} opts.cellSize
 * @returns {{ claimed: Array<{gx,gz}>, ribbonGaps: Array<{gx,gz}>, ribbonEndpoints: Array<{gx,gz,dx,dz}> }}
 */
export function allocateRibbon({
  valueLayer, resGrid, zoneGrid, roadGrid, slope, devProximity,
  resType, budget, plotDepth, gapWidth, maxRibbonLength,
  seedCount, noise, w, h, cellSize,
}) {
  const claimed = [];
  const ribbonGaps = [];
  const ribbonEndpoints = [];

  if (budget <= 0) return { claimed, ribbonGaps, ribbonEndpoints };

  // Step 1: Find road-adjacent cells with high value as seed points
  const seeds = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (roadGrid.get(gx, gz) === 0) continue;
      // Check if this road cell has unclaimed zone cells nearby
      let hasSpace = false;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h &&
            zoneGrid.get(nx, nz) > 0 &&
            resGrid.get(nx, nz) === RESERVATION.NONE &&
            roadGrid.get(nx, nz) === 0) {
          hasSpace = true;
          break;
        }
      }
      if (!hasSpace) continue;

      // Average value of nearby non-road cells
      let sum = 0, count = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) === 0) {
          sum += valueLayer[nz * w + nx];
          count++;
        }
      }
      if (count > 0) seeds.push({ gx, gz, value: sum / count });
    }
  }

  seeds.sort((a, b) => b.value - a.value);

  // Pick spaced seeds
  const selectedSeeds = [];
  const minSpacingSq = maxRibbonLength * maxRibbonLength;
  for (const s of seeds) {
    if (selectedSeeds.length >= seedCount) break;
    let tooClose = false;
    for (const sel of selectedSeeds) {
      const dx = s.gx - sel.gx, dz = s.gz - sel.gz;
      if (dx * dx + dz * dz < minSpacingSq) { tooClose = true; break; }
    }
    if (!tooClose) selectedSeeds.push(s);
  }

  // Step 2: For each seed, lay out ribbon strips on both sides of the road
  for (const seed of selectedSeeds) {
    if (claimed.length >= budget) break;

    const dir = ribbonDirection(seed.gx, seed.gz, roadGrid, slope, w, h);
    // Perpendicular to ribbon direction = perpendicular to road = into the plots
    const perpX = -dir.dz;
    const perpZ = dir.dx;

    // Lay ribbons on both sides of the road
    for (const side of [1, -1]) {
      if (claimed.length >= budget) break;

      let ribbonLen = 0;

      // Walk along the road from the seed
      for (let along = -Math.floor(maxRibbonLength / 2); along <= Math.floor(maxRibbonLength / 2); along++) {
        if (claimed.length >= budget) break;

        const roadX = seed.gx + Math.round(dir.dx * along);
        const roadZ = seed.gz + Math.round(dir.dz * along);

        if (roadX < 0 || roadX >= w || roadZ < 0 || roadZ >= h) continue;
        if (roadGrid.get(roadX, roadZ) === 0) continue; // only along road

        // Lay strips perpendicular: plot, plot..., gap, plot, plot..., gap...
        let d = 1; // start 1 cell from road
        let stripCount = 0;

        while (d < 20) { // reasonable max distance
          // Claim plotDepth cells
          for (let pd = 0; pd < plotDepth; pd++) {
            if (claimed.length >= budget) break;
            const gx = roadX + Math.round(perpX * side * (d + pd));
            const gz = roadZ + Math.round(perpZ * side * (d + pd));

            if (gx < 0 || gx >= w || gz < 0 || gz >= h) break;
            if (zoneGrid.get(gx, gz) === 0) break;
            if (resGrid.get(gx, gz) !== RESERVATION.NONE) break;
            if (roadGrid.get(gx, gz) > 0) break;
            if (devProximity !== null && devProximity[gz * w + gx] === 0) break;

            const val = valueLayer[gz * w + gx];
            if (val <= 0) break;

            resGrid.set(gx, gz, resType);
            claimed.push({ gx, gz });
          }
          d += plotDepth;

          // Leave gap (future street)
          for (let gd = 0; gd < gapWidth; gd++) {
            const gx = roadX + Math.round(perpX * side * (d + gd));
            const gz = roadZ + Math.round(perpZ * side * (d + gd));
            if (gx >= 0 && gx < w && gz >= 0 && gz < h &&
                zoneGrid.get(gx, gz) > 0 &&
                resGrid.get(gx, gz) === RESERVATION.NONE &&
                roadGrid.get(gx, gz) === 0) {
              ribbonGaps.push({ gx, gz });
            }
          }
          d += gapWidth;

          stripCount++;
          if (stripCount >= 3) break; // max 3 strips per side
        }

        ribbonLen++;
      }

      // Record endpoints for cross streets
      const startX = seed.gx + Math.round(dir.dx * (-Math.floor(maxRibbonLength / 2)));
      const startZ = seed.gz + Math.round(dir.dz * (-Math.floor(maxRibbonLength / 2)));
      const endX = seed.gx + Math.round(dir.dx * Math.floor(maxRibbonLength / 2));
      const endZ = seed.gz + Math.round(dir.dz * Math.floor(maxRibbonLength / 2));

      // Cross street perpendicular at ribbon start and end
      ribbonEndpoints.push(
        { gx: startX, gz: startZ, dx: perpX * side, dz: perpZ * side },
        { gx: endX, gz: endZ, dx: perpX * side, dz: perpZ * side },
      );
    }
  }

  return { claimed, ribbonGaps, ribbonEndpoints };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/allocateRibbon.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/allocateRibbon.js test/city/pipeline/allocateRibbon.test.js
git commit -m "feat: add residential ribbon allocator (terraced strips with gaps for streets)"
```

---

## Chunk 3: Road Growth

### Task 3: growRoads.js

**Files:**
- Create: `src/city/pipeline/growRoads.js`
- Create: `test/city/pipeline/growRoads.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/city/pipeline/growRoads.test.js
import { describe, it, expect } from 'vitest';
import { growRoads } from '../../../src/city/pipeline/growRoads.js';
import { Grid2D } from '../../../src/core/Grid2D.js';

function makeGrid(w, h, type = 'uint8') {
  return new Grid2D(w, h, { type, cellSize: 5, originX: 0, originZ: 0 });
}

describe('growRoads', () => {
  it('marks ribbon gaps as road cells', () => {
    const w = 20, h = 20;
    const roadGrid = makeGrid(w, h);
    const ribbonGaps = [
      { gx: 5, gz: 5 }, { gx: 6, gz: 5 }, { gx: 7, gz: 5 },
    ];

    growRoads({ roadGrid, ribbonGaps, ribbonEndpoints: [], w, h,
      maxCrossStreetLength: 10, pathClosingDistance: 10 });

    for (const g of ribbonGaps) {
      expect(roadGrid.get(g.gx, g.gz)).toBe(1);
    }
  });

  it('extends cross streets from ribbon endpoints', () => {
    const w = 30, h = 30;
    const roadGrid = makeGrid(w, h);

    // Existing road along row 15
    for (let x = 0; x < w; x++) roadGrid.set(x, 15, 1);

    // Ribbon endpoint wanting to extend upward
    const ribbonEndpoints = [
      { gx: 15, gz: 14, dx: 0, dz: -1 }, // extend upward from road
    ];

    growRoads({ roadGrid, ribbonGaps: [], ribbonEndpoints, w, h,
      maxCrossStreetLength: 10, pathClosingDistance: 10 });

    // Should have placed some road cells above row 15
    let newRoadCells = 0;
    for (let z = 0; z < 14; z++) {
      if (roadGrid.get(15, z) > 0) newRoadCells++;
    }
    expect(newRoadCells).toBeGreaterThan(0);
    expect(newRoadCells).toBeLessThanOrEqual(10); // max cross street length
  });

  it('connects cross streets to nearby existing roads', () => {
    const w = 30, h = 30;
    const roadGrid = makeGrid(w, h);

    // Two parallel roads
    for (let x = 0; x < w; x++) {
      roadGrid.set(x, 10, 1);
      roadGrid.set(x, 20, 1);
    }

    // Cross street starting from road at row 10, extending toward road at row 20
    const ribbonEndpoints = [
      { gx: 15, gz: 11, dx: 0, dz: 1 },
    ];

    growRoads({ roadGrid, ribbonGaps: [], ribbonEndpoints, w, h,
      maxCrossStreetLength: 20, pathClosingDistance: 15 });

    // Should have connected: road cells from row 11 to row 20
    let connected = true;
    for (let z = 11; z < 20; z++) {
      if (roadGrid.get(15, z) === 0) { connected = false; break; }
    }
    expect(connected).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/growRoads.test.js`

- [ ] **Step 3: Implement growRoads.js**

```js
// src/city/pipeline/growRoads.js
/**
 * Incremental road growth during ticks.
 * - Marks ribbon gaps as road cells
 * - Extends cross streets from ribbon endpoints
 * - Closes paths between nearby road endpoints
 */

/**
 * Grow roads from ribbon allocation results.
 *
 * @param {object} opts
 * @param {Grid2D} opts.roadGrid - road grid (read + write)
 * @param {Array<{gx,gz}>} opts.ribbonGaps - gap cells from ribbon allocation
 * @param {Array<{gx,gz,dx,dz}>} opts.ribbonEndpoints - cross street start points
 * @param {number} opts.w - grid width
 * @param {number} opts.h - grid height
 * @param {number} opts.maxCrossStreetLength - max cells for cross streets
 * @param {number} opts.pathClosingDistance - max gap to bridge between endpoints
 */
export function growRoads({
  roadGrid, ribbonGaps, ribbonEndpoints, w, h,
  maxCrossStreetLength, pathClosingDistance,
}) {
  // Step 1: Mark ribbon gaps as road cells
  for (const g of ribbonGaps) {
    if (g.gx >= 0 && g.gx < w && g.gz >= 0 && g.gz < h) {
      roadGrid.set(g.gx, g.gz, 1);
    }
  }

  // Step 2: Extend cross streets from ribbon endpoints
  for (const ep of ribbonEndpoints) {
    let gx = ep.gx;
    let gz = ep.gz;
    const dx = Math.round(ep.dx);
    const dz = Math.round(ep.dz);

    if (dx === 0 && dz === 0) continue;

    for (let i = 0; i < maxCrossStreetLength; i++) {
      gx += dx;
      gz += dz;

      if (gx < 0 || gx >= w || gz < 0 || gz >= h) break;

      // Hit an existing road — form junction and stop
      if (roadGrid.get(gx, gz) > 0) break;

      // Check if close to an existing road — bridge the gap
      let nearRoad = false;
      for (let d = 1; d <= Math.min(3, pathClosingDistance); d++) {
        const nx = gx + dx * d;
        const nz = gz + dz * d;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
          // Bridge to it
          for (let b = 0; b < d; b++) {
            const bx = gx + dx * b;
            const bz = gz + dz * b;
            if (bx >= 0 && bx < w && bz >= 0 && bz < h) {
              roadGrid.set(bx, bz, 1);
            }
          }
          nearRoad = true;
          break;
        }
      }
      if (nearRoad) break;

      // Place road cell
      roadGrid.set(gx, gz, 1);
    }
  }

  // Step 3: Path closing — find pairs of dead-end road cells and connect them
  // Collect road endpoints (cells with exactly 1 road neighbour)
  const deadEnds = [];
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      if (roadGrid.get(gx, gz) === 0) continue;
      let neighbours = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if (roadGrid.get(gx + dx, gz + dz) > 0) neighbours++;
      }
      if (neighbours === 1) {
        deadEnds.push({ gx, gz });
      }
    }
  }

  // Try to connect nearby dead ends
  const maxDistSq = pathClosingDistance * pathClosingDistance;
  const connected = new Set();

  for (let i = 0; i < deadEnds.length; i++) {
    if (connected.has(i)) continue;
    const a = deadEnds[i];

    for (let j = i + 1; j < deadEnds.length; j++) {
      if (connected.has(j)) continue;
      const b = deadEnds[j];

      const dx = b.gx - a.gx;
      const dz = b.gz - a.gz;
      const distSq = dx * dx + dz * dz;

      if (distSq > maxDistSq || distSq < 4) continue; // too far or too close

      // Draw a straight line between them
      const steps = Math.max(Math.abs(dx), Math.abs(dz));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const rx = Math.round(a.gx + dx * t);
        const rz = Math.round(a.gz + dz * t);
        if (rx >= 0 && rx < w && rz >= 0 && rz < h) {
          roadGrid.set(rx, rz, 1);
        }
      }

      connected.add(i);
      connected.add(j);
      break; // each dead end connects to at most one other
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/growRoads.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/growRoads.js test/city/pipeline/growRoads.test.js
git commit -m "feat: add incremental road growth (ribbon gaps, cross streets, path closing)"
```

---

## Chunk 4: Integration

### Task 4: Wire allocators into growthTick.js

**Files:**
- Modify: `src/city/pipeline/growthTick.js`
- Modify: `src/city/archetypes.js`

- [ ] **Step 1: Update growthTick to dispatch to correct allocator**

In `growthTick.js`, import the new allocators:

```js
import { allocateFrontage } from './allocateFrontage.js';
import { allocateRibbon } from './allocateRibbon.js';
import { growRoads } from './growRoads.js';
```

In the allocation loop (Phase 3), dispatch based on `agentConfig.allocator`:

```js
let newCells;
const allocatorType = agentConfig.allocator || 'blob';

if (allocatorType === 'frontage') {
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  newCells = allocateFrontage({
    valueLayer, resGrid, zoneGrid, roadGrid, devProximity,
    resType, budget,
    maxDepth: agentConfig.maxDepth || 3,
    valueThreshold: agentConfig.valueThreshold || 0.3,
    w, h,
  });
} else if (allocatorType === 'ribbon') {
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const slopeGrid = map.hasLayer('slope') ? map.getLayer('slope') : null;
  const result = allocateRibbon({
    valueLayer, resGrid, zoneGrid, roadGrid, slope: slopeGrid, devProximity,
    resType, budget,
    plotDepth: agentConfig.plotDepth || 3,
    gapWidth: agentConfig.gapWidth || 1,
    maxRibbonLength: agentConfig.maxRibbonLength || 30,
    seedCount: agentConfig.seedCount || 5,
    noise: agentConfig.noise || 0.1,
    w, h, cellSize: map.cellSize,
  });
  newCells = result.claimed;
  // Collect ribbon data for road growth step
  allRibbonGaps.push(...result.ribbonGaps);
  allRibbonEndpoints.push(...result.ribbonEndpoints);
} else {
  // Default: BFS blob (existing allocateFromValueBitmap)
  newCells = allocateFromValueBitmap({
    valueLayer, resGrid, zoneGrid, devProximity, resType, budget,
    minFootprint: agentConfig.minFootprint || 1,
    seedCount: agentConfig.seedCount || 3,
    minSpacing: agentConfig.minSpacing || 20,
    noise: agentConfig.noise != null ? agentConfig.noise : 0.15,
    w, h,
  });
}
```

Add ribbon data collectors before the agent loop:

```js
const allRibbonGaps = [];
const allRibbonEndpoints = [];
```

After the agent loop (before agriculture), add the road growth step:

```js
// Phase 4: ROADS — grow streets from ribbon results
const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
if (roadGrid && (allRibbonGaps.length > 0 || allRibbonEndpoints.length > 0)) {
  const roadConfig = growth.roadGrowth || {};
  growRoads({
    roadGrid,
    ribbonGaps: allRibbonGaps,
    ribbonEndpoints: allRibbonEndpoints,
    w, h,
    maxCrossStreetLength: roadConfig.maxCrossStreetLength || 40,
    pathClosingDistance: roadConfig.pathClosingDistance || 30,
  });
}
```

- [ ] **Step 2: Update marketTown archetype config**

In `archetypes.js`, update the agent configs to use the new allocator types and parameters. Use the config from the spec:

```js
agents: {
  commercial: {
    share: 0.12, budgetPerTick: 0.03,
    allocator: 'frontage',
    maxDepth: 4, valueThreshold: 0.3,
  },
  industrial: {
    share: 0.08, budgetPerTick: 0.02,
    allocator: 'blob',
    minFootprint: 50, seedCount: 2, minSpacing: 80, noise: 0.1,
  },
  civic: {
    share: 0.05, budgetPerTick: 0.01,
    allocator: 'blob',
    minFootprint: 20, seedCount: 4, minSpacing: 40, noise: 0.05,
  },
  openSpace: {
    share: 0.08, budgetPerTick: 0.02,
    allocator: 'blob',
    minFootprint: 30, seedCount: 3, minSpacing: 50, noise: 0.1,
  },
  agriculture: { share: 0.15 },
  residentialFine: {
    share: 0.30, budgetPerTick: 0.06,
    allocator: 'ribbon',
    plotDepth: 3, gapWidth: 1, maxRibbonLength: 30,
    seedCount: 12, noise: 0.2,
  },
  residentialEstate: {
    share: 0.10, budgetPerTick: 0.03,
    allocator: 'ribbon',
    plotDepth: 5, gapWidth: 2, maxRibbonLength: 40,
    seedCount: 3, noise: 0.1,
  },
  residentialQuality: {
    share: 0.12, budgetPerTick: 0.03,
    allocator: 'ribbon',
    plotDepth: 6, gapWidth: 3, maxRibbonLength: 20,
    seedCount: 5, noise: 0.15,
  },
},
roadGrowth: {
  maxCrossStreetLength: 40,
  pathClosingDistance: 30,
},
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run --exclude 'test/rendering/prepareCityScene.test.js' --exclude 'test/city/strategies/landFirstDevelopment.test.js'`

- [ ] **Step 4: Commit**

```bash
git add src/city/pipeline/growthTick.js src/city/archetypes.js
git commit -m "feat: wire typed allocators and road growth into growth tick pipeline"
```

### Task 5: Render and verify

- [ ] **Step 1: Generate renders**

```bash
bun scripts/render-reservations.js 884469 27 95 50
bun scripts/render-reservations.js 42 15 50 50
bun scripts/render-reservations.js 12345 20 60 50
```

Convert and inspect. Verify:
- Commercial forms thin strips along roads (not blobs)
- Residential shows ribbon pattern (alternating strips and gaps)
- Road grid has new streets (ribbon gaps and cross streets)
- Industrial/civic/openSpace still form blobs (unchanged)

- [ ] **Step 2: Commit renders**

```bash
git add -u && git add output/
git commit -m "feat: typed allocators complete — renders from 3 seeds"
```
