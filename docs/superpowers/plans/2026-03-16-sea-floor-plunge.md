# Sea Floor Plunge Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate small islands in the sea by making underwater terrain drop steeply, carving river mouths below sea level, and widening the building flood margin.

**Architecture:** Three changes: (1) fix the -0.5m sea floor clamp that undoes existing coastal depth, (2) add a post-hydrology plunge pass in the pipeline, (3) modify floodplain targets and building margins. The plunge pass runs after `generateHydrology` in `pipeline.js` (not in `generateTerrain.js` as the spec suggests) because it needs `waterMask` which is only available after hydrology. The spec's pipeline order diagram was inconsistent on this point.

**Tech Stack:** JavaScript, Grid2D, vitest

**Spec:** `docs/superpowers/specs/2026-03-16-sea-floor-plunge-design.md`

**Note on spec deviations:**
- Plunge pass is in a new file `seaFloorPlunge.js` wired into `pipeline.js`, not in `generateTerrain.js` — because `waterMask` isn't available until after hydrology.
- Uses existing `FLOODPLAIN_COAST_RANGE_M = 500m` instead of spec's `RIVER_MOUTH_RAMP_DIST = 400m` — reusing existing coast proximity avoids a separate distance computation.

---

## Chunk 1: Fix Sea Floor Clamp & Plunge Pass

### Task 1: Fix the -0.5m sea floor clamp

The clamp `Math.max(h, seaLevel - 0.5)` in `applyTerrainFields` prevents any terrain from going more than 0.5m below sea level after valley carving. This undoes the existing coastal falloff (`SUB_SEA_DEPTH_BASE=10`, `SUB_SEA_DEPTH_SCALE=20`) that pushes ocean 10-30m deep. This is likely the #1 root cause.

**Files:**
- Modify: `src/regional/carveValleys.js:186`
- Test: `test/regional/carveValleys.test.js`

- [ ] **Step 1: Write failing test — sea floor clamp allows deep water**

Add to `test/regional/carveValleys.test.js`:

```javascript
it('does not clamp elevation above -0.5m for deep water', () => {
  // Elevation already at -10m (from coastal falloff in generateTerrain)
  const elevation = makeElevation(64, 64, 50, -10);
  const depthField = new Grid2D(64, 64, { cellSize: 50 });
  const floodField = new Grid2D(64, 64, { cellSize: 50 });
  const floodTarget = new Grid2D(64, 64, { cellSize: 50 });

  applyTerrainFields(elevation, depthField, floodField, floodTarget, 0);
  // Should preserve the -10m elevation, not clamp to -0.5m
  expect(elevation.get(32, 32)).toBeLessThan(-5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/carveValleys.test.js --reporter=verbose`
Expected: FAIL — elevation gets clamped to -0.5

- [ ] **Step 3: Fix the clamp**

In `src/regional/carveValleys.js`, line 186, change:

```javascript
// OLD:
h = Math.max(h, seaLevel - 0.5);

// NEW:
const SEA_FLOOR_CLAMP = -50;
h = Math.max(h, seaLevel + SEA_FLOOR_CLAMP);
```

Move `SEA_FLOOR_CLAMP` to a module-level constant alongside the other constants at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regional/carveValleys.test.js --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/regional/carveValleys.js test/regional/carveValleys.test.js
git commit -m "fix: raise sea floor clamp from -0.5m to -50m"
```

---

### Task 2: Add sea floor plunge pass

After `generateHydrology` runs in the pipeline, add a plunge pass that forces all water-mask cells deep below sea level, scaling with distance from land and rock hardness.

**Files:**
- Create: `src/regional/seaFloorPlunge.js`
- Modify: `src/regional/pipeline.js` (after line ~111, after hydrology)
- Test: `test/regional/seaFloorPlunge.test.js`

- [ ] **Step 1: Write failing test for plunge function**

Create `test/regional/seaFloorPlunge.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { applySeaFloorPlunge } from '../../src/regional/seaFloorPlunge.js';

function makeGrid(width, height, cellSize, fill) {
  return new Grid2D(width, height, { cellSize, fill });
}

