# River Profile Carving Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace indirect corridor depression with authoritative river elevation profiles that prevent river fragmentation.

**Architecture:** New pipeline step A2b (`carveRiverProfiles`) runs after terrain generation. For each corridor, it finds the lowest entry point on the map edge, computes entry accumulation from elevation, builds an elevation profile via geology-modulated binary subdivision, and carves the terrain to match. Existing corridor base depression in terrain gen is removed.

**Tech Stack:** JavaScript (ES modules), vitest, Grid2D

**Spec:** `docs/superpowers/specs/2026-03-17-river-profile-carving-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/regional/carveRiverProfiles.js` | A2b step: entry selection, accumulation, profile subdivision, terrain carving |
| Create | `test/regional/carveRiverProfiles.test.js` | Unit tests for the new module |
| Modify | `src/regional/generateTerrain.js:311` | Remove `corridorDepress` base depression (keep mountain suppression) |
| Modify | `src/regional/planRiverCorridors.js:27-29,93-98` | Remove fixed ACC constants, stop setting `entryAccumulation` |
| Modify | `src/regional/pipeline.js:56-62,100-107` | Insert A2b call, pass enriched corridors to hydrology |

---

### Task 1: Create `carveRiverProfiles` with entry point selection

**Files:**
- Create: `src/regional/carveRiverProfiles.js`
- Create: `test/regional/carveRiverProfiles.test.js`

- [ ] **Step 1: Write failing test for `findEntryPoint`**

```javascript
import { describe, it, expect } from 'vitest';
import { findEntryPoint } from '../../src/regional/carveRiverProfiles.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('findEntryPoint', () => {
  it('picks the lowest above-sea-level cell in the scan window', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    // Fill with high terrain
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;
    // Create a low point at (10, 0) on the north edge
    elevation.set(10, 0, 20);
    elevation.set(11, 0, 15); // lowest
    elevation.set(12, 0, 25);

    const planned = { gx: 10, gz: 0 };
    const result = findEntryPoint(planned, elevation, 'north', 0);

    expect(result.gx).toBe(11);
    expect(result.gz).toBe(0);
  });

  it('skips below-sea-level cells', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;
    elevation.set(10, 0, -5);  // below sea level
    elevation.set(11, 0, 30);  // lowest above sea level

    const planned = { gx: 10, gz: 0 };
    const result = findEntryPoint(planned, elevation, 'north', 0);

    expect(result.gx).toBe(11);
  });

  it('clamps scan window near corners', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;
    elevation.set(1, 0, 20);

    const planned = { gx: 1, gz: 0 };
    const result = findEntryPoint(planned, elevation, 'north', 0);

    // Should not crash, should find the low point
    expect(result.gx).toBeGreaterThanOrEqual(0);
    expect(result.gx).toBeLessThan(32);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `findEntryPoint`**

```javascript
/**
 * A2b. River profile carving.
 *
 * After terrain generation, compute authoritative elevation profiles
 * along corridor polylines and carve terrain to match.
 * Replaces the indirect corridor depression that caused river fragmentation.
 */

import { valleyHalfWidth, valleyProfile } from '../core/riverGeometry.js';

const SCAN_WINDOW = 5; // ±5 cells along edge
const ACC_MAX = 10000;
const ACC_MIN = 1500;
const SUBDIVISION_DEPTH = 6;

/**
 * Find the best entry point near the planned entry on a map edge.
 * Scans ±SCAN_WINDOW cells along the edge, picks the lowest above sea level.
 *
 * @param {{ gx: number, gz: number }} planned - Planned entry point
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {string} edge - 'north'|'south'|'east'|'west'
 * @param {number} seaLevel
 * @returns {{ gx: number, gz: number }}
 */
