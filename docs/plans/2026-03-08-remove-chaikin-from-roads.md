# Remove Chaikin Smoothing from Roads

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Chaikin corner-cutting on road polylines with simple grid-to-world conversion + quantize + dedupe, eliminating point explosion and sub-pixel noise.

**Architecture:** Chaikin smoothing quadruples point count per iteration (4 iterations = ~16x). Roads don't need this — A* paths through terrain already curve naturally. Replace all smoothing call sites with a shared `gridPathToWorldPolyline()` that converts grid coords to world coords, quantizes to half-cell resolution, and deduplicates consecutive identical points. The RDP simplification step stays.

**Tech Stack:** Vitest, ES modules, existing pathfinding.js + buildRoadNetwork.js + skeleton.js

---

## Current State

| Location | Smoothing | Iterations | Point multiplier |
|----------|-----------|------------|-----------------|
| `skeleton.js:55` (buildRoadNetwork) | Chaikin | 4 | ~16x |
| `skeleton.js:268` (_smoothPathInline) | Chaikin | 2 | ~4x |
| `skeleton.js:372` (_smoothPathInline) | Chaikin | 2 | ~4x |
| `desireLines.js:119,288` (smoothPath) | Chaikin | 2 | ~4x |
| `frontagePressure.js:164` (smoothPath) | Chaikin | 2 | ~4x |
| `faceSubdivision.js:88` (smoothPath) | Chaikin | 1 | ~2x |
| `offsetInfill.js:298` (smoothPath) | Chaikin | 2 | ~4x |
| `triangleMergeSubdiv.js:110` (smoothPath) | Chaikin | 1 | ~2x |

Regional roads (`generateRoads.js`) already use `chaikinIterations: 0` — no change needed.

## Target State

All the above → `gridPathToWorldPolyline(path, cellSize, originX, originZ)` which does:
1. Convert `{gx, gz}` → `{x, z}` world coords
2. Quantize each point to half-cell grid: `round(x / (cellSize * 0.5)) * (cellSize * 0.5)`
3. Remove consecutive duplicate points

---

### Task 1: Add `gridPathToWorldPolyline` to pathfinding.js

**Files:**
- Modify: `src/core/pathfinding.js` (add export after `smoothPath`)
- Test: `test/core/pathfinding.test.js`

**Step 1: Write the failing test**

```js
it('gridPathToWorldPolyline converts, quantizes, and dedupes', () => {
  const path = [
    { gx: 0, gz: 0 },
    { gx: 1, gz: 0 },
    { gx: 1, gz: 0 },  // duplicate
    { gx: 2, gz: 1 },
    { gx: 3, gz: 1 },
  ];
  const poly = gridPathToWorldPolyline(path, 10, 100, 200);

  // Should dedupe the duplicate
  expect(poly.length).toBe(4);

  // World coords with origin offset
  expect(poly[0]).toEqual({ x: 100, z: 200 });
  expect(poly[1]).toEqual({ x: 110, z: 200 });
  expect(poly[3]).toEqual({ x: 130, z: 210 });

  // All values quantized to half-cell (5)
  for (const p of poly) {
    expect(p.x % 5).toBe(0);
    expect(p.z % 5).toBe(0);
  }
});
```

Add import: `gridPathToWorldPolyline` from `'../../src/core/pathfinding.js'`

**Step 2:** Run `npx vitest run test/core/pathfinding.test.js` — expect FAIL

**Step 3: Implement**

Add to `src/core/pathfinding.js` after the `smoothPath` function:

```js
/**
 * Convert grid-coord path to world-coord polyline.
 * Quantizes to half-cell resolution and removes consecutive duplicates.
 *
 * @param {Array<{gx, gz}>} path
 * @param {number} cellSize
 * @param {number} [originX=0]
 * @param {number} [originZ=0]
 * @returns {Array<{x, z}>}
 */
export function gridPathToWorldPolyline(path, cellSize, originX = 0, originZ = 0) {
  if (path.length === 0) return [];

  const half = cellSize * 0.5;
  const result = [];
  let prevX = NaN, prevZ = NaN;

  for (const p of path) {
    const wx = Math.round((p.gx * cellSize + originX) / half) * half;
    const wz = Math.round((p.gz * cellSize + originZ) / half) * half;
    if (wx === prevX && wz === prevZ) continue;
    result.push({ x: wx, z: wz });
    prevX = wx;
    prevZ = wz;
  }

  return result;
}
```

