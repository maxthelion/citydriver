# Land-First Development Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace road-first development with land-first: find good buildable land, extract development zones, lay out parallel street ribbons within zones, then subdivide into plots.

**Architecture:** Grid resolution increases from 20m to 5m. Revised land value formula (flatness + proximity) replaces current source-painting + blur. New `LandFirstDevelopment` strategy class replaces `StripDevelopment` ticks 2+, using grid-based zone extraction then world-coordinate street layout. Existing skeleton roads (tick 1), nucleus placement, and building archetypes are unchanged.

**Tech Stack:** Three.js (3D rendering), Vitest (testing), vanilla ES modules. Grid2D for raster operations, PlanarGraph for road network, A* pathfinding.

**Spec:** `specs/v5/land-first-development.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/city/strategies/landFirstDevelopment.js` | Strategy class: zone extraction, ribbon layout, network connection |
| `src/city/zoneExtraction.js` | Morphological ops, flood-fill, zone boundary extraction |
| `src/city/ribbonLayout.js` | Parallel street placement, contour adjustment, cross streets |
| `test/city/strategies/landFirstDevelopment.test.js` | Integration tests for full strategy pipeline |
| `test/city/zoneExtraction.test.js` | Unit tests for zone extraction |
| `test/city/ribbonLayout.test.js` | Unit tests for ribbon layout |

### Modified Files

| File | Change |
|---|---|
| `src/city/constants.js` | `CITY_CELL_SIZE` 20 → 5 |
| `src/core/FeatureMap.js:786-896` | Rewrite `computeLandValue()` with new formula |
| `src/core/FeatureMap.js:17-26` | Update cell-count constants to meters |
| `src/core/FeatureMap.js:173-210` | Update `_computeInitialBuildability()` cell-count constants |
| `src/core/FeatureMap.js:215-253` | Update water distance BFS cutoff to meters |
| `src/city/setup.js:196-204` | Convert nucleus placement constants to meters |
| `src/city/placeBuildings.js:296-404` | Update `placeTerracedRows()` to work from ribbon parcels |
| `src/core/FeatureMap.js:173-210` | Store waterDist as `this.waterDist` for land value access |
| `src/rendering/debugLayers.js:536-554` | Add new debug layers to LAYERS array |
| `src/ui/CityScreen.js:10,45-46` | Swap StripDevelopment → LandFirstDevelopment |
| `src/ui/CompareScreen.js` | Swap StripDevelopment → LandFirstDevelopment |

---

## Chunk 1: Grid Resolution & Cell-Count Constant Audit

### Task 1: Change grid resolution to 5m

**Files:**
- Modify: `src/city/constants.js:8`
- Test: `test/core/FeatureMap.test.js`

- [ ] **Step 1: Update CITY_CELL_SIZE**

In `src/city/constants.js`, change line 8:
```javascript
export const CITY_CELL_SIZE = 5;       // meters per city grid cell
```

- [ ] **Step 2: Run existing tests to find breakages**

Run: `npm test -- --reporter verbose 2>&1 | head -100`

Tests that use hardcoded cell-count assumptions will break. This is expected and will guide the next tasks.

- [ ] **Step 3: Commit**

```bash
git add src/city/constants.js
git commit -m "feat: increase city grid resolution from 20m to 5m cells"
```

### Task 2: Convert FeatureMap cell-count constants to meters

**Files:**
- Modify: `src/core/FeatureMap.js:17-26, 173-210, 215-253`
- Test: `test/core/FeatureMap.test.js`

- [ ] **Step 1: Write test for resolution-independent buildability**

In `test/core/FeatureMap.test.js`, add:
```javascript
describe('resolution independence', () => {
  it('buildability is similar at different cell sizes', () => {
    // Same physical area, different resolutions
    const map10 = makeMap(30, 30, 10); // 300m × 300m
    const map5 = makeMap(60, 60, 5);   // 300m × 300m

    // Test near the edge (50m from boundary) where taper matters
    // At 10m cells: gx=5 (50m), at 5m cells: gx=10 (50m)
    const b10 = map10.buildability.get(5, 15);
    const b5 = map5.buildability.get(10, 30);
    // Should be within 0.15 of each other after constants converted to meters
    expect(Math.abs(b10 - b5)).toBeLessThan(0.15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/core/FeatureMap.test.js --reporter verbose`

Expected: FAIL — buildability will differ significantly because cell-count constants don't scale.

- [ ] **Step 3: Convert constants in FeatureMap.js**

At the top of `src/core/FeatureMap.js`, replace the cell-count constants (lines 17-26) with meter-based equivalents:

```javascript
// Land value constants (distances in meters, converted to cells at runtime)
const LV_BUILDABLE_FLOOR = 0.2;

// Buildability constants (meters)
const BUILD_EDGE_MARGIN_M = 60;         // was 3 cells × 20m
const BUILD_EDGE_TAPER_M = 160;         // was 8 cells × 20m
const BUILD_WATERFRONT_RANGE_M = 200;   // was 10 cells × 20m (buildability bonus range)
const BUILD_WATERFRONT_BONUS = 0.3;
const WATER_DIST_CUTOFF_M = 300;        // was 15 cells × 20m
```

In `_computeInitialBuildability()`, convert cell references to use `this.cellSize`:

```javascript
const edgeMargin = Math.round(BUILD_EDGE_MARGIN_M / this.cellSize);
const edgeTaper = Math.round(BUILD_EDGE_TAPER_M / this.cellSize);
const waterfrontRange = Math.round(BUILD_WATERFRONT_RANGE_M / this.cellSize);
```

In `_computeWaterDistance()`, change the cutoff:

```javascript
const cutoffCells = Math.round(WATER_DIST_CUTOFF_M / this.cellSize);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/core/FeatureMap.test.js --reporter verbose`

Expected: PASS — buildability now scales with resolution.

- [ ] **Step 5: Run full test suite**

Run: `npm test -- --reporter verbose`

Fix any other tests that break due to changed buildability values (update expected values if needed — the physical meaning should be preserved, only the cell counts change).

- [ ] **Step 6: Commit**

```bash
git add src/core/FeatureMap.js test/core/FeatureMap.test.js
git commit -m "refactor: convert FeatureMap cell-count constants to meters for resolution independence"
```

### Task 3: Convert nucleus placement constants to meters

**Files:**
- Modify: `src/city/setup.js:196-204`
- Test: `test/city/setup.test.js`

- [ ] **Step 1: Convert constants in setup.js**

At `src/city/setup.js` lines 196-204, replace cell-count constants with meter-based equivalents. Read `map.cellSize` and divide at runtime:

```javascript
// Nucleus placement — distances in meters
const NUCLEUS_MIN_SPACING_M = 300;          // was 15 cells × 20m
const NUCLEUS_SUPPRESSION_RADIUS_M = 800;   // was 40 cells × 20m
const NUCLEUS_WATERFRONT_DIST_M = 120;      // was 6 cells × 20m
```

Then in the placement code, convert to cells:
```javascript
const minSpacing = Math.round(NUCLEUS_MIN_SPACING_M / map.cellSize);
const suppressionRadius = Math.round(NUCLEUS_SUPPRESSION_RADIUS_M / map.cellSize);
const waterfrontDist = Math.round(NUCLEUS_WATERFRONT_DIST_M / map.cellSize);
```

Also check the candidate sampling step (line ~261): if `width > 200` use `step = 3` — at 5m cells the grid is 300 wide, so this triggers. Sampling every 3 cells = 15m which is fine.

- [ ] **Step 2: Run tests**

Run: `npm test -- test/city/setup.test.js --reporter verbose`

Fix any failures from changed constants.

- [ ] **Step 3: Commit**

```bash
git add src/city/setup.js test/city/setup.test.js
git commit -m "refactor: convert nucleus placement constants to meters"
```

---

## Chunk 2: Revised Land Value

### Task 4: Rewrite computeLandValue()

**Files:**
- Modify: `src/core/FeatureMap.js:786-896`
- Test: `test/core/FeatureMap.test.js`

- [ ] **Step 1: Write tests for new land value formula**

Add to `test/core/FeatureMap.test.js`:

