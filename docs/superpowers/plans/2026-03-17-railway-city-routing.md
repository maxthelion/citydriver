# Railway City-Scale Routing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-route inherited railways at city resolution (5m grid) so tracks go around hills, and apply gentle grading to flatten the track corridor. Place the station using spatial analysis rather than simple nearest-point.

**Architecture:** Move railway processing to after terrain/water setup. Use entry points from clipped polylines + a scored station placement to define the routing problem. A* on the 5m grid with railway cost function finds the actual alignment. Then interpolate a smooth grade between entry elevation and station elevation, nudging terrain cells in the track corridor to match.

**Tech Stack:** Existing A* pathfinding, railwayCostFunction, Grid2D elevation manipulation.

---

## File Structure

| File | Responsibility |
|------|---------------|
| **Create:** `src/city/routeCityRailways.js` | Entry point extraction, station scoring, city-scale A* routing, grading |
| **Create:** `test/city/routeCityRailways.test.js` | Tests for entry extraction, station placement, routing |
| **Modify:** `src/city/setup.js` | Move railway processing after terrain setup, call routeCityRailways |

---

## Design

### Entry Points

When a regional railway polyline is clipped to the city boundary, the first/last point of the clipped polyline sits on or near the boundary. These are **entry points**. Each has:
- Position `{x, z}` in world coords
- Direction vector (from the next point inward)
- Elevation (sampled from the city elevation grid at that position)

If multiple railways enter from the same direction (within ~30 degrees), they share a corridor — only one entry point is needed.

### Station Placement

A city may have multiple railway tracks entering from different directions. The station is a junction where all lines meet at the same elevation.

**Elevation matching:** The station elevation should be close to the entry point elevations to minimise grading. Rather than an arbitrary range, use the elevation grid directly — the mean entry elevation is the target, and candidate cells are scored by how close their actual elevation is to that target. This naturally selects flat low-lying areas near rivers (where real stations tend to be) without hard-coding a height range.

The station should be placed where:
1. **Centrality is high** — near the city centre (use `landValue` as a proxy since it combines proximity + flatness)
2. **Elevation matches entries** — score cells by `1 / (1 + |cellElev - meanEntryElev| / 10)`. Cells at the same elevation as the approach tracks score highest.
3. **No water barrier** — a BFS/flood-fill from the entry point shouldn't cross water to reach the station
4. **Within the approach cone** — project a cone inward from each entry direction (~60° half-angle). Station should fall within at least one cone. With multiple tracks, it should ideally be reachable from all entry directions.
5. **On dry land** — waterMask == 0
6. **Flat terrain** — low slope from the elevation grid (slope bitmap already available)

Score each candidate cell: `score = landValue * elevationMatch * coneBonus * (1 - slope)`, pick the best. All the inputs are existing grid layers — no new computation needed.

### Multiple Tracks

When multiple tracks enter the city:
- Each entry point has its own elevation and direction
- The station elevation is the mean of all entry elevations — all approach routes grade toward this
- The elevation grid scoring naturally finds the flat area closest to that mean elevation
- Track reuse discount in the cost function ensures tracks share a corridor where they approach from similar directions

### City-Scale Routing

For each entry point, A* from entry to station on the city grid using `railwayCostFunction` with:
- Very high slope penalty (railways go around hills)
- Water penalty
- Track reuse discount (multiple lines share corridor near station)

The resulting paths replace the inherited polylines — they now follow city-scale terrain.

### Grading

After routing, for each track path:
1. Compute desired elevation at each cell: linear interpolation from entry elevation to station elevation (mean of entry elevations)
2. Where terrain is above desired elevation: **cut** — lower terrain to desired level (cutting into hillside)
3. Where terrain is below desired elevation: **fill** — raise terrain to desired level (embankment)
4. Only modify cells within the track corridor (railwayGrid cells + 1-cell buffer for shoulders)
5. Blend the cut/fill edges over 2-3 cells so terrain doesn't have a sharp cliff at the track edge
6. All tracks converge to the **same station elevation** — this is what makes multiple tracks work as a junction

---

## Chunk 1: Entry Point Extraction and Station Placement

### Task 1: Extract Entry Points and Score Station Location

**Files:**
- Create: `src/city/routeCityRailways.js`
- Create: `test/city/routeCityRailways.test.js`