**Step 4:** Run `npx vitest run test/core/pathfinding.test.js` — expect PASS

**Step 5:** Commit: `feat: add gridPathToWorldPolyline — quantized grid-to-world conversion`

---

### Task 2: Use in `buildRoadNetwork`

**Files:**
- Modify: `src/core/buildRoadNetwork.js:14` (add import), `:112-120` (replace smoothing block)
- Test: `test/core/buildRoadNetwork.test.js`

**Step 1: Write the failing test**

Add to existing describe block in `test/core/buildRoadNetwork.test.js`:

```js
it('produces quantized polylines when chaikinIterations=0', () => {
  const w = 40, h = 40;
  const roadGrid = new Grid2D(w, h, { type: 'uint8' });

  const results = buildRoadNetwork({
    width: w, height: h, cellSize: 10,
    costFn: flatCost,
    connections: [
      { from: { gx: 5, gz: 20 }, to: { gx: 35, gz: 20 }, hierarchy: 'arterial' },
    ],
    roadGrid,
    smooth: { simplifyEpsilon: 1.0, chaikinIterations: 0 },
    originX: 100, originZ: 200,
  });

  expect(results.length).toBeGreaterThan(0);
  const r = results[0];
  // polyline should NOT be null — it should be quantized world coords
  expect(r.polyline).not.toBeNull();
  expect(r.polyline.length).toBeGreaterThanOrEqual(2);
  // World coords include origin
  expect(r.polyline[0].x).toBeGreaterThanOrEqual(100);
  // All values quantized to half-cell (5)
  for (const p of r.polyline) {
    expect(p.x % 5).toBe(0);
    expect(p.z % 5).toBe(0);
  }
});
```

**Step 2:** Run `npx vitest run test/core/buildRoadNetwork.test.js` — expect FAIL (polyline is null)

**Step 3: Implement**

In `src/core/buildRoadNetwork.js`:

Add import at line 14:
```js
import { findPath, simplifyPath, smoothPath } from './pathfinding.js';
```
Change to:
```js
import { findPath, simplifyPath, smoothPath, gridPathToWorldPolyline } from './pathfinding.js';
```

Replace lines 112-120 (the smoothing block):
```js
    // Smooth to world coordinates (if iterations > 0)
    let polyline = null;
    if (chaikinIterations > 0) {
      const smoothed = smoothPath(simplified, cellSize, chaikinIterations);
      polyline = smoothed.map(p => ({
        x: p.x + originX,
        z: p.z + originZ,
      }));
    }
```
With:
```js
    // Convert to world coordinates
    let polyline;
    if (chaikinIterations > 0) {
      const smoothed = smoothPath(simplified, cellSize, chaikinIterations);
      polyline = smoothed.map(p => ({
        x: p.x + originX,
        z: p.z + originZ,
      }));
    } else {
      polyline = gridPathToWorldPolyline(simplified, cellSize, originX, originZ);
    }
```

**Step 4:** Run `npx vitest run test/core/buildRoadNetwork.test.js` — expect PASS

**Step 5:** Commit: `feat: buildRoadNetwork produces quantized polylines when chaikin=0`

---

### Task 3: Skeleton main roads — disable Chaikin

**Files:**
- Modify: `src/city/skeleton.js:55`

**Step 1:** Change line 55:
```js
    smooth: { simplifyEpsilon: 1.0, chaikinIterations: 4 },
```
To:
```js
    smooth: { simplifyEpsilon: 1.0, chaikinIterations: 0 },
```

**Step 2:** Run `npx vitest run test/city/skeleton.test.js` — expect PASS

**Step 3:** Commit: `refactor: disable Chaikin smoothing on skeleton main roads`

---

### Task 4: Skeleton extra edges + disconnected nuclei — replace `_smoothPathInline`

**Files:**
- Modify: `src/city/skeleton.js:11` (add import), `:264-268` (extra edges), `:367-372` (nuclei)

**Step 1:** Add import at line 11:
```js
import { distance2D } from '../core/math.js';
```
Change to:
```js
import { distance2D } from '../core/math.js';
import { gridPathToWorldPolyline } from '../core/pathfinding.js';
```

