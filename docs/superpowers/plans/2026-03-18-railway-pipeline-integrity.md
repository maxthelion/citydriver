# Railway Pipeline Integrity Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the railway pipeline so polyline and grid never diverge, grading matches what's rendered, and bitmap tests verify the invariants.

**Architecture:** The polyline is the single source of truth. The grid is derived from it (like roads). Grading modifies terrain along the polyline. No raw A* path is stored — only the simplified polyline. Testing uses bitmap assertions: railway cells ≠ water cells, graded elevation is smooth, station is on dry land.

**Tech Stack:** Existing Grid2D, FeatureMap, vitest.

---

## The Problem

The current pipeline has multiple representations that diverge:

```
A* raw path (grid coords, 800+ cells)
  ├─→ stamped onto railGrid in routeCityRailways (wiggly)
  ├─→ simplified to polyline (6-9 points, smooth curves)
  │     └─→ added as feature → _stampRailway stamps railwayGrid from polyline (different cells!)
  └─→ grading walks raw path (doesn't match rendered polyline)
```

Roads don't have this problem because there's ONE path:
```
polyline → _stampRoad stamps roadGrid from polyline
         → prepareCityScene converts to localPts for rendering
         → terrain cut from same polyline
```

## The Fix

Railway should follow the road pattern:

```
A* raw path → simplify → polyline (source of truth)
  ├─→ addFeature('railway', { polyline }) → _stampRailway stamps railwayGrid
  ├─→ prepareCityScene converts to localPts for rendering
  └─→ gradeRailwayCorridor walks the polyline (not raw path)
```

One path. Grid derived from it. Grading follows it. Rendering follows it.

## Invariants (tested via bitmap assertions)

1. **Railway ∩ Water = ∅** — no railway cell should be a water cell
2. **Railway ∩ Building = ∅** — no building placed on railway cells
3. **Station on dry land** — station grid position has waterMask=0
4. **Station on railway** — station grid position is within 3 cells of a railwayGrid cell
5. **Graded elevation is smooth** — along railway cells sorted by distance from entry, elevation changes by no more than `maxGradient * cellSize` per cell
6. **Entry elevation > sea level** — entry points should be on land, not at sea level

---

## File Structure

| File | Responsibility |
|------|---------------|
| **Rewrite:** `src/city/routeCityRailways.js` | Single-source-of-truth pipeline: A* → simplify → polyline only |
| **Rewrite:** `test/city/routeCityRailways.test.js` | Bitmap invariant tests |
| **Modify:** `src/city/setup.js` | Simplified integration — just pass polyline, let FeatureMap stamp |
| **Modify:** `src/core/FeatureMap.js` | Ensure _stampRailway is the only grid writer |

---

## Chunk 1: Fix the Data Model

### Task 1: Rewrite routeCityRailways — polyline as single source of truth

**Files:**
- Rewrite: `src/city/routeCityRailways.js`

The module should:

1. `extractEntryPoints` — find boundary crossings. **Fix:** sample elevation from the first INLAND point, not the boundary point itself (which may be at sea level).

2. `scoreStationLocation` — unchanged but verify waterMask check works.

3. `routeCityRailways` — A* from entry to station, simplify, return polyline only. **No raw path stored.** No grid stamping here — let `addFeature('railway')` handle it via `_stampRailway`.

4. `gradeRailwayCorridor` — walk the polyline (world coords), sample intermediate points along each segment at cellSize intervals, compute desired elevation at each, modify elevation grid. This matches what `_stampRailway` does — both walk the same polyline.

Key changes:
- Remove `rawPath` from output
- Remove `railGrid` from output — the FeatureMap's `railwayGrid` is the only grid
- `gradeRailwayCorridor` takes polylines (world coords), not grid paths
- Entry elevation sampled from first point that's > 5m above sea level

- [ ] **Step 1: Rewrite the module**