- [ ] **Step 1: Write test for entry point extraction**

```javascript
// test/city/routeCityRailways.test.js
import { describe, it, expect } from 'vitest';
import { extractEntryPoints } from '../../src/city/routeCityRailways.js';

describe('extractEntryPoints', () => {
  it('extracts entry points from clipped polylines at city boundary', () => {
    const bounds = { minX: 100, minZ: 100, maxX: 500, maxZ: 500 };
    const railways = [
      { polyline: [{ x: 100, z: 300 }, { x: 200, z: 300 }, { x: 400, z: 300 }] },
    ];
    const entries = extractEntryPoints(railways, bounds);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // Entry should be near the boundary
    expect(entries[0].x).toBeLessThanOrEqual(110);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/routeCityRailways.test.js`

- [ ] **Step 3: Implement extractEntryPoints**

```javascript
// src/city/routeCityRailways.js
/**
 * City-scale railway routing.
 * Re-routes inherited railways on the 5m grid so tracks follow terrain
 * contours, and applies gentle grading to flatten the corridor.
 */

import { railwayCostFunction } from '../core/railwayCost.js';
import { findPath, simplifyPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';

const CONE_HALF_ANGLE = Math.PI / 3; // 60 degrees
const ENTRY_MERGE_ANGLE = Math.PI / 6; // 30 degrees — merge entries from similar directions

/**
 * Extract entry points where railway polylines cross the city boundary.
 * Each entry has { x, z, dirX, dirZ, elevation }.
 */
export function extractEntryPoints(railways, bounds, elevation, cellSize, originX, originZ) {
  const entries = [];
  const margin = 20; // cells from edge to count as boundary

  for (const rail of railways) {
    const pts = rail.polyline;
    if (!pts || pts.length < 2) continue;

    // Check first point — is it near a boundary?
    const first = pts[0];
    const last = pts[pts.length - 1];

    for (const [pt, nextPt] of [[first, pts[1]], [last, pts[pts.length - 2]]]) {
      const nearEdge =
        Math.abs(pt.x - bounds.minX) < margin * cellSize ||
        Math.abs(pt.x - bounds.maxX) < margin * cellSize ||
        Math.abs(pt.z - bounds.minZ) < margin * cellSize ||
        Math.abs(pt.z - bounds.maxZ) < margin * cellSize;

      if (!nearEdge) continue;

      const dx = nextPt.x - pt.x, dz = nextPt.z - pt.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;

      let elev = 0;
      if (elevation) {
        const gx = Math.round((pt.x - originX) / cellSize);
        const gz = Math.round((pt.z - originZ) / cellSize);
        if (gx >= 0 && gx < elevation.width && gz >= 0 && gz < elevation.height) {
          elev = elevation.get(gx, gz);
        }
      }

      entries.push({
        x: pt.x, z: pt.z,
        dirX: dx / len, dirZ: dz / len,
        elevation: elev,
      });
    }
  }

  // Merge entries from similar directions
  return _mergeNearbyEntries(entries);
}

function _mergeNearbyEntries(entries) {
  if (entries.length <= 1) return entries;
  const used = new Set();
  const merged = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const a = entries[i];
    let bestDist = Infinity;
    let merge = null;
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const b = entries[j];
      const dot = a.dirX * b.dirX + a.dirZ * b.dirZ;
      const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
      if (angle < ENTRY_MERGE_ANGLE) {
        const d = distance2D(a.x, a.z, b.x, b.z);
        if (d < bestDist) { bestDist = d; merge = j; }
      }
    }
    if (merge !== null) used.add(merge);
    merged.push(a);
  }
  return merged;
}
```

- [ ] **Step 4: Run test**
- [ ] **Step 5: Write test for station scoring**

```javascript
import { scoreStationLocation } from '../../src/city/routeCityRailways.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('scoreStationLocation', () => {
  it('prefers central flat dry land within approach cone', () => {
    const w = 60, h = 60, cs = 5;
    const elevation = new Grid2D(w, h, { cellSize: cs });
    elevation.forEach((gx, gz) => elevation.set(gx, gz, 50));
    const waterMask = new Grid2D(w, h, { type: 'uint8' });
    const landValue = new Grid2D(w, h, { type: 'float32' });
    // High land value in centre
    for (let gz = 25; gz < 35; gz++)
      for (let gx = 25; gx < 35; gx++)
        landValue.set(gx, gz, 0.8);

    const entries = [{ x: 0, z: 150, dirX: 1, dirZ: 0, elevation: 50 }];
    const result = scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cs, 0, 0);
    expect(result).not.toBeNull();
    // Station should be in the high-value central area
    expect(result.gx).toBeGreaterThan(20);
    expect(result.gx).toBeLessThan(40);
  });
});
```