```javascript
describe('revised land value', () => {
  it('flat ground near center has high value', () => {
    const map = makeMap(60, 60, 5);
    // Place a nucleus at center
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();
    // Center cell should have high value (flat + close to nucleus)
    expect(map.landValue.get(30, 30)).toBeGreaterThan(0.7);
  });

  it('flat ground far from center has lower value', () => {
    const map = makeMap(60, 60, 5);
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();
    const center = map.landValue.get(30, 30);
    const far = map.landValue.get(55, 55);
    expect(center).toBeGreaterThan(far);
  });

  it('steep ground has low value regardless of location', () => {
    const map = new FeatureMap(60, 60, 5);
    const elevation = new Grid2D(60, 60, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(60, 60, { cellSize: 5, fill: 0.35 }); // steep everywhere
    map.setTerrain(elevation, slope);
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();
    expect(map.landValue.get(30, 30)).toBeLessThan(0.3);
  });

  it('water proximity adds bonus to already-good land', () => {
    // Must set water BEFORE setTerrain so waterDist is computed correctly
    const map = new FeatureMap(60, 60, 5);
    const elevation = new Grid2D(60, 60, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(60, 60, { cellSize: 5, fill: 0.02 });
    for (let gz = 0; gz < 60; gz++) map.waterMask.set(0, gz, 1);
    map.setTerrain(elevation, slope);
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();
    // Cell near water should have bonus vs same-distance cell away from water
    const nearWater = map.landValue.get(5, 30);
    const awayFromWater = map.landValue.get(55, 30);
    // Near water is closer to edge (lower proximity) but has water bonus
    // Compare cells at same distance from nucleus but different water proximity
    const nearWater2 = map.landValue.get(30, 5);   // close to water edge
    const farWater2 = map.landValue.get(30, 55);    // far from water
    expect(nearWater2).toBeGreaterThan(farWater2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/core/FeatureMap.test.js -t "revised land value" --reporter verbose`

Expected: FAIL — current formula doesn't use nuclei.

- [ ] **Step 3: Rewrite computeLandValue()**

Replace the `computeLandValue()` method in `src/core/FeatureMap.js` (lines 786-896). Remove the old constants `LV_TOWN_CENTER`, `LV_WATERFRONT`, `LV_HILLTOP`, `LV_JUNCTION`, `LV_BRIDGE`, `LV_HILLTOP_MIN_PROMINENCE`, `LV_HILLTOP_PROMINENCE_SCALE`, `LV_BLUR_RADIUS` from the top of the file.

Add new constants:
```javascript
// Land value constants (meters)
const LV_FLATNESS_RADIUS_M = 15;       // local flatness averaging radius
const LV_FLATNESS_SLOPE_MAX = 0.4;     // slope at which flatness = 0
const LV_PROXIMITY_HALFLIFE_M = 200;   // distance at which proximity = 0.5
const LV_WATER_BONUS_RANGE_M = 50;     // water bonus range
const LV_WATER_BONUS_MAX = 0.15;       // max water bonus
const LV_BUILDABLE_FLOOR = 0.2;        // minimum value for buildable land
```

New `computeLandValue()`:
```javascript
computeLandValue() {
  const { width, height, cellSize } = this;
  const nuclei = this.nuclei || [];
  if (nuclei.length === 0) return;

  const flatRadius = Math.max(1, Math.round(LV_FLATNESS_RADIUS_M / cellSize));
  const waterRange = Math.round(LV_WATER_BONUS_RANGE_M / cellSize);

  // Pre-compute local average slope (box filter of radius flatRadius)
  const avgSlope = new Grid2D(width, height, { type: 'float32' });
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      let sum = 0, count = 0;
      const r = flatRadius;
      const x0 = Math.max(0, gx - r), x1 = Math.min(width - 1, gx + r);
      const z0 = Math.max(0, gz - r), z1 = Math.min(height - 1, gz + r);
      for (let zz = z0; zz <= z1; zz++) {
        for (let xx = x0; xx <= x1; xx++) {
          sum += this.slope.get(xx, zz);
          count++;
        }
      }
      avgSlope.set(gx, gz, sum / count);
    }
  }

  // Compute land value per cell
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (this.waterMask.get(gx, gz) > 0) {
        this.landValue.set(gx, gz, 0);
        continue;
      }

      // Flatness: 1.0 for flat, 0 for slope >= LV_FLATNESS_SLOPE_MAX
      const localSlope = avgSlope.get(gx, gz);
      const flatness = Math.max(0, 1.0 - localSlope / LV_FLATNESS_SLOPE_MAX);

      // Proximity to nearest nucleus
      const wx = this.originX + gx * cellSize;
      const wz = this.originZ + gz * cellSize;
      let minDist = Infinity;
      for (const n of nuclei) {
        const nx = this.originX + n.gx * cellSize;
        const nz = this.originZ + n.gz * cellSize;
        const d = Math.sqrt((wx - nx) ** 2 + (wz - nz) ** 2);
        if (d < minDist) minDist = d;
      }
      const proximity = 1.0 / (1.0 + minDist / LV_PROXIMITY_HALFLIFE_M);

      // Base value
      const base = flatness * 0.6 + proximity * 0.4;

      // Water bonus (additive, only if buildable)
      let waterBonus = 0;
      if (this.buildability.get(gx, gz) > 0.1 && this.waterDist) {
        const wd = this.waterDist.get(gx, gz);
        if (wd > 0 && wd <= waterRange) {
          waterBonus = LV_WATER_BONUS_MAX * (1.0 - wd / waterRange);
        }
      }

      let value = base + waterBonus;

      // Floor for buildable land
      if (this.buildability.get(gx, gz) > LV_BUILDABLE_FLOOR) {
        value = Math.max(value, LV_BUILDABLE_FLOOR);
      }

      this.landValue.set(gx, gz, Math.min(1.0, value));
    }
  }
}
```

**Important**: In `_computeInitialBuildability()`, change the local variable `waterDist` to be stored on the instance so `computeLandValue()` can access it:
```javascript
// Change:  const waterDist = this._computeWaterDistance(cutoffCells);
// To:
this.waterDist = this._computeWaterDistance(cutoffCells);
const waterDist = this.waterDist;
```
This must be done in Task 2 (when converting cell-count constants) or at the start of this task.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/core/FeatureMap.test.js --reporter verbose`

Expected: PASS for new land value tests. Fix any existing tests that relied on old formula output.

- [ ] **Step 5: Commit**

```bash
git add src/core/FeatureMap.js test/core/FeatureMap.test.js
git commit -m "feat: rewrite land value formula — flatness + proximity, water as bonus"
```

---

## Chunk 3: Zone Extraction

### Task 5: Implement zone extraction module

**Files:**
- Create: `src/city/zoneExtraction.js`
- Create: `test/city/zoneExtraction.test.js`

- [ ] **Step 1: Write tests for morphological close**

Create `test/city/zoneExtraction.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { morphClose, floodFillZones, extractZoneBoundary } from '../../src/city/zoneExtraction.js';