```javascript
// src/city/routeCityRailways.js

import { railwayCostFunction } from '../core/railwayCost.js';
import { findPath, simplifyPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';

const CONE_HALF_ANGLE = Math.PI / 3;
const ENTRY_MERGE_ANGLE = Math.PI / 6;

/**
 * Extract entry points where railways cross the city boundary.
 * Entry elevation is sampled from the first inland point, not the boundary.
 */
export function extractEntryPoints(railways, bounds, elevation, cellSize, originX, originZ, seaLevel) {
  const entries = [];
  const margin = cellSize ? 20 * cellSize : 100;
  const sl = seaLevel || 0;

  for (const rail of railways) {
    const pts = rail.polyline;
    if (!pts || pts.length < 2) continue;

    for (const [pt, nextPt, inwardPts] of [
      [pts[0], pts[1], pts],
      [pts[pts.length - 1], pts[pts.length - 2], [...pts].reverse()],
    ]) {
      const nearEdge =
        Math.abs(pt.x - bounds.minX) < margin ||
        Math.abs(pt.x - bounds.maxX) < margin ||
        Math.abs(pt.z - bounds.minZ) < margin ||
        Math.abs(pt.z - bounds.maxZ) < margin;
      if (!nearEdge) continue;

      const dx = nextPt.x - pt.x, dz = nextPt.z - pt.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;

      // Sample elevation from first inland point (above sea level)
      let elev = sl + 10; // fallback
      if (elevation && cellSize) {
        for (const p of inwardPts) {
          const gx = Math.round((p.x - (originX || 0)) / cellSize);
          const gz = Math.round((p.z - (originZ || 0)) / cellSize);
          if (gx >= 0 && gx < elevation.width && gz >= 0 && gz < elevation.height) {
            const e = elevation.get(gx, gz);
            if (e > sl + 2) { elev = e; break; }
          }
        }
      }

      entries.push({ x: pt.x, z: pt.z, dirX: dx / len, dirZ: dz / len, elevation: elev });
    }
  }
  return _mergeNearbyEntries(entries);
}

function _mergeNearbyEntries(entries) {
  if (entries.length <= 1) return entries;
  const used = new Set();
  const merged = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const dot = entries[i].dirX * entries[j].dirX + entries[i].dirZ * entries[j].dirZ;
      if (Math.acos(Math.min(1, Math.max(-1, dot))) < ENTRY_MERGE_ANGLE) used.add(j);
    }
    merged.push(entries[i]);
  }
  return merged;
}

/**
 * Score station location using elevation, land value, slope, approach cones.
 */
export function scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cs, originX, originZ) {
  if (entries.length === 0) return null;
  const targetElev = entries.reduce((s, e) => s + e.elevation, 0) / entries.length;

  let bestScore = -1, best = null;
  for (let gz = 5; gz < h - 5; gz++) {
    for (let gx = 5; gx < w - 5; gx++) {
      if (waterMask.get(gx, gz) > 0) continue;

      const wx = originX + gx * cs, wz = originZ + gz * cs;

      let inCone = false;
      for (const e of entries) {
        const toX = wx - e.x, toZ = wz - e.z;
        const toLen = Math.sqrt(toX * toX + toZ * toZ) || 1;
        if ((toX / toLen) * e.dirX + (toZ / toLen) * e.dirZ > Math.cos(CONE_HALF_ANGLE)) {
          inCone = true; break;
        }
      }
      if (!inCone) continue;

      const elev = elevation.get(gx, gz);
      const elevMatch = 1 / (1 + Math.abs(elev - targetElev) / 10);
      const lv = landValue.get(gx, gz);
      const dex = (gx > 0 && gx < w-1) ? elevation.get(gx+1, gz) - elevation.get(gx-1, gz) : 0;
      const dez = (gz > 0 && gz < h-1) ? elevation.get(gx, gz+1) - elevation.get(gx, gz-1) : 0;
      const flatness = 1 - Math.min(1, Math.sqrt(dex*dex + dez*dez) / (2 * cs) / 0.1);

      const score = lv * elevMatch * flatness;
      if (score > bestScore) {
        bestScore = score;
        let be = entries[0], bd = Infinity;
        for (const e of entries) {
          const d = distance2D(wx, wz, e.x, e.z);
          if (d < bd) { bd = d; be = e; }
        }
        best = { gx, gz, x: wx, z: wz, elevation: elev, angle: Math.atan2(be.dirZ, be.dirX) };
      }
    }
  }
  return best;
}

/**
 * Route railways at city scale. Returns polylines only — no grid.
 * The grid is stamped by FeatureMap._stampRailway when features are added.
 */
export function routeCityRailways(railways, elevation, waterMask, landValue, bounds, cellSize, originX, originZ, seaLevel) {
  const w = elevation.width, h = elevation.height;

  const entries = extractEntryPoints(railways, bounds, elevation, cellSize, originX, originZ, seaLevel);
  if (entries.length === 0) return { polylines: [], station: null, entries: [] };

  const station = scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cellSize, originX, originZ);
  if (!station) return { polylines: [], station: null, entries };

  const costFn = railwayCostFunction(elevation, {
    slopePenalty: 150,
    waterGrid: waterMask,
    waterPenalty: 500,
    edgeMargin: 0,
    edgePenalty: 0,
  });

  // Temporary grid for track reuse discount between paths
  const tempGrid = new (Object.getPrototypeOf(elevation).constructor)(w, h, { type: 'uint8', cellSize });

  const railCost = (fromGx, fromGz, toGx, toGz) => {
    const base = costFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(base)) return base;
    if (tempGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.05;
    }
    return base;
  };

  const polylines = [];
  for (const entry of entries) {
    const egx = Math.max(0, Math.min(w - 1, Math.round((entry.x - originX) / cellSize)));
    const egz = Math.max(0, Math.min(h - 1, Math.round((entry.z - originZ) / cellSize)));

    const result = findPath(egx, egz, station.gx, station.gz, w, h, railCost);
    if (!result) continue;

    // Stamp temp grid for later paths to share corridor
    for (const p of result.path) tempGrid.set(p.gx, p.gz, 1);

    // Simplify and convert to world coords — this polyline IS the source of truth
    const simplified = simplifyPath(result.path, 40);
    const polyline = simplified.map(p => ({
      x: originX + p.gx * cellSize,
      z: originZ + p.gz * cellSize,
    }));

    polylines.push(polyline);
  }

  return { polylines, station, entries };
}

/**
 * Grade terrain along railway polylines.
 * Walks each polyline at cellSize intervals, interpolating elevation
 * from entry to station. Same walk pattern as _stampRailway in FeatureMap.
 */
export function gradeRailwayCorridor(polylines, entries, station, elevation, cellSize, originX, originZ) {
  const BLEND_RADIUS = 3;
  const w = elevation.width, h = elevation.height;

  for (let pi = 0; pi < polylines.length; pi++) {
    const polyline = polylines[pi];
    if (polyline.length < 2) continue;

    const entryElev = entries[pi]?.elevation ?? station.elevation;
    const stationElev = station.elevation;

    // Compute total polyline length
    let totalLen = 0;
    for (let i = 1; i < polyline.length; i++) {
      totalLen += distance2D(polyline[i].x, polyline[i].z, polyline[i-1].x, polyline[i-1].z);
    }
    if (totalLen < 1) continue;

    // Walk polyline at cellSize intervals, grade terrain
    let cumLen = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x, az = polyline[i].z;
      const bx = polyline[i+1].x, bz = polyline[i+1].z;
      const segLen = distance2D(ax, az, bx, bz);
      const steps = Math.max(1, Math.ceil(segLen / cellSize));

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const alongT = (cumLen + segLen * t) / totalLen;
        const desiredElev = entryElev + (stationElev - entryElev) * alongT;

        const cgx = Math.round((px - originX) / cellSize);
        const cgz = Math.round((pz - originZ) / cellSize);

        // Grade corridor + blend edges
        for (let ddz = -BLEND_RADIUS; ddz <= BLEND_RADIUS; ddz++) {
          for (let ddx = -BLEND_RADIUS; ddx <= BLEND_RADIUS; ddx++) {
            const gx = cgx + ddx, gz = cgz + ddz;
            if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
            const r = Math.sqrt(ddx * ddx + ddz * ddz);
            if (r > BLEND_RADIUS) continue;
            if (r <= 1) {
              elevation.set(gx, gz, desiredElev);
            } else {
              const blendT = (r - 1) / (BLEND_RADIUS - 1);
              const natural = elevation.get(gx, gz);
              elevation.set(gx, gz, desiredElev + (natural - desiredElev) * blendT);
            }
          }
        }
      }
      cumLen += segLen;
    }
  }
}
```