- [ ] **Step 6: Implement scoreStationLocation**

```javascript
/**
 * Score candidate cells for station placement.
 * Returns { gx, gz, x, z, elevation, angle } or null.
 */
export function scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cs, originX, originZ) {
  if (entries.length === 0) return null;

  // Target elevation: mean of all entry elevations — the station should be
  // at the same height the tracks are already at when they enter the city.
  const targetElev = entries.reduce((s, e) => s + e.elevation, 0) / entries.length;
  const slope = _computeSlope(elevation, w, h);

  let bestScore = -1;
  let best = null;

  for (let gz = 5; gz < h - 5; gz++) {
    for (let gx = 5; gx < w - 5; gx++) {
      if (waterMask.get(gx, gz) > 0) continue;

      const wx = originX + gx * cs;
      const wz = originZ + gz * cs;

      // Must be within at least one entry's approach cone
      let inCone = false;
      for (const entry of entries) {
        const toX = wx - entry.x, toZ = wz - entry.z;
        const toLen = Math.sqrt(toX * toX + toZ * toZ) || 1;
        const dot = (toX / toLen) * entry.dirX + (toZ / toLen) * entry.dirZ;
        if (dot > Math.cos(CONE_HALF_ANGLE)) { inCone = true; break; }
      }
      if (!inCone) continue;

      const elev = elevation.get(gx, gz);
      const elevMatch = 1 / (1 + Math.abs(elev - targetElev) / 10);
      const lv = landValue.get(gx, gz);
      const flatness = 1 - Math.min(1, slope.get(gx, gz) / 0.1);

      const score = lv * elevMatch * flatness;
      if (score > bestScore) {
        bestScore = score;
        // Compute angle from dominant entry direction
        let bestEntry = entries[0];
        let bestEntryDist = Infinity;
        for (const e of entries) {
          const d = distance2D(wx, wz, e.x, e.z);
          if (d < bestEntryDist) { bestEntryDist = d; bestEntry = e; }
        }
        best = {
          gx, gz,
          x: wx, z: wz,
          elevation: elev,
          angle: Math.atan2(bestEntry.dirZ, bestEntry.dirX),
        };
      }
    }
  }
  return best;
}

function _computeSlope(elevation, w, h) {
  const slope = new (elevation.constructor)(w, h);
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      const dex = elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz);
      const dez = elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1);
      slope.set(gx, gz, Math.sqrt(dex * dex + dez * dez) / (2 * elevation.cellSize));
    }
  }
  return slope;
}
```

- [ ] **Step 7: Run tests**
- [ ] **Step 8: Commit**

```bash
git add src/city/routeCityRailways.js test/city/routeCityRailways.test.js
git commit -m "feat: entry point extraction and station placement scoring for city railways"
```

---

## Chunk 2: City-Scale A* Routing

### Task 2: Route Railways on City Grid

**Files:**
- Modify: `src/city/routeCityRailways.js`
- Modify: `test/city/routeCityRailways.test.js`

- [ ] **Step 1: Write test for city-scale routing**

```javascript
import { routeCityRailways } from '../../src/city/routeCityRailways.js';

describe('routeCityRailways', () => {
  it('produces paths from entry points to station on flat terrain', () => {
    const w = 80, h = 80, cs = 5;
    const elevation = new Grid2D(w, h, { cellSize: cs });
    elevation.forEach((gx, gz) => elevation.set(gx, gz, 50));
    const waterMask = new Grid2D(w, h, { type: 'uint8' });
    const landValue = new Grid2D(w, h, { type: 'float32' });
    landValue.forEach((gx, gz) => landValue.set(gx, gz, 0.5));

    const railways = [
      { polyline: [{ x: 0, z: 200 }, { x: 100, z: 200 }, { x: 300, z: 200 }] },
    ];
    const bounds = { minX: 0, minZ: 0, maxX: 400, maxZ: 400 };

    const result = routeCityRailways(railways, elevation, waterMask, landValue, bounds, cs, 0, 0);
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.station).not.toBeNull();
  });
});
```