export function findEntryPoint(planned, elevation, edge, seaLevel) {
  const { width, height } = elevation;
  let bestGx = planned.gx, bestGz = planned.gz;
  let bestElev = Infinity;

  const isHorizontal = edge === 'north' || edge === 'south';
  const fixedCoord = edge === 'north' ? 0 : edge === 'south' ? height - 1
    : edge === 'west' ? 0 : width - 1;

  const scanMin = Math.max(0, (isHorizontal ? planned.gx : planned.gz) - SCAN_WINDOW);
  const scanMax = Math.min(
    (isHorizontal ? width : height) - 1,
    (isHorizontal ? planned.gx : planned.gz) + SCAN_WINDOW,
  );

  for (let i = scanMin; i <= scanMax; i++) {
    const gx = isHorizontal ? i : fixedCoord;
    const gz = isHorizontal ? fixedCoord : i;
    const h = elevation.get(gx, gz);
    if (h > seaLevel && h < bestElev) {
      bestElev = h;
      bestGx = gx;
      bestGz = gz;
    }
  }

  // Fallback: if all edge cells are below sea level, search inward along polyline
  if (bestElev === Infinity) {
    // This requires the polyline, which findEntryPoint doesn't have access to.
    // The orchestrator (carveRiverProfiles) should handle this case by walking
    // the polyline until it finds an above-sea-level cell.
    // For now, return the planned point; the orchestrator will fix it.
    bestGx = planned.gx;
    bestGz = planned.gz;
  }

  return { gx: bestGx, gz: bestGz };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/regional/carveRiverProfiles.js test/regional/carveRiverProfiles.test.js
git commit -m "feat: add findEntryPoint for corridor river entry selection"
```

---

### Task 2: Entry accumulation from elevation

**Files:**
- Modify: `src/regional/carveRiverProfiles.js`
- Modify: `test/regional/carveRiverProfiles.test.js`

- [ ] **Step 1: Write failing test for `computeEntryAccumulation`**

```javascript
import { computeEntryAccumulation } from '../../src/regional/carveRiverProfiles.js';

describe('computeEntryAccumulation', () => {
  it('returns high accumulation for low-elevation entry', () => {
    const acc = computeEntryAccumulation(10, 500, 0, 1.0);
    expect(acc).toBeGreaterThan(8000);
  });

  it('returns low accumulation for high-elevation entry', () => {
    const acc = computeEntryAccumulation(400, 500, 0, 1.0);
    expect(acc).toBeLessThan(4000);
  });

  it('scales by importance', () => {
    const full = computeEntryAccumulation(100, 500, 0, 1.0);
    const half = computeEntryAccumulation(100, 500, 0, 0.6);
    expect(half).toBeCloseTo(full * 0.6, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: FAIL — function not found

- [ ] **Step 3: Implement `computeEntryAccumulation`**

Add to `carveRiverProfiles.js`:

```javascript
/**
 * Compute entry accumulation from start elevation.
 * Low entry = large river (more catchment beyond map), high entry = mountain stream.
 *
 * @param {number} startElev - Elevation at entry point
 * @param {number} maxElev - Maximum terrain elevation on the map
 * @param {number} seaLevel
 * @param {number} importance - Corridor importance (1.0, 0.6, 0.3)
 * @returns {number}
 */
export function computeEntryAccumulation(startElev, maxElev, seaLevel, importance) {
  const elevRange = maxElev - seaLevel || 1;
  const elevFraction = Math.max(0, Math.min(1, (startElev - seaLevel) / elevRange));
  const baseAcc = ACC_MAX + (ACC_MIN - ACC_MAX) * elevFraction;
  return baseAcc * importance;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/regional/carveRiverProfiles.js test/regional/carveRiverProfiles.test.js
git commit -m "feat: add computeEntryAccumulation scaling by elevation"
```

---

### Task 3: Binary subdivision elevation profile

**Files:**
- Modify: `src/regional/carveRiverProfiles.js`
- Modify: `test/regional/carveRiverProfiles.test.js`

- [ ] **Step 1: Write failing test for `buildElevationProfile`**

```javascript
import { buildElevationProfile } from '../../src/regional/carveRiverProfiles.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('buildElevationProfile', () => {
  it('returns monotonically decreasing elevations', () => {
    // Uniform medium resistance
    const resistance = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) resistance.data[i] = 0.5;

    const polyline = [];
    for (let i = 0; i < 20; i++) polyline.push({ gx: i + 5, gz: 16 });

    const profile = buildElevationProfile(polyline, 200, 0, resistance);

    expect(profile.length).toBe(polyline.length);
    for (let i = 1; i < profile.length; i++) {
      expect(profile[i]).toBeLessThanOrEqual(profile[i - 1]);
    }
    expect(profile[0]).toBeCloseTo(200, 0);
    expect(profile[profile.length - 1]).toBeCloseTo(0, 0);
  });

  it('hard rock creates knickpoints — steeper drops at resistant sections', () => {
    const resistance = new Grid2D(32, 32, { cellSize: 50 });
    // Soft rock everywhere
    for (let i = 0; i < 32 * 32; i++) resistance.data[i] = 0.2;
    // Hard rock band in the middle
    for (let gx = 0; gx < 32; gx++) {
      resistance.set(gx, 16, 0.9);
      resistance.set(gx, 15, 0.9);
      resistance.set(gx, 17, 0.9);
    }

    const polyline = [];
    for (let i = 0; i < 20; i++) polyline.push({ gx: 16, gz: i + 5 });

    const softProfile = buildElevationProfile(
      polyline, 200, 0,
      // All soft
      (() => { const r = new Grid2D(32, 32, { cellSize: 50 }); for (let i = 0; i < 32*32; i++) r.data[i] = 0.2; return r; })(),
    );
    const mixedProfile = buildElevationProfile(polyline, 200, 0, resistance);

    // At the midpoint, hard rock should hold elevation higher than soft
    const mid = Math.floor(polyline.length / 2);
    expect(mixedProfile[mid]).toBeGreaterThan(softProfile[mid]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: FAIL — function not found

- [ ] **Step 3: Implement `buildElevationProfile`**

Add to `carveRiverProfiles.js`:

```javascript
/**
 * Build an elevation profile along a corridor polyline using binary subdivision.
 * Erosion resistance modulates where drops occur: hard rock holds elevation,
 * soft rock allows it to fall.
 *
 * @param {Array<{gx: number, gz: number}>} polyline - Corridor path in grid coords
 * @param {number} startElev - Elevation at entry
 * @param {number} endElev - Elevation at exit (typically sea level)
 * @param {import('../core/Grid2D.js').Grid2D} erosionResistance
 * @returns {number[]} Per-polyline-point elevation values
 */
export function buildElevationProfile(polyline, startElev, endElev, erosionResistance) {
  // Compute cumulative distance along polyline for interpolation
  const dist = [0];
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].gx - polyline[i - 1].gx;
    const dz = polyline[i].gz - polyline[i - 1].gz;
    dist.push(dist[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const totalDist = dist[dist.length - 1] || 1;

  // Binary subdivision: build control points as (normalizedDist, elevation)
  const controls = new Map();
  controls.set(0, startElev);
  controls.set(1, endElev);

  function subdivide(tStart, elevStart, tEnd, elevEnd, depth) {
    if (depth <= 0) return;

    const tMid = (tStart + tEnd) / 2;

    // Find the polyline point closest to tMid and sample resistance
    const targetDist = tMid * totalDist;
    let closest = 0;
    for (let i = 1; i < dist.length; i++) {
      if (Math.abs(dist[i] - targetDist) < Math.abs(dist[closest] - targetDist)) {
        closest = i;
      }
    }
    const resist = erosionResistance.get(polyline[closest].gx, polyline[closest].gz);

    // splitRatio: how much of the elevation drop happens above the midpoint
    // High resistance → low split → midpoint stays high → drop is below (knickpoint)
    // Low resistance → high split → midpoint drops → flat section below
    const splitRatio = 1.0 - resist;
    const elevMid = elevStart - (elevStart - elevEnd) * splitRatio;

    controls.set(tMid, elevMid);
    subdivide(tStart, elevStart, tMid, elevMid, depth - 1);
    subdivide(tMid, elevMid, tEnd, elevEnd, depth - 1);
  }

  subdivide(0, startElev, 1, endElev, SUBDIVISION_DEPTH);

  // Sort control points by t
  const sorted = [...controls.entries()].sort((a, b) => a[0] - b[0]);

  // Interpolate: for each polyline point, find elevation from control points
  const profile = new Array(polyline.length);
  for (let i = 0; i < polyline.length; i++) {
    const t = dist[i] / totalDist;

    // Find bracketing control points
    let lo = 0, hi = sorted.length - 1;
    for (let j = 0; j < sorted.length - 1; j++) {
      if (sorted[j][0] <= t && sorted[j + 1][0] >= t) {
        lo = j; hi = j + 1; break;
      }
    }

    const [tLo, eLo] = sorted[lo];
    const [tHi, eHi] = sorted[hi];
    const frac = tHi > tLo ? (t - tLo) / (tHi - tLo) : 0;
    profile[i] = eLo + (eHi - eLo) * frac;
  }

  return profile;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/regional/carveRiverProfiles.js test/regional/carveRiverProfiles.test.js
git commit -m "feat: add buildElevationProfile with geology-modulated binary subdivision"
```

---

### Task 4: Terrain carving along profile

**Files:**
- Modify: `src/regional/carveRiverProfiles.js`
- Modify: `test/regional/carveRiverProfiles.test.js`

- [ ] **Step 1: Write failing test for `carveCorridorTerrain`**

```javascript
import { carveCorridorTerrain } from '../../src/regional/carveRiverProfiles.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('carveCorridorTerrain', () => {
  it('lowers terrain along corridor to match profile', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    const slope = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;

    const polyline = [];
    for (let i = 5; i < 25; i++) polyline.push({ gx: 16, gz: i });
    // Profile descends from 80 to 10
    const profile = polyline.map((_, i) => 80 - (i / (polyline.length - 1)) * 70);
    const accumulation = 5000;

    carveCorridorTerrain(polyline, profile, accumulation, elevation, slope);

    // Centre cells should match profile (terrain was higher)
    for (let i = 0; i < polyline.length; i++) {
      expect(elevation.get(polyline[i].gx, polyline[i].gz)).toBeCloseTo(profile[i], 0);
    }
  });

  it('never raises terrain above existing elevation', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    const slope = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 50;
    // One cell is already very low
    elevation.set(16, 15, 5);

    const polyline = [];
    for (let i = 5; i < 25; i++) polyline.push({ gx: 16, gz: i });
    const profile = polyline.map((_, i) => 80 - (i / (polyline.length - 1)) * 70);
    const accumulation = 5000;

    carveCorridorTerrain(polyline, profile, accumulation, elevation, slope);

    // The low cell should not have been raised
    expect(elevation.get(16, 15)).toBeLessThanOrEqual(5);
  });

  it('carves a valley wider than just the centreline', () => {
    const elevation = new Grid2D(32, 32, { cellSize: 50 });
    const slope = new Grid2D(32, 32, { cellSize: 50 });
    for (let i = 0; i < 32 * 32; i++) elevation.data[i] = 100;

    const polyline = [];
    for (let i = 5; i < 25; i++) polyline.push({ gx: 16, gz: i });
    const profile = polyline.map(() => 50);
    const accumulation = 5000;

    carveCorridorTerrain(polyline, profile, accumulation, elevation, slope);

    // Adjacent cells should also be lowered (valley widening)
    const adjElev = elevation.get(17, 15);
    expect(adjElev).toBeLessThan(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: FAIL — function not found

- [ ] **Step 3: Implement `carveCorridorTerrain`**

Add to `carveRiverProfiles.js`:

```javascript
/**
 * Carve terrain along a corridor to match an elevation profile.
 * Uses min(existing, target) so terrain is never raised.
 * Valley widens proportional to accumulation using valleyHalfWidth/valleyProfile.
 * Recomputes slope for modified cells.
 *
 * @param {Array<{gx: number, gz: number}>} polyline
 * @param {number[]} profile - Per-point target elevation
 * @param {number} accumulation - Entry accumulation (controls valley width)
 * @param {import('../core/Grid2D.js').Grid2D} elevation - Modified in place
 * @param {import('../core/Grid2D.js').Grid2D} slope - Recomputed for modified cells
 */
export function carveCorridorTerrain(polyline, profile, accumulation, elevation, slope) {
  const { width, height, cellSize } = elevation;
  const halfW = valleyHalfWidth(accumulation);
  const radiusCells = Math.ceil(halfW / cellSize);

  // Track modified cells for slope recomputation
  const modified = new Set();

  for (let i = 0; i < polyline.length; i++) {
    const { gx: cgx, gz: cgz } = polyline[i];
    const targetElev = profile[i];

    for (let dz = -radiusCells; dz <= radiusCells; dz++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const gx = cgx + dx, gz = cgz + dz;
        if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;

        const dist = Math.sqrt(dx * dx + dz * dz) * cellSize;
        const nd = dist / Math.max(halfW, 1);
        const p = valleyProfile(nd);
        if (p <= 0) continue;

        // Blend toward target elevation based on profile strength
        const blendedTarget = elevation.get(gx, gz) * (1 - p) + targetElev * p;
        const newElev = Math.min(elevation.get(gx, gz), blendedTarget);
        if (newElev < elevation.get(gx, gz)) {
          elevation.set(gx, gz, newElev);
          modified.add(gz * width + gx);
        }
      }
    }
  }

  // Recompute slope for modified cells
  for (const idx of modified) {
    const gx = idx % width;
    const gz = (idx / width) | 0;
    if (gx < 1 || gx >= width - 1 || gz < 1 || gz >= height - 1) continue;
    const dhdx = (elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz)) / (2 * cellSize);
    const dhdz = (elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1)) / (2 * cellSize);
    slope.set(gx, gz, Math.sqrt(dhdx * dhdx + dhdz * dhdz));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/regional/carveRiverProfiles.js test/regional/carveRiverProfiles.test.js
git commit -m "feat: add carveCorridorTerrain with valley widening and slope recomputation"
```

---

### Task 5: Main `carveRiverProfiles` orchestrator

**Files:**
- Modify: `src/regional/carveRiverProfiles.js`
- Modify: `test/regional/carveRiverProfiles.test.js`

- [ ] **Step 1: Write failing test for `carveRiverProfiles`**

```javascript
import { carveRiverProfiles } from '../../src/regional/carveRiverProfiles.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('carveRiverProfiles', () => {
  it('enriches corridors with entryAccumulation and profile', () => {
    const W = 64, H = 64;
    const elevation = new Grid2D(W, H, { cellSize: 50 });
    const slope = new Grid2D(W, H, { cellSize: 50 });
    const resistance = new Grid2D(W, H, { cellSize: 50 });
    // Terrain: high in south, low in north
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        elevation.set(gx, gz, 200 - gz * 3);
        resistance.set(gx, gz, 0.5);
      }
    }

    const corridors = [{
      polyline: Array.from({ length: 50 }, (_, i) => ({ gx: 32, gz: 5 + i })),
      importance: 1.0,
      entryEdge: 'south',
      exitEdge: 'north',
    }];

    const enriched = carveRiverProfiles(corridors, elevation, slope, resistance, 0);

    expect(enriched[0].entryAccumulation).toBeGreaterThan(0);
    expect(enriched[0].profile).toBeInstanceOf(Array);
    expect(enriched[0].profile.length).toBe(corridors[0].polyline.length);
    // Profile should be monotonically decreasing
    for (let i = 1; i < enriched[0].profile.length; i++) {
      expect(enriched[0].profile[i]).toBeLessThanOrEqual(enriched[0].profile[i - 1]);
    }
  });

  it('ensures no corridor cell is below sea level after carving', () => {
    const W = 64, H = 64;
    const elevation = new Grid2D(W, H, { cellSize: 50 });
    const slope = new Grid2D(W, H, { cellSize: 50 });
    const resistance = new Grid2D(W, H, { cellSize: 50 });
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        elevation.set(gx, gz, 100 - gz * 1.5);
        resistance.set(gx, gz, 0.5);
      }
    }

    const corridors = [{
      polyline: Array.from({ length: 50 }, (_, i) => ({ gx: 32, gz: 5 + i })),
      importance: 1.0,
      entryEdge: 'south',
      exitEdge: 'north',
    }];

    carveRiverProfiles(corridors, elevation, slope, resistance, 0);

    for (const pt of corridors[0].polyline) {
      expect(elevation.get(pt.gx, pt.gz)).toBeGreaterThanOrEqual(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: FAIL — function not found

- [ ] **Step 3: Implement `carveRiverProfiles`**

Add to `carveRiverProfiles.js`:

```javascript
/**
 * A2b: Carve river profiles along corridor polylines.
 * For each corridor: find entry point, compute accumulation, build profile, carve terrain.
 *
 * @param {Array} corridors - Corridor objects from planRiverCorridors
 * @param {import('../core/Grid2D.js').Grid2D} elevation - Modified in place
 * @param {import('../core/Grid2D.js').Grid2D} slope - Recomputed for modified cells
 * @param {import('../core/Grid2D.js').Grid2D} erosionResistance
 * @param {number} seaLevel
 * @returns {Array} Enriched corridors with entryAccumulation and profile
 */
export function carveRiverProfiles(corridors, elevation, slope, erosionResistance, seaLevel) {
  // Find max elevation for accumulation scaling
  let maxElev = -Infinity;
  for (let i = 0; i < elevation.width * elevation.height; i++) {
    if (elevation.data[i] > maxElev) maxElev = elevation.data[i];
  }

  for (const corridor of corridors) {
    // 1. Find best entry point (may shift polyline[0] along the edge)
    // Note: carveRiverProfiles mutates corridor objects in place. The same
    // corridor references are passed to generateHydrology, so enriched
    // entryAccumulation values propagate automatically.
    const plannedEntry = corridor.polyline[0];
    const entry = findEntryPoint(plannedEntry, elevation, corridor.entryEdge, seaLevel);
    corridor.polyline[0] = entry;

    // Fallback: if entry is still below sea level, walk inward along polyline
    if (elevation.get(entry.gx, entry.gz) <= seaLevel) {
      for (let j = 1; j < corridor.polyline.length; j++) {
        const pt = corridor.polyline[j];
        if (elevation.get(pt.gx, pt.gz) > seaLevel) {
          corridor.polyline[0] = pt;
          break;
        }
      }
    }

    // 2. Compute accumulation from entry elevation
    const startElev = elevation.get(entry.gx, entry.gz);
    corridor.entryAccumulation = computeEntryAccumulation(
      startElev, maxElev, seaLevel, corridor.importance,
    );

    // 3. Build elevation profile
    corridor.profile = buildElevationProfile(
      corridor.polyline, startElev, seaLevel, erosionResistance,
    );

    // 4. Carve terrain
    carveCorridorTerrain(
      corridor.polyline, corridor.profile, corridor.entryAccumulation, elevation, slope,
    );
  }

  return corridors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/regional/carveRiverProfiles.js test/regional/carveRiverProfiles.test.js
git commit -m "feat: add carveRiverProfiles orchestrator (A2b step)"
```

---

### Task 6: Remove corridor base depression from terrain gen

**Files:**
- Modify: `src/regional/generateTerrain.js:298-312`
- Modify: `test/regional/terrain.test.js`

- [ ] **Step 1: Read existing terrain test for corridor depression**

Run: `npx vitest run test/regional/terrain.test.js`
Confirm existing tests pass before making changes.

- [ ] **Step 2: Remove base depression from `generateTerrain.js`**

In `src/regional/generateTerrain.js`, change lines 298-312 from:

```javascript
      // River corridor suppression: reduce mountain height along planned corridors
      // so major rivers have natural gaps through mountain ranges.
      let mountainContrib = mountainCentered;
      if (corridorInfluence) {
        const ci = corridorInfluence.get(gx, gz);
        if (ci > 0) {
          mountainContrib *= (1 - ci);
          // Also depress base elevation along corridor
          // (ensures flow routing follows the corridor even in flat areas)
        }
      }

      // Combine: tilt + base + mountains + detail
      const corridorDepress = corridorInfluence ? corridorInfluence.get(gx, gz) * 15 : 0;
      let h = tilt + baseHeight + mountainContrib + terrainShape + medDetail + smallDetail - corridorDepress;
```

To:

```javascript
      // River corridor suppression: reduce mountain height along planned corridors
      // so major rivers have natural gaps through mountain ranges.
      // Base depression is handled by carveRiverProfiles (A2b) which runs after terrain gen.
      let mountainContrib = mountainCentered;
      if (corridorInfluence) {
        const ci = corridorInfluence.get(gx, gz);
        if (ci > 0) {
          mountainContrib *= (1 - ci);
        }
      }

      // Combine: tilt + base + mountains + detail
      let h = tilt + baseHeight + mountainContrib + terrainShape + medDetail + smallDetail;
```

- [ ] **Step 3: Run terrain tests**

Run: `npx vitest run test/regional/terrain.test.js`
Expected: PASS (or update any test that asserted corridor depression values)

- [ ] **Step 4: Commit**

```bash
git add src/regional/generateTerrain.js
git commit -m "refactor: remove corridor base depression from terrain gen (replaced by A2b)"
```

---

### Task 7: Remove fixed accumulation from corridor planning

**Files:**
- Modify: `src/regional/planRiverCorridors.js:27-29,93-98`
- Modify: `test/regional/planRiverCorridors.test.js`

- [ ] **Step 1: Remove fixed ACC constants and stop setting `entryAccumulation`**

In `src/regional/planRiverCorridors.js`, remove lines 27-29:

```javascript
const ACC_SMALL = 2000;
const ACC_MEDIUM = 5000;
const ACC_LARGE = 10000;
```

Change corridor push (lines 93-103) from:

```javascript
    const accLevels = [ACC_LARGE, ACC_MEDIUM, ACC_SMALL];
    const widthLevels = [CORRIDOR_WIDTH_LARGE, CORRIDOR_WIDTH_MEDIUM, CORRIDOR_WIDTH_SMALL];

    corridors.push({
      polyline,
      entryAccumulation: accLevels[i] || ACC_SMALL,
      importance,
      corridorWidth: widthLevels[i] || CORRIDOR_WIDTH_SMALL,
      entryEdge,
      exitEdge,
    });
```

To:

```javascript
    const widthLevels = [CORRIDOR_WIDTH_LARGE, CORRIDOR_WIDTH_MEDIUM, CORRIDOR_WIDTH_SMALL];

    corridors.push({
      polyline,
      entryAccumulation: 0, // computed by carveRiverProfiles (A2b) from terrain elevation
      importance,
      corridorWidth: widthLevels[i] || CORRIDOR_WIDTH_SMALL,
      entryEdge,
      exitEdge,
    });
```

- [ ] **Step 2: Update corridor test**

In `test/regional/planRiverCorridors.test.js`, the test "each corridor has entryAccumulation and importance" (line 71-81) needs updating. Change the entryAccumulation assertion:

```javascript
  it('each corridor has entryAccumulation and importance', () => {
    const tectonics = { coastEdges: ['south'], intensity: 0.8 };
    const rng = new SeededRandom(42);
    const result = planRiverCorridors(params, tectonics, rng);

    for (const c of result.corridors) {
      // entryAccumulation is 0 here; computed later by carveRiverProfiles
      expect(c.entryAccumulation).toBe(0);
      expect(c.importance).toBeGreaterThan(0);
      expect(c.importance).toBeLessThanOrEqual(1);
    }
  });
```

- [ ] **Step 3: Run corridor tests**

Run: `npx vitest run test/regional/planRiverCorridors.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/regional/planRiverCorridors.js test/regional/planRiverCorridors.test.js
git commit -m "refactor: remove fixed accumulation constants from corridor planning"
```

---

### Task 8: Wire A2b into the pipeline

**Files:**
- Modify: `src/regional/pipeline.js`

- [ ] **Step 1: Add import and call `carveRiverProfiles` after terrain gen**

In `src/regional/pipeline.js`, add the import at the top (after existing imports around line 14):

```javascript
import { carveRiverProfiles } from './carveRiverProfiles.js';
```

After the terrain generation block (after line 87 `layers.setGrid('slope', terrain.slope);`), add:

```javascript
  // A2b. River profile carving (authoritative elevation profiles along corridors)
  carveRiverProfiles(corridors, terrain.elevation, terrain.slope, geology.erosionResistance, seaLevel);
```

- [ ] **Step 2: Run full pipeline test**

Run: `npx vitest run test/regional/pipeline.test.js`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/regional/pipeline.js
git commit -m "feat: wire carveRiverProfiles (A2b) into regional pipeline"
```

---

### Task 9: Acceptance test with seed 786031

**Files:**
- Modify: `test/regional/carveRiverProfiles.test.js`

- [ ] **Step 1: Write acceptance test**

```javascript
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('acceptance: seed 786031 river connectivity', () => {
  it('produces a connected major river (not 67 fragments)', () => {
    const rng = new SeededRandom(786031);
    const layers = generateRegion({ width: 256, height: 256, cellSize: 50, seaLevel: 0 }, rng);
    const rivers = layers.getData('rivers');

    // Count major river roots
    const majorRoots = rivers.filter(r => r.rank === 'majorRiver');
    // Should have far fewer roots than the 67 we had before
    expect(rivers.length).toBeLessThan(30);
    // The largest major river should have substantial flow
    const largest = rivers.reduce((best, r) => r.flowVolume > best.flowVolume ? r : best, { flowVolume: 0 });
    expect(largest.flowVolume).toBeGreaterThan(10000);
  });

  it('no corridor cell is below sea level after carving', () => {
    const rng = new SeededRandom(786031);
    const layers = generateRegion({ width: 256, height: 256, cellSize: 50, seaLevel: 0 }, rng);
    const elevation = layers.getGrid('elevation');
    const corridors = layers.getData('riverCorridors');

    for (const corridor of corridors) {
      for (let i = 0; i < corridor.polyline.length; i++) {
        const pt = corridor.polyline[i];
        // Allow last few cells near coast to be below sea level (coastline erosion)
        const distFromEnd = corridor.polyline.length - i;
        if (distFromEnd > 5) {
          expect(elevation.get(pt.gx, pt.gz)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run acceptance test**

Run: `npx vitest run test/regional/carveRiverProfiles.test.js`
Expected: PASS

- [ ] **Step 3: Run debug bitmaps to verify visually**

Run: `node scripts/debug-rivers.js --seed 786031 && node scripts/debug-river-segments.js --seed 786031`
Open `debug-rivers-786031/` and verify:
- Single connected major river from edge to coast
- No below-sea-level gaps along corridors
- Valley is visible in elevation bitmaps

- [ ] **Step 4: Commit**

```bash
git add test/regional/carveRiverProfiles.test.js
git commit -m "test: add acceptance tests for river connectivity with seed 786031"
```