describe('morphClose', () => {
  it('fills small holes in a mask', () => {
    // 20×20 grid, all 1s except a 2×2 hole in the middle
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 1 });
    mask.set(10, 10, 0);
    mask.set(11, 10, 0);
    mask.set(10, 11, 0);
    mask.set(11, 11, 0);

    const closed = morphClose(mask, 2);
    // Hole should be filled
    expect(closed.get(10, 10)).toBe(1);
    expect(closed.get(11, 11)).toBe(1);
  });

  it('does not expand outer boundary', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 0 });
    // Small island of 1s
    for (let z = 8; z <= 12; z++)
      for (let x = 8; x <= 12; x++)
        mask.set(x, z, 1);

    const closed = morphClose(mask, 2);
    // Corners outside the original island should still be 0
    expect(closed.get(5, 5)).toBe(0);
    expect(closed.get(15, 15)).toBe(0);
    // Original island cells should still be 1
    expect(closed.get(10, 10)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/city/zoneExtraction.test.js --reporter verbose`

Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement morphClose**

Create `src/city/zoneExtraction.js`:

```javascript
import { Grid2D } from '../core/Grid2D.js';

/**
 * Morphological close (dilate then erode) on a binary grid.
 * Fills holes up to ~2*radius cells across without expanding the outer boundary.
 *
 * @param {Grid2D} mask - Binary grid (0 or 1)
 * @param {number} radius - Dilation/erosion radius in cells
 * @returns {Grid2D} New closed mask
 */
export function morphClose(mask, radius) {
  const { width, height } = mask;

  // Dilate: cell is 1 if any cell within radius is 1
  const dilated = new Grid2D(width, height, { type: 'uint8' });
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      let found = false;
      const x0 = Math.max(0, gx - radius), x1 = Math.min(width - 1, gx + radius);
      const z0 = Math.max(0, gz - radius), z1 = Math.min(height - 1, gz + radius);
      for (let zz = z0; zz <= z1 && !found; zz++) {
        for (let xx = x0; xx <= x1 && !found; xx++) {
          if (mask.get(xx, zz) > 0) found = true;
        }
      }
      dilated.set(gx, gz, found ? 1 : 0);
    }
  }

  // Erode: cell is 1 only if all cells within radius are 1
  const eroded = new Grid2D(width, height, { type: 'uint8' });
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      let allSet = true;
      const x0 = Math.max(0, gx - radius), x1 = Math.min(width - 1, gx + radius);
      const z0 = Math.max(0, gz - radius), z1 = Math.min(height - 1, gz + radius);
      for (let zz = z0; zz <= z1 && allSet; zz++) {
        for (let xx = x0; xx <= x1 && allSet; xx++) {
          if (dilated.get(xx, zz) === 0) allSet = false;
        }
      }
      eroded.set(gx, gz, allSet ? 1 : 0);
    }
  }

  return eroded;
}
```

- [ ] **Step 4: Run morphClose tests**

Run: `npm test -- test/city/zoneExtraction.test.js -t "morphClose" --reporter verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/zoneExtraction.js test/city/zoneExtraction.test.js
git commit -m "feat: add morphological close for zone extraction"
```

### Task 6: Implement flood-fill zone extraction

**Files:**
- Modify: `src/city/zoneExtraction.js`
- Modify: `test/city/zoneExtraction.test.js`

- [ ] **Step 1: Write tests for floodFillZones**

Add to `test/city/zoneExtraction.test.js`:

```javascript
describe('floodFillZones', () => {
  it('finds connected components', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 0 });
    // Two separate islands
    for (let z = 2; z <= 5; z++)
      for (let x = 2; x <= 5; x++) mask.set(x, z, 1);
    for (let z = 12; z <= 16; z++)
      for (let x = 12; x <= 16; x++) mask.set(x, z, 1);

    const zones = floodFillZones(mask, 1); // minSize = 1
    expect(zones.length).toBe(2);
  });

  it('filters zones by minimum size', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 0 });
    // Large island
    for (let z = 2; z <= 10; z++)
      for (let x = 2; x <= 10; x++) mask.set(x, z, 1);
    // Tiny island (4 cells)
    for (let z = 15; z <= 16; z++)
      for (let x = 15; x <= 16; x++) mask.set(x, z, 1);

    const zones = floodFillZones(mask, 10);
    expect(zones.length).toBe(1); // only the large one
    expect(zones[0].cells.length).toBeGreaterThan(10);
  });

  it('computes zone centroid', () => {
    const mask = new Grid2D(20, 20, { type: 'uint8', fill: 0 });
    for (let z = 5; z <= 15; z++)
      for (let x = 5; x <= 15; x++) mask.set(x, z, 1);

    const zones = floodFillZones(mask, 1);
    expect(zones.length).toBe(1);
    expect(zones[0].centroidGx).toBeCloseTo(10, 0);
    expect(zones[0].centroidGz).toBeCloseTo(10, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/city/zoneExtraction.test.js -t "floodFillZones" --reporter verbose`

- [ ] **Step 3: Implement floodFillZones**

Add to `src/city/zoneExtraction.js`:

```javascript
/**
 * Flood-fill connected components on a binary mask.
 * Returns array of zones, each with cells list and centroid.
 *
 * @param {Grid2D} mask - Binary grid
 * @param {number} minSize - Minimum zone size in cells
 * @returns {Array<{id: number, cells: Array<{gx: number, gz: number}>, centroidGx: number, centroidGz: number}>}
 */
export function floodFillZones(mask, minSize) {
  const { width, height } = mask;
  const visited = new Grid2D(width, height, { type: 'uint8' });
  const zones = [];
  let nextId = 1;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (mask.get(gx, gz) === 0 || visited.get(gx, gz) > 0) continue;

      // BFS flood fill
      const cells = [];
      const queue = [{ gx, gz }];
      visited.set(gx, gz, 1);

      while (queue.length > 0) {
        const cell = queue.shift();
        cells.push(cell);

        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cell.gx + dx, nz = cell.gz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
          if (visited.get(nx, nz) > 0 || mask.get(nx, nz) === 0) continue;
          visited.set(nx, nz, 1);
          queue.push({ gx: nx, gz: nz });
        }
      }

      if (cells.length < minSize) continue;

      let sumGx = 0, sumGz = 0;
      for (const c of cells) { sumGx += c.gx; sumGz += c.gz; }

      zones.push({
        id: nextId++,
        cells,
        centroidGx: sumGx / cells.length,
        centroidGz: sumGz / cells.length,
      });
    }
  }

  return zones;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/city/zoneExtraction.test.js --reporter verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/zoneExtraction.js test/city/zoneExtraction.test.js
git commit -m "feat: add flood-fill zone extraction with min size filter"
```

### Task 7: Implement zone boundary extraction

**Files:**
- Modify: `src/city/zoneExtraction.js`
- Modify: `test/city/zoneExtraction.test.js`

- [ ] **Step 1: Write test for boundary extraction**

Add to `test/city/zoneExtraction.test.js`:

```javascript
describe('extractZoneBoundary', () => {
  it('returns a closed polygon for a rectangular zone', () => {
    const cells = [];
    for (let gz = 5; gz <= 10; gz++)
      for (let gx = 5; gx <= 10; gx++)
        cells.push({ gx, gz });

    const boundary = extractZoneBoundary(cells, 5, 100, 100);
    // Should be a closed polygon (first point != last point, but forms a loop)
    expect(boundary.length).toBeGreaterThanOrEqual(4);
    // All points should be in world coordinates
    for (const pt of boundary) {
      expect(pt.x).toBeDefined();
      expect(pt.z).toBeDefined();
    }
  });

  it('boundary encloses zone cells', () => {
    const cells = [];
    for (let gz = 5; gz <= 10; gz++)
      for (let gx = 5; gx <= 10; gx++)
        cells.push({ gx, gz });

    const boundary = extractZoneBoundary(cells, 5, 0, 0);
    // Centroid should be inside boundary
    const cx = 7.5 * 5, cz = 7.5 * 5;
    expect(pointInPolygon(cx, cz, boundary)).toBe(true);
  });
});

// Helper for point-in-polygon (ray casting)
function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/city/zoneExtraction.test.js -t "extractZoneBoundary" --reporter verbose`

- [ ] **Step 3: Implement extractZoneBoundary**

Add to `src/city/zoneExtraction.js`:

```javascript
/**
 * Extract the outer boundary of a zone's cells as a world-coordinate polygon.
 * Uses cell-edge tracing: walks the boundary cells and emits vertices at cell corners.
 * Simplifies with Douglas-Peucker.
 *
 * @param {Array<{gx: number, gz: number}>} cells
 * @param {number} cellSize
 * @param {number} originX - World X origin of grid
 * @param {number} originZ - World Z origin of grid
 * @returns {Array<{x: number, z: number}>} Closed polygon in world coordinates
 */
export function extractZoneBoundary(cells, cellSize, originX, originZ) {
  // Build a set for O(1) lookup
  const cellSet = new Set();
  for (const c of cells) cellSet.add(`${c.gx},${c.gz}`);

  // Find boundary edges: cell edges where one side is in the zone and the other isn't
  // Each edge is stored as two corner points
  const edges = [];

  for (const c of cells) {
    const { gx, gz } = c;
    // Check 4 neighbors. If neighbor is NOT in set, the shared edge is a boundary edge.
    // Top edge (gz side): if (gx, gz-1) not in set
    if (!cellSet.has(`${gx},${gz - 1}`)) {
      edges.push({ x1: gx, z1: gz, x2: gx + 1, z2: gz });
    }
    // Bottom edge
    if (!cellSet.has(`${gx},${gz + 1}`)) {
      edges.push({ x1: gx + 1, z1: gz + 1, x2: gx, z2: gz + 1 });
    }
    // Left edge
    if (!cellSet.has(`${gx - 1},${gz}`)) {
      edges.push({ x1: gx, z1: gz + 1, x2: gx, z2: gz });
    }
    // Right edge
    if (!cellSet.has(`${gx + 1},${gz}`)) {
      edges.push({ x1: gx + 1, z1: gz, x2: gx + 1, z2: gz + 1 });
    }
  }

  if (edges.length === 0) return [];

  // Chain edges into a polygon by matching endpoints
  const edgeMap = new Map(); // "x,z" → [edges starting from that point]
  for (const e of edges) {
    const key = `${e.x1},${e.z1}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push(e);
  }

  // Walk the chain starting from the first edge
  const polygon = [];
  const startEdge = edges[0];
  let cx = startEdge.x1, cz = startEdge.z1;
  const used = new Set();

  for (let i = 0; i < edges.length; i++) {
    polygon.push({
      x: originX + cx * cellSize,
      z: originZ + cz * cellSize,
    });

    const key = `${cx},${cz}`;
    const candidates = edgeMap.get(key) || [];
    let found = false;
    for (const e of candidates) {
      const eKey = `${e.x1},${e.z1},${e.x2},${e.z2}`;
      if (used.has(eKey)) continue;
      used.add(eKey);
      cx = e.x2;
      cz = e.z2;
      found = true;
      break;
    }
    if (!found) break;
  }

  // Douglas-Peucker simplification
  return douglasPeucker(polygon, cellSize);
}

/**
 * Douglas-Peucker polyline simplification.
 */
function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points;

  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToLineDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function pointToLineDist(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.z - a.z) ** 2);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq));
  const projX = a.x + t * dx, projZ = a.z + t * dz;
  return Math.sqrt((p.x - projX) ** 2 + (p.z - projZ) ** 2);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/city/zoneExtraction.test.js --reporter verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/zoneExtraction.js test/city/zoneExtraction.test.js
git commit -m "feat: add zone boundary extraction with Douglas-Peucker simplification"
```

### Task 8: Add extractDevelopmentZones() orchestrator

**Files:**
- Modify: `src/city/zoneExtraction.js`
- Modify: `test/city/zoneExtraction.test.js`

- [ ] **Step 1: Write integration test**

Add to `test/city/zoneExtraction.test.js`:

```javascript
import { FeatureMap } from '../../src/core/FeatureMap.js';
import { extractDevelopmentZones } from '../../src/city/zoneExtraction.js';

describe('extractDevelopmentZones', () => {
  it('extracts zones from a flat map with nuclei', () => {
    const map = new FeatureMap(60, 60, 5);
    const elevation = new Grid2D(60, 60, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(60, 60, { cellSize: 5, fill: 0.02 });
    map.setTerrain(elevation, slope);
    map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
    map.computeLandValue();

    const zones = extractDevelopmentZones(map);
    expect(zones.length).toBeGreaterThan(0);
    // Each zone should have cells, boundary, and nucleus assignment
    for (const z of zones) {
      expect(z.cells.length).toBeGreaterThan(0);
      expect(z.boundary.length).toBeGreaterThanOrEqual(4);
      expect(z.nucleusIdx).toBeDefined();
      expect(z.avgSlope).toBeDefined();
      expect(z.priority).toBeGreaterThan(0);
    }
  });

  it('assigns zones to nearest nucleus', () => {
    const map = new FeatureMap(100, 100, 5);
    const elevation = new Grid2D(100, 100, { cellSize: 5, fill: 100 });
    const slope = new Grid2D(100, 100, { cellSize: 5, fill: 0.02 });
    map.setTerrain(elevation, slope);
    map.nuclei = [
      { gx: 25, gz: 50, type: 'market' },
      { gx: 75, gz: 50, type: 'suburban' },
    ];
    map.computeLandValue();

    const zones = extractDevelopmentZones(map);
    // Should have zones assigned to both nuclei
    const nuclei0 = zones.filter(z => z.nucleusIdx === 0);
    const nuclei1 = zones.filter(z => z.nucleusIdx === 1);
    expect(nuclei0.length).toBeGreaterThan(0);
    expect(nuclei1.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/city/zoneExtraction.test.js -t "extractDevelopmentZones" --reporter verbose`

- [ ] **Step 3: Implement extractDevelopmentZones**

Add to `src/city/zoneExtraction.js`:

```javascript
const ZONE_LV_THRESHOLD = 0.3;
const ZONE_BUILD_THRESHOLD = 0.2;
const ZONE_SLOPE_MAX = 0.2;
const ZONE_MORPH_RADIUS_M = 10;     // 2 cells at 5m
const ZONE_MIN_SIZE = 30;            // cells

/**
 * Full zone extraction pipeline: Voronoi assign → threshold → morph close → flood fill → metadata.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @returns {Array<Zone>}
 */
export function extractDevelopmentZones(map) {
  const { width, height, cellSize, nuclei } = map;
  if (!nuclei || nuclei.length === 0) return [];

  const morphRadius = Math.max(1, Math.round(ZONE_MORPH_RADIUS_M / cellSize));

  // Step 1: Voronoi assignment — each cell → nearest nucleus index
  const assignment = new Grid2D(width, height, { type: 'int32', fill: -1 });
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      let bestDist = Infinity, bestIdx = -1;
      for (let i = 0; i < nuclei.length; i++) {
        const dx = gx - nuclei[i].gx, dz = gz - nuclei[i].gz;
        const d = dx * dx + dz * dz; // squared is fine for comparison
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      assignment.set(gx, gz, bestIdx);
    }
  }

  // Step 2: Per-nucleus candidate masks
  const allZones = [];

  for (let ni = 0; ni < nuclei.length; ni++) {
    const mask = new Grid2D(width, height, { type: 'uint8' });
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        if (assignment.get(gx, gz) !== ni) continue;
        if (map.waterMask.get(gx, gz) > 0) continue;
        if (map.landValue.get(gx, gz) < ZONE_LV_THRESHOLD) continue;
        if (map.buildability.get(gx, gz) < ZONE_BUILD_THRESHOLD) continue;
        if (map.slope.get(gx, gz) >= ZONE_SLOPE_MAX) continue;
        mask.set(gx, gz, 1);
      }
    }

    // Step 3: Morphological close
    const closed = morphClose(mask, morphRadius);

    // Remove cells that were added by dilation but fail slope check
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        if (closed.get(gx, gz) > 0 && mask.get(gx, gz) === 0) {
          if (map.slope.get(gx, gz) >= ZONE_SLOPE_MAX) {
            closed.set(gx, gz, 0);
          }
        }
      }
    }

    // Step 4: Flood fill
    const zones = floodFillZones(closed, ZONE_MIN_SIZE);

    // Step 5: Compute metadata per zone
    const n = nuclei[ni];
    const nwx = map.originX + n.gx * cellSize;
    const nwz = map.originZ + n.gz * cellSize;

    for (const zone of zones) {
      // Average slope + gradient direction
      let slopeSum = 0, gradX = 0, gradZ = 0, lvSum = 0;
      for (const c of zone.cells) {
        slopeSum += map.slope.get(c.gx, c.gz);
        lvSum += map.landValue.get(c.gx, c.gz);

        // Gradient from elevation differences
        const e = map.elevation.get(c.gx, c.gz);
        if (c.gx > 0) gradX += e - map.elevation.get(c.gx - 1, c.gz);
        if (c.gz > 0) gradZ += e - map.elevation.get(c.gx, c.gz - 1);
      }

      const avgSlope = slopeSum / zone.cells.length;
      const gradLen = Math.sqrt(gradX * gradX + gradZ * gradZ);
      const slopeDir = gradLen > 0.01
        ? { x: gradX / gradLen, z: gradZ / gradLen }
        : { x: 0, z: 0 };

      // Distance from nucleus to zone centroid
      const cwx = map.originX + zone.centroidGx * cellSize;
      const cwz = map.originZ + zone.centroidGz * cellSize;
      const dist = Math.sqrt((cwx - nwx) ** 2 + (cwz - nwz) ** 2);

      // Boundary polygon
      const boundary = extractZoneBoundary(zone.cells, cellSize, map.originX, map.originZ);

      allZones.push({
        ...zone,
        nucleusIdx: ni,
        avgSlope,
        slopeDir,
        totalLandValue: lvSum,
        distFromNucleus: dist,
        priority: lvSum / Math.max(1, dist),
        boundary,
      });
    }
  }

  // Sort by priority (highest first)
  allZones.sort((a, b) => b.priority - a.priority);
  return allZones;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/city/zoneExtraction.test.js --reporter verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/zoneExtraction.js test/city/zoneExtraction.test.js
git commit -m "feat: add extractDevelopmentZones orchestrator with Voronoi assignment and priority ranking"
```

---

## Chunk 4: Ribbon Layout

### Task 9: Implement ribbon orientation solver

**Files:**
- Create: `src/city/ribbonLayout.js`
- Create: `test/city/ribbonLayout.test.js`

- [ ] **Step 1: Write tests**

Create `test/city/ribbonLayout.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { computeRibbonOrientation } from '../../src/city/ribbonLayout.js';

describe('computeRibbonOrientation', () => {
  it('returns contour-following direction for moderate slope', () => {
    // Slope direction pointing "east" (x=1, z=0), avg slope 0.15
    const result = computeRibbonOrientation({
      avgSlope: 0.15,
      slopeDir: { x: 1, z: 0 },
      centroidGx: 50, centroidGz: 50,
    }, { gx: 50, gz: 80 }, 5); // nucleus to the south

    // Contour-following: perpendicular to slope direction
    // Slope is east → streets run north-south (z direction)
    expect(Math.abs(result.dx)).toBeLessThan(0.2);
    expect(Math.abs(result.dz)).toBeCloseTo(1, 0);
  });

  it('returns nucleus-bearing direction for flat ground', () => {
    // Very flat, nucleus to the south
    const result = computeRibbonOrientation({
      avgSlope: 0.03,
      slopeDir: { x: 0, z: 0 },
      centroidGx: 50, centroidGz: 50,
    }, { gx: 50, gz: 80 }, 5);

    // Should point roughly toward nucleus (south)
    expect(result.dz).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/city/ribbonLayout.test.js --reporter verbose`

- [ ] **Step 3: Implement computeRibbonOrientation**

Create `src/city/ribbonLayout.js`:

```javascript
export const CONTOUR_SLOPE_THRESHOLD = 0.1;

/**
 * Compute the ribbon (street) orientation for a zone.
 * Returns a unit direction vector for the streets.
 *
 * - Slope > 0.1: contour-following (perpendicular to gradient)
 * - Slope <= 0.1: bearing toward nucleus
 *
 * @param {Object} zone - Zone with avgSlope, slopeDir, centroidGx, centroidGz
 * @param {Object} nucleus - { gx, gz }
 * @param {number} cellSize
 * @returns {{ dx: number, dz: number }} Unit direction vector for streets
 */
export function computeRibbonOrientation(zone, nucleus, cellSize) {
  if (zone.avgSlope > CONTOUR_SLOPE_THRESHOLD && (zone.slopeDir.x !== 0 || zone.slopeDir.z !== 0)) {
    // Contour-following: streets perpendicular to slope direction
    // Rotate slope direction 90 degrees
    const dx = -zone.slopeDir.z;
    const dz = zone.slopeDir.x;
    const len = Math.sqrt(dx * dx + dz * dz);
    return { dx: dx / len, dz: dz / len };
  }

  // Flat ground: bearing from zone centroid toward nucleus
  const bearX = nucleus.gx - zone.centroidGx;
  const bearZ = nucleus.gz - zone.centroidGz;
  const len = Math.sqrt(bearX * bearX + bearZ * bearZ);

  if (len < 0.01) {
    // Zone is centered on nucleus — default to north-south
    return { dx: 0, dz: 1 };
  }

  return { dx: bearX / len, dz: bearZ / len };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/city/ribbonLayout.test.js --reporter verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/ribbonLayout.js test/city/ribbonLayout.test.js
git commit -m "feat: add ribbon orientation solver (contour vs nucleus-bearing)"
```

### Task 10: Implement parallel street placement

**Files:**
- Modify: `src/city/ribbonLayout.js`
- Modify: `test/city/ribbonLayout.test.js`

- [ ] **Step 1: Write tests**

Add to `test/city/ribbonLayout.test.js`:

```javascript
import { layoutRibbonStreets } from '../../src/city/ribbonLayout.js';

describe('layoutRibbonStreets', () => {
  // Simple rectangular boundary polygon
  const boundary = [
    { x: 0, z: 0 }, { x: 200, z: 0 },
    { x: 200, z: 150 }, { x: 0, z: 150 },
  ];

  it('places parallel streets within a zone', () => {
    const streets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 50,
    }, { dx: 1, dz: 0 }, 5, 0, 0);

    expect(streets.parallel.length).toBeGreaterThan(1);
    // Each street should be a polyline with at least 2 points
    for (const st of streets.parallel) {
      expect(st.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('places cross streets connecting parallels', () => {
    const streets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 50,
    }, { dx: 1, dz: 0 }, 5, 0, 0);

    expect(streets.cross.length).toBeGreaterThan(0);
  });

  it('spine street passes through centroid', () => {
    const streets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 50,
    }, { dx: 1, dz: 0 }, 5, 0, 0);

    expect(streets.spine).toBeDefined();
    expect(streets.spine.length).toBeGreaterThanOrEqual(2);
  });

  it('uses tighter spacing near nucleus', () => {
    const nearStreets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 50,
    }, { dx: 0, dz: 1 }, 5, 0, 0);

    const farStreets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 400,
    }, { dx: 0, dz: 1 }, 5, 0, 0);

    // Near nucleus → more streets (tighter spacing)
    expect(nearStreets.parallel.length).toBeGreaterThan(farStreets.parallel.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/city/ribbonLayout.test.js -t "layoutRibbonStreets" --reporter verbose`

- [ ] **Step 3: Implement layoutRibbonStreets**

Add to `src/city/ribbonLayout.js`:

```javascript
const CROSS_STREET_INTERVAL = 90;  // meters between cross streets
const MIN_STREET_LENGTH = 20;      // meters — skip streets shorter than this

/**
 * Compute ribbon spacing based on distance from nucleus.
 */
function ribbonSpacing(distFromNucleus) {
  if (distFromNucleus < 100) return 30;
  if (distFromNucleus < 300) return 40;
  return 50;
}

/**
 * Clip a line segment to a (possibly concave) polygon.
 * Returns an array of clipped segments. Each segment is [start, end].
 * For concave polygons, a line may enter/exit multiple times, producing
 * multiple disjoint segments.
 */
function clipLineToPolygon(p1, p2, polygon) {
  const dx = p2.x - p1.x, dz = p2.z - p1.z;
  const n = polygon.length;
  const intersections = [];

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const edx = b.x - a.x, edz = b.z - a.z;
    const denom = dx * edz - dz * edx;
    if (Math.abs(denom) < 1e-10) continue;

    const t = ((a.x - p1.x) * edz - (a.z - p1.z) * edx) / denom;
    const u = ((a.x - p1.x) * dz - (a.z - p1.z) * dx) / denom;

    if (u >= 0 && u <= 1 && t >= 0 && t <= 1) {
      intersections.push(t);
    }
  }

  if (intersections.length < 2) {
    // Check if entire line is inside polygon
    const mx = (p1.x + p2.x) / 2, mz = (p1.z + p2.z) / 2;
    if (pointInPoly(mx, mz, polygon)) return [[p1, p2]];
    return [];
  }

  // Sort intersections and pair them as entry/exit
  intersections.sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < intersections.length - 1; i += 2) {
    const t0 = intersections[i];
    const t1 = intersections[i + 1];
    if (t1 - t0 < 1e-6) continue;
    segments.push([
      { x: p1.x + t0 * dx, z: p1.z + t0 * dz },
      { x: p1.x + t1 * dx, z: p1.z + t1 * dz },
    ]);
  }

  return segments;
}

function pointInPoly(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Layout parallel streets within a development zone.
 *
 * @param {Object} zone - Zone with boundary polygon, centroid, distFromNucleus
 * @param {{ dx: number, dz: number }} direction - Street direction (unit vector)
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 * @returns {{ spine: Array, parallel: Array<Array>, cross: Array<Array> }}
 */
export function layoutRibbonStreets(zone, direction, cellSize, originX, originZ) {
  const boundary = zone.boundary;
  if (!boundary || boundary.length < 3) return { spine: [], parallel: [], cross: [] };

  const spacing = ribbonSpacing(zone.distFromNucleus);
  const { dx, dz } = direction;
  // Perpendicular direction
  const px = -dz, pz = dx;

  // Zone centroid in world coords
  const cx = originX + zone.centroidGx * cellSize;
  const cz = originZ + zone.centroidGz * cellSize;

  // Find zone extent along perpendicular axis
  let minPerp = Infinity, maxPerp = -Infinity;
  for (const pt of boundary) {
    const proj = (pt.x - cx) * px + (pt.z - cz) * pz;
    if (proj < minPerp) minPerp = proj;
    if (proj > maxPerp) maxPerp = proj;
  }

  // Find zone extent along street direction for line length
  let minAlong = Infinity, maxAlong = -Infinity;
  for (const pt of boundary) {
    const proj = (pt.x - cx) * dx + (pt.z - cz) * dz;
    if (proj < minAlong) minAlong = proj;
    if (proj > maxAlong) maxAlong = proj;
  }

  // Place parallel lines at spacing intervals along perpendicular axis
  const parallel = [];
  let spine = null;

  // Start from centroid (offset 0), go both directions
  for (let offset = 0; offset <= maxPerp + spacing; offset += spacing) {
    for (const sign of [1, -1]) {
      if (offset === 0 && sign === -1) continue; // don't duplicate center line
      const actualOffset = offset * sign;
      if (actualOffset < minPerp - spacing || actualOffset > maxPerp + spacing) continue;

      // Line through centroid + perpendicular offset, extending along street direction
      const lineCx = cx + px * actualOffset;
      const lineCz = cz + pz * actualOffset;
      const p1 = { x: lineCx + dx * (minAlong - 50), z: lineCz + dz * (minAlong - 50) };
      const p2 = { x: lineCx + dx * (maxAlong + 50), z: lineCz + dz * (maxAlong + 50) };

      const segments = clipLineToPolygon(p1, p2, boundary);
      for (const seg of segments) {
        const len = Math.sqrt((seg[1].x - seg[0].x) ** 2 + (seg[1].z - seg[0].z) ** 2);
        if (len < MIN_STREET_LENGTH) continue;

        parallel.push(seg);

        // The segment closest to offset 0 is the spine
        if (offset === 0 && !spine) spine = seg;
      }
    }
  }

  if (!spine && parallel.length > 0) spine = parallel[0];

  // Place cross streets connecting adjacent parallel streets
  const cross = [];
  // Sort parallel streets by their perpendicular offset
  parallel.sort((a, b) => {
    const aOff = (a[0].x - cx) * px + (a[0].z - cz) * pz;
    const bOff = (b[0].x - cx) * px + (b[0].z - cz) * pz;
    return aOff - bOff;
  });

  for (let i = 0; i < parallel.length - 1; i++) {
    const st1 = parallel[i], st2 = parallel[i + 1];

    // Find overlap range along street direction
    const s1Start = (st1[0].x - cx) * dx + (st1[0].z - cz) * dz;
    const s1End = (st1[1].x - cx) * dx + (st1[1].z - cz) * dz;
    const s2Start = (st2[0].x - cx) * dx + (st2[0].z - cz) * dz;
    const s2End = (st2[1].x - cx) * dx + (st2[1].z - cz) * dz;

    const overlapStart = Math.max(Math.min(s1Start, s1End), Math.min(s2Start, s2End));
    const overlapEnd = Math.min(Math.max(s1Start, s1End), Math.max(s2Start, s2End));
    if (overlapEnd - overlapStart < MIN_STREET_LENGTH) continue;

    for (let along = overlapStart + CROSS_STREET_INTERVAL / 2; along < overlapEnd; along += CROSS_STREET_INTERVAL) {
      // Points on each parallel street at this 'along' position
      const t1 = (along - Math.min(s1Start, s1End)) / Math.abs(s1End - s1Start);
      const t2 = (along - Math.min(s2Start, s2End)) / Math.abs(s2End - s2Start);
      if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) continue;

      const p1x = st1[0].x + t1 * (st1[1].x - st1[0].x);
      const p1z = st1[0].z + t1 * (st1[1].z - st1[0].z);
      const p2x = st2[0].x + t2 * (st2[1].x - st2[0].x);
      const p2z = st2[0].z + t2 * (st2[1].z - st2[0].z);

      cross.push([{ x: p1x, z: p1z }, { x: p2x, z: p2z }]);
    }
  }

  return { spine: spine || [], parallel, cross };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/city/ribbonLayout.test.js --reporter verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/ribbonLayout.js test/city/ribbonLayout.test.js
git commit -m "feat: add parallel street placement with cross streets and variable spacing"
```

### Task 11: Add contour adjustment for sloped zones

**Files:**
- Modify: `src/city/ribbonLayout.js`
- Modify: `test/city/ribbonLayout.test.js`

- [ ] **Step 1: Write test**

Add to `test/city/ribbonLayout.test.js`:

```javascript
import { adjustStreetToContour } from '../../src/city/ribbonLayout.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('adjustStreetToContour', () => {
  it('nudges street points to maintain constant elevation', () => {
    // Create a simple sloped elevation grid (elevation increases with x)
    const elevation = new Grid2D(40, 40, { type: 'float32' });
    for (let gz = 0; gz < 40; gz++)
      for (let gx = 0; gx < 40; gx++)
        elevation.set(gx, gz, gx * 2.5); // 0.5m per cell = 0.1 slope at 5m cells

    const street = [{ x: 10, z: 50 }, { x: 150, z: 50 }];
    const slopeDir = { x: 1, z: 0 };

    const adjusted = adjustStreetToContour(street, elevation, slopeDir, 5, 0, 0);

    // All points should be at roughly the same elevation (±1m)
    const elevations = adjusted.map(p => elevation.sample(p.x / 5, p.z / 5));
    const avgEl = elevations.reduce((a, b) => a + b, 0) / elevations.length;
    for (const el of elevations) {
      expect(Math.abs(el - avgEl)).toBeLessThan(2);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/city/ribbonLayout.test.js -t "adjustStreetToContour" --reporter verbose`

- [ ] **Step 3: Implement adjustStreetToContour**

Add to `src/city/ribbonLayout.js`:

```javascript
import { chaikinSmooth } from '../core/math.js';

const CONTOUR_SAMPLE_INTERVAL = 5;  // meters between samples along street
const CONTOUR_TOLERANCE = 1;        // meters — max elevation deviation

/**
 * Adjust a street polyline to follow a constant elevation contour.
 * Densifies the line, then nudges each point perpendicular to slope direction
 * to maintain constant elevation. Smooths result with Chaikin.
 *
 * @param {Array<{x,z}>} street - Original street endpoints
 * @param {Grid2D} elevation
 * @param {{x,z}} slopeDir - Gradient direction (unit vector)
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 * @returns {Array<{x,z}>} Adjusted polyline
 */
export function adjustStreetToContour(street, elevation, slopeDir, cellSize, originX, originZ) {
  if (street.length < 2) return street;

  // Densify: place points at regular intervals
  const totalLen = Math.sqrt(
    (street[1].x - street[0].x) ** 2 + (street[1].z - street[0].z) ** 2
  );
  const numPts = Math.max(2, Math.ceil(totalLen / CONTOUR_SAMPLE_INTERVAL));
  const pts = [];
  for (let i = 0; i <= numPts; i++) {
    const t = i / numPts;
    pts.push({
      x: street[0].x + t * (street[1].x - street[0].x),
      z: street[0].z + t * (street[1].z - street[0].z),
    });
  }

  // Find target elevation (average of all sample points)
  let elevSum = 0;
  for (const p of pts) {
    const gx = (p.x - originX) / cellSize;
    const gz = (p.z - originZ) / cellSize;
    elevSum += elevation.sample(gx, gz);
  }
  const targetElev = elevSum / pts.length;

  // Nudge each point perpendicular to slope to match target elevation
  const adjusted = pts.map(p => {
    const gx = (p.x - originX) / cellSize;
    const gz = (p.z - originZ) / cellSize;
    const currentElev = elevation.sample(gx, gz);
    const diff = currentElev - targetElev;

    if (Math.abs(diff) < CONTOUR_TOLERANCE) return { ...p };

    // Move opposite to slope direction to decrease elevation (or with it to increase)
    // The slope direction points uphill, so moving opposite decreases elevation
    const nudgeDist = diff * cellSize / Math.max(0.01, Math.sqrt(slopeDir.x ** 2 + slopeDir.z ** 2));
    return {
      x: p.x - slopeDir.x * nudgeDist,
      z: p.z - slopeDir.z * nudgeDist,
    };
  });

  // Chaikin smooth (2 passes)
  let result = adjusted;
  for (let i = 0; i < 2; i++) {
    if (result.length >= 3) result = chaikinSmooth(result);
  }

  return result;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/city/ribbonLayout.test.js --reporter verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/ribbonLayout.js test/city/ribbonLayout.test.js
git commit -m "feat: add contour adjustment for streets on sloped zones"
```

---

## Chunk 5: Strategy Class & Integration

### Task 12: Create LandFirstDevelopment strategy class

**Files:**
- Create: `src/city/strategies/landFirstDevelopment.js`
- Create: `test/city/strategies/landFirstDevelopment.test.js`

- [ ] **Step 1: Write integration test**

Create `test/city/strategies/landFirstDevelopment.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { FeatureMap } from '../../../src/core/FeatureMap.js';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { LandFirstDevelopment } from '../../../src/city/strategies/landFirstDevelopment.js';

function makeTestMap() {
  const map = new FeatureMap(60, 60, 5);
  const elevation = new Grid2D(60, 60, { cellSize: 5, fill: 50 });
  const slope = new Grid2D(60, 60, { cellSize: 5, fill: 0.03 });
  map.setTerrain(elevation, slope);
  map.nuclei = [{ gx: 30, gz: 30, type: 'market' }];
  return map;
}

describe('LandFirstDevelopment', () => {
  it('tick 1 builds skeleton roads', () => {
    const map = makeTestMap();
    const strategy = new LandFirstDevelopment(map);
    strategy.tick(); // tick 1
    expect(map.roads.length).toBeGreaterThan(0);
  });

  it('completes all ticks without error', () => {
    const map = makeTestMap();
    const strategy = new LandFirstDevelopment(map);
    let ticks = 0;
    while (strategy.tick()) {
      ticks++;
      if (ticks > 20) break; // safety
    }
    expect(ticks).toBeGreaterThan(2);
    expect(ticks).toBeLessThan(20);
  });

  it('produces development zones', () => {
    const map = makeTestMap();
    const strategy = new LandFirstDevelopment(map);
    while (strategy.tick()) {}
    expect(map.developmentZones).toBeDefined();
    expect(map.developmentZones.length).toBeGreaterThan(0);
  });

  it('adds local roads from ribbon layout', () => {
    const map = makeTestMap();
    const strategy = new LandFirstDevelopment(map);
    while (strategy.tick()) {}
    // Should have more roads than just skeleton
    const localRoads = map.roads.filter(r => r.hierarchy === 'local');
    expect(localRoads.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/city/strategies/landFirstDevelopment.test.js --reporter verbose`

- [ ] **Step 3: Implement LandFirstDevelopment class**

Create `src/city/strategies/landFirstDevelopment.js`:

```javascript
import { buildSkeletonRoads } from '../skeleton.js';
import { extractDevelopmentZones } from '../zoneExtraction.js';
import {
  computeRibbonOrientation, layoutRibbonStreets, adjustStreetToContour,
} from '../ribbonLayout.js';
import { findPath, simplifyPath, gridPathToWorldPolyline } from '../../core/pathfinding.js';
import { CONTOUR_SLOPE_THRESHOLD } from '../ribbonLayout.js';

const CONNECTION_MAX_PATH_M = 500;

export class LandFirstDevelopment {
  constructor(map) {
    this.map = map;
    this._tick = 0;
    this._zones = [];
  }

  tick() {
    this._tick++;

    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }

    if (this._tick === 2) {
      this.map.computeLandValue();
      return true;
    }

    if (this._tick === 3) {
      this._zones = extractDevelopmentZones(this.map);
      this.map.developmentZones = this._zones;
      return true;
    }

    if (this._tick === 4) {
      this._layoutRibbons();
      return true;
    }

    if (this._tick === 5) {
      this._connectToNetwork();
      return true;
    }

    return false;
  }

  _layoutRibbons() {
    const map = this.map;

    for (const zone of this._zones) {
      const nucleus = map.nuclei[zone.nucleusIdx];
      const direction = computeRibbonOrientation(zone, nucleus, map.cellSize);

      const streets = layoutRibbonStreets(
        zone, direction, map.cellSize, map.originX, map.originZ
      );

      // Contour adjustment for sloped zones
      const allStreets = [...streets.parallel, ...streets.cross];
      if (zone.avgSlope > CONTOUR_SLOPE_THRESHOLD) {
        for (let i = 0; i < streets.parallel.length; i++) {
          streets.parallel[i] = adjustStreetToContour(
            streets.parallel[i], map.elevation, zone.slopeDir,
            map.cellSize, map.originX, map.originZ
          );
        }
      }

      // Add all streets as roads
      for (const st of streets.parallel) {
        if (st.length < 2) continue;
        this._addRoad(st, 'local', 6);
      }
      for (const st of streets.cross) {
        if (st.length < 2) continue;
        this._addRoad(st, 'local', 6);
      }

      // Store streets on zone for building placement and connection phase
      zone._spine = streets.spine;
      zone._streets = streets.parallel;
      zone._crossStreets = streets.cross;
    }
  }

  _connectToNetwork() {
    const map = this.map;
    const graph = map.graph;
    if (!graph) return;

    const costFn = map.createPathCost('growth');
    const maxCells = Math.round(CONNECTION_MAX_PATH_M / map.cellSize);

    for (const zone of this._zones) {
      const spine = zone._spine;
      if (!spine || spine.length < 2) continue;

      // Find nearest skeleton road node to spine endpoint
      const endpoint = spine[0];
      const nearest = graph.nearestNode(endpoint.x, endpoint.z);
      if (!nearest || nearest.dist > CONNECTION_MAX_PATH_M) continue;

      // A* pathfind from spine endpoint to nearest node
      const nearestNode = graph.getNode(nearest.id);
      if (!nearestNode) continue;
      const fromGx = Math.round((endpoint.x - map.originX) / map.cellSize);
      const fromGz = Math.round((endpoint.z - map.originZ) / map.cellSize);
      const toGx = Math.round((nearestNode.x - map.originX) / map.cellSize);
      const toGz = Math.round((nearestNode.z - map.originZ) / map.cellSize);

      if (fromGx < 1 || fromGx >= map.width - 1 || fromGz < 1 || fromGz >= map.height - 1) continue;
      if (toGx < 1 || toGx >= map.width - 1 || toGz < 1 || toGz >= map.height - 1) continue;

      const result = findPath(fromGx, fromGz, toGx, toGz, map.width, map.height, costFn);
      if (!result || result.path.length < 2) continue;

      const simplified = simplifyPath(result.path, 1.0);
      const worldPoly = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
      if (worldPoly.length < 2) continue;

      this._addRoad(worldPoly, 'collector', 8);
    }
  }

  _addRoad(polyline, hierarchy, width) {
    const map = this.map;
    map.addFeature('road', {
      polyline,
      width,
      hierarchy,
      importance: hierarchy === 'collector' ? 0.5 : 0.2,
      source: 'land-first',
    });

    // Add to graph
    if (polyline.length >= 2 && map.graph) {
      const snapDist = map.cellSize * 3;
      const startPt = polyline[0];
      const endPt = polyline[polyline.length - 1];
      const startNode = this._findOrCreateNode(startPt.x, startPt.z, snapDist);
      const endNode = this._findOrCreateNode(endPt.x, endPt.z, snapDist);

      if (startNode !== endNode) {
        const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
        map.graph.addEdge(startNode, endNode, { points, width, hierarchy });
      }
    }
  }

  _findOrCreateNode(x, z, snapDist) {
    const graph = this.map.graph;
    const nearest = graph.nearestNode(x, z);
    if (nearest && nearest.dist < snapDist) return nearest.id;
    return graph.addNode(x, z);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/city/strategies/landFirstDevelopment.test.js --reporter verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/strategies/landFirstDevelopment.js test/city/strategies/landFirstDevelopment.test.js
git commit -m "feat: add LandFirstDevelopment strategy class"
```

### Task 13: Wire up CityScreen to use new strategy

**Files:**
- Modify: `src/ui/CityScreen.js:10, 45-46`

- [ ] **Step 1: Swap strategy import and instantiation**

In `src/ui/CityScreen.js`, change line 10:
```javascript
import { LandFirstDevelopment } from '../city/strategies/landFirstDevelopment.js';
```

Change lines 45-46:
```javascript
const strategy = new LandFirstDevelopment(map);
while (strategy.tick()) { /* run all ticks */ }
```

- [ ] **Step 2: Test manually in browser**

Run: `npm run dev` (or however the dev server starts)

Open the city view. Verify:
- No console errors
- Terrain renders at higher resolution
- Some roads appear (skeleton + local streets from ribbons)
- Buildings may not appear yet (parcel format changed) — that's expected, fixed in Task 14

- [ ] **Step 3: Commit**

```bash
git add src/ui/CityScreen.js
git commit -m "feat: wire CityScreen to LandFirstDevelopment strategy"
```

### Task 14: Update placeTerracedRows for ribbon parcels

**Files:**
- Modify: `src/city/placeBuildings.js:296-404`

- [ ] **Step 1: Rewrite placeTerracedRows to read from development zones**

The new strategy stores street polylines on each zone as `zone._streets` (array of 2-point segments or contour-adjusted polylines). Replace the parcel-walking logic with zone-street-walking logic.

Replace the `placeTerracedRows` function in `src/city/placeBuildings.js`:

```javascript
/**
 * Determine plot width based on distance from nucleus.
 */
function plotWidthForDensity(distFromNucleus) {
  if (distFromNucleus < 100) return 5;   // terraced
  if (distFromNucleus < 300) return 8;   // semi-detached
  return 12;                              // detached
}

export function placeTerracedRows(map, seed) {
  const group = new THREE.Group();
  const ox = map.originX, oz = map.originZ;
  const cs = map.cellSize;
  const zones = map.developmentZones;

  if (!zones || zones.length === 0) return group;

  // Build template geometry
  const templateGeo = _buildPlotTemplate();

  // First pass: count total plots across all zones
  let totalPlots = 0;
  for (const zone of zones) {
    if (!zone._streets) continue;
    const plotWidth = plotWidthForDensity(zone.distFromNucleus);

    for (const street of zone._streets) {
      if (street.length < 2) continue;
      let streetLen = 0;
      for (let i = 1; i < street.length; i++) {
        const dx = street[i].x - street[i - 1].x;
        const dz = street[i].z - street[i - 1].z;
        streetLen += Math.sqrt(dx * dx + dz * dz);
      }
      if (streetLen < plotWidth * 2) continue;
      // Two sides of the street
      totalPlots += Math.floor(streetLen / plotWidth) * 2;
    }
  }

  if (totalPlots === 0) return group;

  const mat = new THREE.MeshLambertMaterial({ color: 0xd4c4a8 });
  const mesh = new THREE.InstancedMesh(templateGeo, mat, totalPlots);
  const dummy = new THREE.Object3D();
  let instanceIdx = 0;

  for (const zone of zones) {
    if (!zone._streets) continue;
    const plotWidth = plotWidthForDensity(zone.distFromNucleus);

    for (const street of zone._streets) {
      if (street.length < 2) continue;

      // Compute total street length
      let streetLen = 0;
      for (let i = 1; i < street.length; i++) {
        const dx = street[i].x - street[i - 1].x;
        const dz = street[i].z - street[i - 1].z;
        streetLen += Math.sqrt(dx * dx + dz * dz);
      }
      if (streetLen < plotWidth * 2) continue;

      const houseCount = Math.floor(streetLen / plotWidth);
      let segIdx = 0, segStart = 0;

      for (let h = 0; h < houseCount; h++) {
        const targetDist = (h + 0.5) * plotWidth;

        // Advance to correct segment
        while (segIdx < street.length - 2) {
          const dx = street[segIdx + 1].x - street[segIdx].x;
          const dz = street[segIdx + 1].z - street[segIdx].z;
          const sLen = Math.sqrt(dx * dx + dz * dz);
          if (segStart + sLen >= targetDist) break;
          segStart += sLen;
          segIdx++;
        }
        if (segIdx >= street.length - 1) break;

        const ax = street[segIdx].x, az = street[segIdx].z;
        const bx = street[segIdx + 1].x, bz = street[segIdx + 1].z;
        const sdx = bx - ax, sdz = bz - az;
        const segLen = Math.sqrt(sdx * sdx + sdz * sdz);
        if (segLen < 0.01) continue;

        const t = (targetDist - segStart) / segLen;
        const px = ax + sdx * t;
        const pz = az + sdz * t;

        // Place on both sides of the street
        for (const side of [-1, 1]) {
          const perpX = (-sdz / segLen) * side;
          const perpZ = (sdx / segLen) * side;
          const angle = Math.atan2(perpX, perpZ);

          // Setback from road center
          const roadHalfWidth = 3;
          const sidewalk = 1.5;
          const frontSetback = roadHalfWidth + sidewalk;
          const frontX = px + perpX * frontSetback;
          const frontZ = pz + perpZ * frontSetback;

          const lx = frontX - ox;
          const lz = frontZ - oz;
          const gx = lx / cs;
          const gz = lz / cs;
          if (gx < 1 || gz < 1 || gx >= map.width - 1 || gz >= map.height - 1) continue;
          const terrainY = map.elevation.sample(gx, gz);

          dummy.position.set(lx, terrainY, lz);
          dummy.rotation.set(0, angle, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(instanceIdx, dummy.matrix);
          instanceIdx++;
        }
      }
    }
  }

  mesh.count = instanceIdx;
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return group;
}
```

- [ ] **Step 2: Test manually in browser**

Verify buildings appear along the new ribbon streets on both sides, with correct rotation and terrain following.

- [ ] **Step 3: Commit**

```bash
git add src/city/placeBuildings.js
git commit -m "feat: rewrite placeTerracedRows for ribbon-based plot placement with density tiers"
```

---

## Chunk 6: Debug Layers & Polish

### Task 15: Add new debug layers

**Files:**
- Modify: `src/rendering/debugLayers.js`

- [ ] **Step 1: Add renderDevelopmentZones function**

Add to `src/rendering/debugLayers.js` before the LAYERS array:

```javascript
/**
 * Development zones colored by nucleus ownership.
 */
export function renderDevelopmentZones(ctx, map) {
  renderTerrain(ctx, map);

  if (!map.developmentZones) return;

  const hueStep = 137.508;
  for (let i = 0; i < map.developmentZones.length; i++) {
    const zone = map.developmentZones[i];
    const hue = (zone.nucleusIdx * hueStep) % 360;
    ctx.fillStyle = `hsla(${hue}, 70%, 50%, 0.4)`;
    for (const c of zone.cells) {
      ctx.fillRect(c.gx, c.gz, 1, 1);
    }

    // Draw boundary
    if (zone.boundary && zone.boundary.length > 2) {
      const ox = map.originX, oz = map.originZ, cs = map.cellSize;
      ctx.strokeStyle = `hsla(${hue}, 70%, 70%, 0.8)`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo((zone.boundary[0].x - ox) / cs, (zone.boundary[0].z - oz) / cs);
      for (let j = 1; j < zone.boundary.length; j++) {
        ctx.lineTo((zone.boundary[j].x - ox) / cs, (zone.boundary[j].z - oz) / cs);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  // Overlay roads
  for (let gz = 0; gz < map.height; gz++) {
    for (let gx = 0; gx < map.width; gx++) {
      if (map.roadGrid.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }
}

/**
 * Zone priority — colored by development order.
 */
export function renderZonePriority(ctx, map) {
  renderTerrain(ctx, map);

  if (!map.developmentZones) return;

  const total = map.developmentZones.length;
  for (let i = 0; i < total; i++) {
    const zone = map.developmentZones[i];
    // First zone = bright, last = dim
    const brightness = 1.0 - (i / Math.max(1, total - 1)) * 0.7;
    const r = Math.round(255 * brightness);
    const g = Math.round(200 * brightness);
    const b = Math.round(50);
    ctx.fillStyle = `rgba(${r},${g},${b},0.5)`;
    for (const c of zone.cells) {
      ctx.fillRect(c.gx, c.gz, 1, 1);
    }
  }
}
```

- [ ] **Step 2: Add to LAYERS array**

Add entries to the LAYERS array:

```javascript
{ name: 'Development Zones', render: renderDevelopmentZones },
{ name: 'Zone Priority', render: renderZonePriority },
```

- [ ] **Step 3: Test in browser**

Open the city view, use the overlay dropdown to select "Development Zones" and "Zone Priority". Verify they render correctly on the terrain.

- [ ] **Step 4: Commit**

```bash
git add src/rendering/debugLayers.js
git commit -m "feat: add Development Zones and Zone Priority debug layers"
```

### Task 16: Update CompareScreen if needed

**Files:**
- Modify: `src/ui/CompareScreen.js`

- [ ] **Step 1: Update strategy import**

If `CompareScreen.js` still imports `StripDevelopment`, update to `LandFirstDevelopment`:

```javascript
import { LandFirstDevelopment } from '../city/strategies/landFirstDevelopment.js';
const STRATEGY_CLASSES = [LandFirstDevelopment, LandFirstDevelopment, LandFirstDevelopment, LandFirstDevelopment];
const STRATEGY_NAMES = ['Land First 1', 'Land First 2', 'Land First 3', 'Land First 4'];
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/CompareScreen.js
git commit -m "feat: update CompareScreen to use LandFirstDevelopment"
```

### Task 17: Run full test suite and fix breakages

- [ ] **Step 1: Run all tests**

Run: `npm test -- --reporter verbose`

- [ ] **Step 2: Fix any failures**

Address test failures from:
- Changed grid resolution (cell count assumptions)
- Changed land value formula (expected values)
- Removed strip development references

- [ ] **Step 3: Manual smoke test**

Open the app, navigate to city view. Check:
- Terrain renders at higher resolution (smoother)
- Development zones visible on terrain
- Parallel streets visible within zones
- Buildings placed along streets
- Debug overlay dropdown shows new layers
- Compare screen works with new strategy

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: resolve test failures from land-first development migration"
```