Hmm — `findPath` is already imported from pathfinding.js. So change line 11:
```js
import { findPath } from '../core/pathfinding.js';
```
To:
```js
import { findPath, gridPathToWorldPolyline } from '../core/pathfinding.js';
```

**Step 2:** In `_addExtraEdges`, replace lines 263-264:
```js
    const simplified = _simplifyPathInline(result.path, 1.0);
    const smoothed = _smoothPathInline(simplified, map.cellSize, map.originX, map.originZ);
```
With:
```js
    const simplified = _simplifyPathInline(result.path, 1.0);
    const smoothed = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
```

**Step 3:** In `_connectDisconnectedNuclei`, replace lines 367-368:
```js
    const simplified = _simplifyPathInline(result.path, 1.0);
    const smoothed = _smoothPathInline(simplified, map.cellSize, map.originX, map.originZ);
```
With:
```js
    const simplified = _simplifyPathInline(result.path, 1.0);
    const smoothed = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
```

**Step 4:** Delete `_smoothPathInline` function (lines 307-323) — now unused.

**Step 5:** Run `npx vitest run test/city/skeleton.test.js` — expect PASS

**Step 6:** Commit: `refactor: replace _smoothPathInline with gridPathToWorldPolyline in skeleton`

---

### Task 5: Strategy files — replace `smoothPath` calls

Each strategy file imports `smoothPath` from pathfinding.js. Replace with `gridPathToWorldPolyline`.

**Files to modify:**
- `src/city/strategies/desireLines.js` — 2 call sites
- `src/city/strategies/frontagePressure.js` — 1 call site
- `src/city/strategies/faceSubdivision.js` — 1 call site
- `src/city/strategies/offsetInfill.js` — 1 call site
- `src/city/strategies/triangleMergeSubdiv.js` — 1 call site

For each file, the pattern is the same:

**Import change:** `smoothPath` → `gridPathToWorldPolyline`

Note: some files also import `simplifyPath` — keep that. The `smoothPath` import is what gets replaced. Check if `smoothPath` is the only import; if so, change the import to `gridPathToWorldPolyline`. If `simplifyPath` is also imported, keep it and add `gridPathToWorldPolyline`.

**Call site change:** Each file has a pattern like:
```js
const smoothed = smoothPath(simplified, map.cellSize, N);
const polyline = smoothed.map(p => ({ x: p.x + map.originX, z: p.z + map.originZ }));
```
or just:
```js
const smoothed = smoothPath(simplified, map.cellSize, N);
```
(where smoothPath already handles grid→world without origin, and origin is added later or not needed)

Replace with:
```js
const polyline = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
```

**Important:** `smoothPath` returns world coords WITHOUT origin offset (just `gx * cellSize`). Callers typically add origin themselves. `gridPathToWorldPolyline` includes origin, so remove the manual offset.

Check each call site individually for how origin is handled.

**Step 1:** Make all 5 file changes (import + call site)

**Step 2:** Run `npx vitest run` — expect all 172 tests PASS

**Step 3:** Commit: `refactor: replace smoothPath with gridPathToWorldPolyline in all strategies`

---

### Task 6: Clean up dead code

**Files:**
- Modify: `src/core/pathfinding.js` — remove `smoothPath` export if no longer used
- Modify: `src/city/skeleton.js` — `_simplifyPathInline` may still be used by extra edges/nuclei

**Step 1:** Search for remaining `smoothPath` imports:
```bash
grep -r "smoothPath" src/
```
If none remain (besides the definition), remove the function and its test.

**Step 2:** Search for `_smoothPathInline` — should be gone after Task 4. Verify and remove if dead.

**Step 3:** Run `npx vitest run` — expect PASS

**Step 4:** Commit: `chore: remove dead smoothPath and _smoothPathInline code`

---

### Task 7: Verify visually

**Step 1:** Open `http://localhost:3000/?seed=652341&mode=skeletons&gx=97&gz=103`

**Step 2:** Check:
- Road polylines have fewer vertex dots (red dots in micro view)
- Roads still follow terrain naturally (A* paths curve around obstacles)
- No visual regression in road quality
- Bridge roads (cyan) still connect properly

**Step 3:** Spot-check 2-3 other seeds to confirm no regressions.