- [ ] **Step 2: Implement routeCityRailways**

```javascript
/**
 * Main entry: re-route inherited railways at city resolution.
 *
 * @param {Array} railways - inherited railway polylines (from inheritRailways)
 * @param {Grid2D} elevation
 * @param {Grid2D} waterMask
 * @param {Grid2D} landValue
 * @param {object} bounds - { minX, minZ, maxX, maxZ }
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 * @returns {{ paths: Array<{path, polyline}>, station: object|null, railGrid: Grid2D }}
 */
export function routeCityRailways(railways, elevation, waterMask, landValue, bounds, cellSize, originX, originZ) {
  const w = elevation.width, h = elevation.height;

  const entries = extractEntryPoints(railways, bounds, elevation, cellSize, originX, originZ);
  if (entries.length === 0) return { paths: [], station: null, railGrid: null };

  const station = scoreStationLocation(entries, elevation, waterMask, landValue, w, h, cellSize, originX, originZ);
  if (!station) return { paths: [], station: null, railGrid: null };

  const railGrid = new (elevation.constructor.name === 'Grid2D' ? elevation.constructor : Grid2D)(w, h, { type: 'uint8', cellSize });

  const costFn = railwayCostFunction(elevation, {
    slopePenalty: 150,
    waterGrid: waterMask,
    waterPenalty: 500,
    edgeMargin: 0,
    edgePenalty: 0,
  });

  // Rail-aware cost for corridor sharing
  const railCost = (fromGx, fromGz, toGx, toGz) => {
    const base = costFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(base)) return base;
    if (railGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.05;
    }
    return base;
  };

  const paths = [];
  for (const entry of entries) {
    const entryGx = Math.round((entry.x - originX) / cellSize);
    const entryGz = Math.round((entry.z - originZ) / cellSize);
    const clampedGx = Math.max(0, Math.min(w - 1, entryGx));
    const clampedGz = Math.max(0, Math.min(h - 1, entryGz));

    const result = findPath(clampedGx, clampedGz, station.gx, station.gz, w, h, railCost);
    if (!result) continue;

    // Stamp grid
    for (const p of result.path) railGrid.set(p.gx, p.gz, 1);

    const simplified = simplifyPath(result.path, 4);
    const polyline = simplified.map(p => ({
      x: originX + p.gx * cellSize,
      z: originZ + p.gz * cellSize,
    }));

    paths.push({ path: simplified, polyline });
  }

  return { paths, station, railGrid };
}
```

- [ ] **Step 3: Run test**
- [ ] **Step 4: Commit**

```bash
git add src/city/routeCityRailways.js test/city/routeCityRailways.test.js
git commit -m "feat: city-scale A* railway routing from entry points to station"
```

---

## Chunk 3: Grading and Integration

### Task 3: Apply Railway Grading

**Files:**
- Modify: `src/city/routeCityRailways.js`

- [ ] **Step 1: Add gradeRailwayCorridor function**

After routing, interpolate a smooth grade from entry elevation to station elevation along each path. Modify terrain cells in the corridor to match.