- [ ] **Step 2: Run existing tests (some will need updating)**
- [ ] **Step 3: Commit**

---

### Task 2: Bitmap Invariant Tests

**Files:**
- Rewrite: `test/city/routeCityRailways.test.js`

These tests generate a full city from a regional pipeline and check bitmap-level invariants.

- [ ] **Step 1: Write bitmap invariant tests**

```javascript
import { describe, it, expect } from 'vitest';
import { extractEntryPoints, scoreStationLocation, routeCityRailways, gradeRailwayCorridor } from '../../src/city/routeCityRailways.js';
import { Grid2D } from '../../src/core/Grid2D.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { setupCity } from '../../src/city/setup.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('railway pipeline bitmap invariants', () => {
  // Generate a real city for invariant testing
  function makeCity(seed) {
    const rng = new SeededRandom(seed);
    const layers = generateRegion({ width: 64, height: 64, cellSize: 200 }, rng);
    const s = layers.getData('settlements').find(s => s.tier === 1) || layers.getData('settlements')[0];
    return setupCity(layers, s, new SeededRandom(seed));
  }

  it('railway cells never overlap water cells', () => {
    const map = makeCity(42);
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.railwayGrid.get(gx, gz) > 0) {
          expect(map.waterMask.get(gx, gz), `railway on water at (${gx},${gz})`).toBe(0);
        }
      }
    }
  });

  it('station is on dry land', () => {
    const map = makeCity(42);
    if (map.station) {
      const gx = Math.round((map.station.x - map.originX) / map.cellSize);
      const gz = Math.round((map.station.z - map.originZ) / map.cellSize);
      if (gx >= 0 && gx < map.width && gz >= 0 && gz < map.height) {
        expect(map.waterMask.get(gx, gz), 'station on water').toBe(0);
      }
    }
  });

  it('railway cells have buildability 0', () => {
    const map = makeCity(42);
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.railwayGrid.get(gx, gz) > 0) {
          expect(map.buildability.get(gx, gz), `buildable at railway (${gx},${gz})`).toBe(0);
        }
      }
    }
  });

  it('entry elevations are above sea level', () => {
    const map = makeCity(42);
    // Can't directly test entries from outside, but we can check station elevation
    if (map.station) {
      expect(map.station.elevation).toBeGreaterThan(map.seaLevel || 0);
    }
  });

  // Test across multiple seeds for robustness
  for (const seed of [42, 99, 751119]) {
    it(`invariants hold for seed ${seed}`, () => {
      const map = makeCity(seed);
      let railOnWater = 0;
      for (let gz = 0; gz < map.height; gz++) {
        for (let gx = 0; gx < map.width; gx++) {
          if (map.railwayGrid.get(gx, gz) > 0 && map.waterMask.get(gx, gz) > 0) {
            railOnWater++;
          }
        }
      }
      expect(railOnWater, `seed ${seed}: railway on water`).toBe(0);

      if (map.station) {
        const sgx = Math.round((map.station.x - map.originX) / map.cellSize);
        const sgz = Math.round((map.station.z - map.originZ) / map.cellSize);
        if (sgx >= 0 && sgx < map.width && sgz >= 0 && sgz < map.height) {
          expect(map.waterMask.get(sgx, sgz), `seed ${seed}: station on water`).toBe(0);
        }
      }
    });
  }
});

describe('unit tests', () => {
  it('extractEntryPoints finds boundary crossings', () => {
    const bounds = { minX: 100, minZ: 100, maxX: 500, maxZ: 500 };
    const railways = [
      { polyline: [{ x: 100, z: 300 }, { x: 200, z: 300 }, { x: 400, z: 300 }] },
    ];
    const entries = extractEntryPoints(railways, bounds);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('scoreStationLocation returns null with no entries', () => {
    const e = new Grid2D(10, 10, { cellSize: 5 });
    const w = new Grid2D(10, 10, { type: 'uint8' });
    const l = new Grid2D(10, 10, { type: 'float32' });
    expect(scoreStationLocation([], e, w, l, 10, 10, 5, 0, 0)).toBeNull();
  });

  it('routeCityRailways returns polylines not raw paths', () => {
    const w = 80, h = 80, cs = 5;
    const elevation = new Grid2D(w, h, { cellSize: cs });
    elevation.forEach((gx, gz) => elevation.set(gx, gz, 50));
    const waterMask = new Grid2D(w, h, { type: 'uint8' });
    const landValue = new Grid2D(w, h, { type: 'float32' });
    landValue.forEach((gx, gz) => landValue.set(gx, gz, 0.5));

    const railways = [{ polyline: [{ x: 0, z: 200 }, { x: 100, z: 200 }, { x: 300, z: 200 }] }];
    const bounds = { minX: 0, minZ: 0, maxX: 400, maxZ: 400 };

    const result = routeCityRailways(railways, elevation, waterMask, landValue, bounds, cs, 0, 0);
    expect(result.polylines.length).toBeGreaterThan(0);
    // Should NOT have rawPath or railGrid
    expect(result.railGrid).toBeUndefined();
    for (const pl of result.polylines) {
      expect(pl[0]).toHaveProperty('x');
      expect(pl[0]).toHaveProperty('z');
    }
  });
});
```