describe('applySeaFloorPlunge', () => {
  it('pushes water-mask cells below sea level', () => {
    const elevation = makeGrid(20, 20, 50, 5); // all at 5m
    const waterMask = new Grid2D(20, 20, { type: 'uint8', cellSize: 50 });
    const resistance = makeGrid(20, 20, 50, 0.5);

    // Mark right half as water
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 10; gx < 20; gx++) {
        waterMask.set(gx, gz, 1);
      }
    }

    applySeaFloorPlunge(elevation, waterMask, resistance, 50, 0);

    // Water cells at the boundary should be well below sea level
    expect(elevation.get(10, 10)).toBeLessThan(-2);
    // Water cells further out should be even deeper
    expect(elevation.get(15, 10)).toBeLessThan(elevation.get(10, 10));
    // Land cells should be untouched
    expect(elevation.get(5, 10)).toBe(5);
  });

  it('hard rock produces steeper drop-off than soft rock', () => {
    const elevHard = makeGrid(20, 20, 50, 5);
    const elevSoft = makeGrid(20, 20, 50, 5);
    const waterMask = new Grid2D(20, 20, { type: 'uint8', cellSize: 50 });
    const hard = makeGrid(20, 20, 50, 0.9);
    const soft = makeGrid(20, 20, 50, 0.1);

    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 10; gx < 20; gx++) {
        waterMask.set(gx, gz, 1);
      }
    }

    applySeaFloorPlunge(elevHard, waterMask, hard, 50, 0);
    applySeaFloorPlunge(elevSoft, waterMask, soft, 50, 0);

    // Hard rock should be deeper at same distance from shore
    expect(elevHard.get(15, 10)).toBeLessThan(elevSoft.get(15, 10));
  });

  it('does not modify land cells', () => {
    const elevation = makeGrid(20, 20, 50, 50);
    const waterMask = new Grid2D(20, 20, { type: 'uint8', cellSize: 50 });
    const resistance = makeGrid(20, 20, 50, 0.5);

    waterMask.set(15, 10, 1);

    applySeaFloorPlunge(elevation, waterMask, resistance, 50, 0);

    expect(elevation.get(5, 10)).toBe(50);
    expect(elevation.get(10, 10)).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/seaFloorPlunge.test.js --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the plunge function**

Create `src/regional/seaFloorPlunge.js`:

```javascript
/**
 * Sea floor plunge pass — forces water-mask cells steeply below sea level.
 * Runs after hydrology so waterMask is available.
 *
 * For each water cell, compute distance to nearest land cell (BFS),
 * then set elevation = min(current, -(depthBase + dist * dropRate)).
 * Rock hardness modulates steepness: hard rock = steeper cliffs.
 */
import { Grid2D } from '../core/Grid2D.js';

// Depth at the first underwater cell (minimum plunge)
const PLUNGE_DEPTH_BASE_HARD = 5;   // meters
const PLUNGE_DEPTH_BASE_SOFT = 3;

// Slope of drop-off (meters depth per meter horizontal distance)
const PLUNGE_SLOPE_HARD = 0.08;
const PLUNGE_SLOPE_SOFT = 0.04;

/**
 * BFS land distance: for each water cell, distance to nearest non-water cell.
 * Returns distance in cells (multiply by cellSize for meters).
 */
function computeLandDistance(waterMask, width, height) {
  const dist = new Float32Array(width * height);
  dist.fill(Infinity);

  const queue = [];
  // Seed: land cells adjacent to water
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (waterMask.get(gx, gz) === 0) {
        // Check if any neighbor is water
        for (const [dx, dz] of dirs) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < height && waterMask.get(nx, nz) > 0) {
            dist[gz * width + gx] = 0; // land cell at water boundary
            queue.push(gx | (gz << 16));
            break;
          }
        }
      }
    }
  }

  // BFS from boundary land cells into water
  let head = 0;
  while (head < queue.length) {
    const packed = queue[head++];
    const cx = packed & 0xFFFF;
    const cz = packed >> 16;
    const cd = dist[cz * width + cx];

    for (const [dx, dz] of dirs) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      if (waterMask.get(nx, nz) === 0) continue; // only propagate into water
      const idx = nz * width + nx;
      if (dist[idx] > cd + 1) {
        dist[idx] = cd + 1;
        queue.push(nx | (nz << 16));
      }
    }
  }

  return dist;
}

/**
 * Apply sea floor plunge to elevation grid.
 *
 * @param {Grid2D} elevation - Modified in place
 * @param {Grid2D} waterMask - 1 = water, 0 = land
 * @param {Grid2D} erosionResistance - Rock hardness 0-1
 * @param {number} cellSize - Meters per cell
 * @param {number} seaLevel - Sea level elevation (typically 0)
 */
export function applySeaFloorPlunge(elevation, waterMask, erosionResistance, cellSize, seaLevel) {
  const { width, height } = elevation;
  const landDist = computeLandDistance(waterMask, width, height);

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (waterMask.get(gx, gz) === 0) continue; // skip land

      const distCells = landDist[gz * width + gx];
      if (!isFinite(distCells)) continue; // isolated water with no land neighbor

      const distMeters = distCells * cellSize;
      const resist = erosionResistance.get(gx, gz);

      // Interpolate between soft and hard parameters based on resistance
      const t = Math.min(1, Math.max(0, (resist - 0.3) / 0.3));
      const depthBase = PLUNGE_DEPTH_BASE_SOFT + t * (PLUNGE_DEPTH_BASE_HARD - PLUNGE_DEPTH_BASE_SOFT);
      const slope = PLUNGE_SLOPE_SOFT + t * (PLUNGE_SLOPE_HARD - PLUNGE_SLOPE_SOFT);

      const plungeElev = seaLevel - depthBase - distMeters * slope;
      const current = elevation.get(gx, gz);
      elevation.set(gx, gz, Math.min(current, plungeElev));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/regional/seaFloorPlunge.test.js --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Wire plunge pass into pipeline**

In `src/regional/pipeline.js`, add import at top:

```javascript
import { applySeaFloorPlunge } from './seaFloorPlunge.js';
```

After the hydrology block (after line ~111 where `waterMask` is stored in layers), add:

```javascript
  // Sea floor plunge: force underwater terrain steeply below sea level
  applySeaFloorPlunge(
    terrain.elevation, hydrology.waterMask, geology.erosionResistance, cellSize, seaLevel
  );
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/regional/seaFloorPlunge.js test/regional/seaFloorPlunge.test.js src/regional/pipeline.js
git commit -m "feat: add sea floor plunge pass to eliminate coastal islands"
```

---

## Chunk 2: River Mouth Carving & Flood Margin

### Task 3: Modify floodplain target to go below sea level

Change `computeFloodplainField` so the target elevation near the coast descends below sea level, scaled by river accumulation.

**Files:**
- Modify: `src/regional/carveValleys.js:131-133`
- Test: `test/regional/carveValleys.test.js`

- [ ] **Step 1: Write failing test for below-sea-level floodplain target**

Add to `test/regional/carveValleys.test.js`:

```javascript
describe('computeFloodplainField', () => {
  it('targets below sea level near coast for large rivers', () => {
    // Low elevation (3m) so terrain is within the floodplain guard window
    const elevation = makeElevation(64, 64, 50, 3);
    const resistance = makeResistance();
    const waterMask = new Grid2D(64, 64, { type: 'uint8', cellSize: 50 });

    // Mark bottom 2 rows as water (coast)
    for (let gx = 0; gx < 64; gx++) {
      for (let gz = 62; gz < 64; gz++) {
        waterMask.set(gx, gz, 1);
        elevation.set(gx, gz, -5);
      }
    }

    // River path running toward coast (south), large accumulation
    const paths = makeRiverPath(32, 30, 32, 61, 10000);

    const { floodplainTarget } = computeFloodplainField(
      paths, elevation, waterMask, resistance, 50, 0
    );

    // Near the coast, the target should be below sea level
    const targetNearCoast = floodplainTarget.get(32, 60);
    expect(targetNearCoast).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/carveValleys.test.js --reporter=verbose`
Expected: FAIL — target is 0 (clamped to seaLevel)

- [ ] **Step 3: Move river mouth depth constants to module level and modify floodplain target**

First, add constants at the top of `src/regional/carveValleys.js` (near the other constants):

```javascript
// River mouth depth below sea level
const RIVER_MOUTH_DEPTH_MIN = 1;  // meters below sea level for small rivers
const RIVER_MOUTH_DEPTH_MAX = 5;  // meters below sea level for large rivers
```

Then replace lines 131-133:

```javascript
// OLD:
const riverElev = elevation.get(cgx, cgz);
const targetElev = Math.max(seaLevel, riverElev);

// NEW:
const riverElev = elevation.get(cgx, cgz);
// Near coast, river mouth should descend below sea level
// Scale depth by accumulation: small rivers -1m, large rivers -5m
const accNorm = Math.min(1, Math.max(0, (acc - 500) / 9500)); // 500..10000
const mouthDepth = RIVER_MOUTH_DEPTH_MIN + accNorm * (RIVER_MOUTH_DEPTH_MAX - RIVER_MOUTH_DEPTH_MIN);
const coastTarget = seaLevel - mouthDepth * coastProximity;
const targetElev = Math.min(Math.max(seaLevel, riverElev), coastTarget);
```

This ensures:
- Far from coast (`coastProximity` ≈ 0): `coastTarget` ≈ `seaLevel`, so target stays at `seaLevel`
- At coast (`coastProximity` ≈ 1): `coastTarget` = `seaLevel - mouthDepth` (-1 to -5m)

- [ ] **Step 4: Fix the guard condition to allow negative targets**

The existing guard `currentElev <= targetElev + 5` was designed to only flatten terrain close to the target. With negative targets (e.g., -4.5m), terrain at 5m is 9.5m above the target, exceeding the 5m window. The guard must also prevent blending from raising already-deep terrain.

In `src/regional/carveValleys.js`, replace the inner loop condition at line 146-152:

```javascript
// OLD:
        // Only flatten terrain that's above target (don't raise valleys)
        if (currentElev <= targetElev + 5) {
          if (strength > field.get(gx, gz)) {
            field.set(gx, gz, strength);
            target.set(gx, gz, targetElev);
          }
        }

// NEW:
        // Only flatten terrain that's above target (don't raise valleys or plunged seabed)
        if (currentElev > targetElev && currentElev <= targetElev + 15) {
          if (strength > field.get(gx, gz)) {
            field.set(gx, gz, strength);
            target.set(gx, gz, targetElev);
          }
        }
```

Changes:
- `currentElev > targetElev`: prevents blending terrain already below the target back up
- Window widened from +5 to +15: allows the floodplain to pull terrain at 5m down to a -4.5m target (a 9.5m difference)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/regional/carveValleys.test.js --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/regional/carveValleys.js test/regional/carveValleys.test.js
git commit -m "feat: carve river mouths below sea level near coast"
```

---

### Task 4: Widen building flood margin

**Files:**
- Modify: `src/core/terrainSuitability.js:78-79`
- Test: `test/core/terrainSuitability.test.js`

- [ ] **Step 1: Write failing test for wider flood margin**

Add to `test/core/terrainSuitability.test.js`:

```javascript
it('returns 0 for low-lying land within 5 cells of water', () => {
  const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 2.5 }); // 2.5m above sea level
  const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
  const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });

  // Place water at cell (20, 25)
  waterMask.set(20, 25, 1);

  const { suitability } = computeTerrainSuitability(elevation, slope, waterMask);
  // Cell 3 cells from water at 2.5m elevation should be unbuildable
  expect(suitability.get(23, 25)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/terrainSuitability.test.js --reporter=verbose`
Expected: FAIL — suitability > 0 (old margin is only 2 cells, 2m)

- [ ] **Step 3: Update flood margin constants**

In `src/core/terrainSuitability.js`, change lines 78-79:

```javascript
// OLD:
const FLOOD_MARGIN_M = 2.0;
const FLOOD_MARGIN_DIST = 2;

// NEW:
const FLOOD_MARGIN_M = 3.0;
const FLOOD_MARGIN_DIST = 5;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/terrainSuitability.test.js --reporter=verbose`
Expected: ALL PASS (note: check existing tests still pass with wider margin)

- [ ] **Step 5: Commit**

```bash
git add src/core/terrainSuitability.js test/core/terrainSuitability.test.js
git commit -m "feat: widen building flood margin to 3m elevation, 5-cell distance"
```

---

### Task 5: Visual verification and final commit

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 2: Visual check**

Run the app and verify:
- No small islands in the sea
- Clean coastline boundary
- River mouths flow naturally below sea level
- Buildings don't crowd to the water's edge on low-lying land
- Hard rock coastlines look steeper underwater than soft rock

- [ ] **Step 3: Final commit if any adjustments were needed**