```javascript
/**
 * Apply gentle grading to the railway corridor.
 * Interpolates elevation along the path from entry to station,
 * then cuts/fills terrain to match within the corridor width.
 */
export function gradeRailwayCorridor(paths, entries, station, elevation, railGrid, cellSize) {
  const CORRIDOR_RADIUS = 2; // cells — grade this far either side of track
  const BLEND_RADIUS = 3;    // cells — blend edge back to natural terrain

  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi].path;
    if (path.length < 2) continue;

    const entryElev = entries[pi]?.elevation ?? elevation.get(path[0].gx, path[0].gz);
    const stationElev = station.elevation;

    // Compute cumulative distance along path
    const dists = [0];
    for (let i = 1; i < path.length; i++) {
      const dx = (path[i].gx - path[i-1].gx) * cellSize;
      const dz = (path[i].gz - path[i-1].gz) * cellSize;
      dists.push(dists[i-1] + Math.sqrt(dx*dx + dz*dz));
    }
    const totalDist = dists[dists.length - 1] || 1;

    // For each path cell, compute desired elevation and modify terrain
    for (let i = 0; i < path.length; i++) {
      const t = dists[i] / totalDist;
      const desiredElev = entryElev + (stationElev - entryElev) * t;

      // Modify cells within corridor
      for (let dz = -CORRIDOR_RADIUS; dz <= CORRIDOR_RADIUS; dz++) {
        for (let dx = -CORRIDOR_RADIUS; dx <= CORRIDOR_RADIUS; dx++) {
          const gx = path[i].gx + dx, gz = path[i].gz + dz;
          if (gx < 0 || gx >= elevation.width || gz < 0 || gz >= elevation.height) continue;
          elevation.set(gx, gz, desiredElev);
        }
      }

      // Blend edges
      for (let dz = -BLEND_RADIUS; dz <= BLEND_RADIUS; dz++) {
        for (let dx = -BLEND_RADIUS; dx <= BLEND_RADIUS; dx++) {
          const r = Math.sqrt(dx*dx + dz*dz);
          if (r <= CORRIDOR_RADIUS || r > BLEND_RADIUS) continue;
          const gx = path[i].gx + dx, gz = path[i].gz + dz;
          if (gx < 0 || gx >= elevation.width || gz < 0 || gz >= elevation.height) continue;
          const blendT = (r - CORRIDOR_RADIUS) / (BLEND_RADIUS - CORRIDOR_RADIUS);
          const natural = elevation.get(gx, gz);
          elevation.set(gx, gz, desiredElev + (natural - desiredElev) * blendT);
        }
      }
    }
  }
}
```

- [ ] **Step 2: Test grading doesn't crash and modifies elevation**
- [ ] **Step 3: Commit**

```bash
git add src/city/routeCityRailways.js test/city/routeCityRailways.test.js
git commit -m "feat: railway corridor grading (cut and fill)"
```

---

### Task 4: Wire Into City Setup

**Files:**
- Modify: `src/city/setup.js`

Move railway processing to after terrain/water/landValue are computed. Replace the current railway inheritance block with a call to `routeCityRailways`.

- [ ] **Step 1: Read current setup.js and identify the insertion point**

Railway processing should happen after:
- `map.setTerrain(elevation, slope)` (line 207)
- `map.classifyWater(seaLevel)` (line 213)
- `map.carveChannels()` (line 216)
- `map.computeLandValue()` (line 263)

And before:
- `placeNuclei()` (line 268)

- [ ] **Step 2: Move railway import and add city routing**

Remove the early railway inheritance block (lines 151-204). After `map.computeLandValue()` / `map.setLayer('landValue', ...)`, add:

```javascript
  // Import and re-route railways at city resolution
  const railways = layers.getData('railways');
  if (railways) {
    const cityRailways = inheritRailways(railways, bounds, {
      chaikinPasses: 0, // no smoothing — we'll re-route on the city grid
      margin: cityCellSize,
    });

    if (cityRailways.length > 0) {
      const railResult = routeCityRailways(
        cityRailways, elevation, map.waterMask, map.landValue,
        bounds, cityCellSize, originX, originZ,
      );

      // Apply grading
      if (railResult.paths.length > 0 && railResult.station) {
        const entries = extractEntryPoints(cityRailways, bounds, elevation, cityCellSize, originX, originZ);
        gradeRailwayCorridor(railResult.paths, entries, railResult.station, elevation, railResult.railGrid, cityCellSize);
      }

      // Add re-routed railways as features
      for (const rp of railResult.paths) {
        map.addFeature('railway', { polyline: rp.polyline });
      }

      // Copy railGrid
      if (railResult.railGrid) {
        for (let gz = 0; gz < map.height; gz++) {
          for (let gx = 0; gx < map.width; gx++) {
            if (railResult.railGrid.get(gx, gz) > 0) map.railwayGrid.set(gx, gz, 1);
          }
        }
      }

      if (railResult.station) map.station = railResult.station;
    }
  }
```

- [ ] **Step 3: Add import for routeCityRailways**

```javascript
import { routeCityRailways, extractEntryPoints, gradeRailwayCorridor } from './routeCityRailways.js';
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/city/setup.js
git commit -m "feat: wire city-scale railway routing and grading into setup"
```