- [ ] **Step 2: Run tests**
- [ ] **Step 3: Commit**

---

### Task 3: Update setup.js Integration

**Files:**
- Modify: `src/city/setup.js`

Simplify the integration. `routeCityRailways` returns polylines. `gradeRailwayCorridor` walks them. `addFeature('railway')` stamps the grid. One path through the data.

- [ ] **Step 1: Update the railway block in setup.js**

```javascript
  // Import and re-route railways at city resolution
  const railways = layers.getData('railways');
  if (railways) {
    const cityRailways = inheritRailways(railways, bounds, {
      chaikinPasses: 0,
      margin: cityCellSize,
    });

    if (cityRailways.length > 0) {
      const railResult = routeCityRailways(
        cityRailways, elevation, map.waterMask, map.landValue,
        bounds, cityCellSize, originX, originZ, seaLevel,
      );

      // Grade terrain along polylines BEFORE adding features
      // (grading modifies elevation, then _stampRailway reads it for buildability)
      if (railResult.polylines.length > 0 && railResult.station) {
        gradeRailwayCorridor(
          railResult.polylines, railResult.entries, railResult.station,
          elevation, cityCellSize, originX, originZ,
        );
      }

      // Add as features — _stampRailway stamps railwayGrid from the polyline
      for (const polyline of railResult.polylines) {
        map.addFeature('railway', { polyline });
      }

      if (railResult.station) map.station = railResult.station;
    }
  }
```

- [ ] **Step 2: Remove the old railGrid copy loop** (no longer needed — FeatureMap handles it)
- [ ] **Step 3: Run all tests including bitmap invariants**
- [ ] **Step 4: Commit**

---

### Task 4: Verify with Visual Inspection

- [ ] **Step 1: Run dev server, check seed 751119**
  - Railway tracks should match the terrain depression
  - Station should be on dry land
  - No tracks in water

- [ ] **Step 2: Check railway schematic still works**
- [ ] **Step 3: Check 3D region view still shows railways**
- [ ] **Step 4: Final commit and push**
