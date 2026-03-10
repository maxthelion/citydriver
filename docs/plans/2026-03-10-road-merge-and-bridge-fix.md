# Road Merge & Bridge Splice Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix duplicate overlapping roads by rewriting the cell merge algorithm, splice bridges into triggering roads, and remove ~400 lines of symptom-patching code.

**Architecture:** Replace the walk-each-path merge with a cell-graph that extracts unique segments between junctions. Rewrite bridge placement to modify the triggering road's polyline in-place instead of creating separate features. Remove `resolveCrossingEdges`, `resolveShallowAngles`, and parallel-road detection from `compactRoads` since they patch symptoms of the merge bug.

**Tech Stack:** Vitest, ES modules, no external dependencies.

---

### Task 1: Rewrite `mergeRoadPaths` with cell-graph approach

**Files:**
- Modify: `src/core/mergeRoadPaths.js` (full rewrite, 80 lines → ~100 lines)
- Test: `test/core/mergeRoadPaths.test.js` (new file)

**Step 1: Write the failing tests**

Create `test/core/mergeRoadPaths.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { mergeRoadPaths } from '../../src/core/mergeRoadPaths.js';

describe('mergeRoadPaths', () => {
  /** Helper: make a horizontal path from (startGx, gz) to (endGx, gz). */
  function hPath(startGx, endGx, gz) {
    const cells = [];
    const step = startGx < endGx ? 1 : -1;
    for (let gx = startGx; gx !== endGx + step; gx += step) {
      cells.push({ gx, gz });
    }
    return cells;
  }

  /** Helper: make a vertical path from (gx, startGz) to (gx, endGz). */
  function vPath(gx, startGz, endGz) {
    const cells = [];
    const step = startGz < endGz ? 1 : -1;
    for (let gz = startGz; gz !== endGz + step; gz += step) {
      cells.push({ gx, gz });
    }
    return cells;
  }

  it('two paths sharing a middle section produce no duplicate segments', () => {
    // Path A: x=0..7 at z=0
    // Path B: x=3..10 at z=0
    // Shared: x=3..7
    const pathA = { cells: hPath(0, 7, 0), rank: 1 };
    const pathB = { cells: hPath(3, 10, 0), rank: 1 };

    const segments = mergeRoadPaths([pathA, pathB]);

    // Should get 3 segments: A-only [0..3], shared [3..7], B-only [7..10]
    expect(segments.length).toBe(3);

    // Total cells across all segments should not exceed total unique cells (11)
    // plus junction overlap points (junctions appear in two adjacent segments)
    const allCells = segments.flatMap(s => s.cells.map(c => `${c.gx},${c.gz}`));
    const uniqueCells = new Set(allCells);
    // 11 unique cells + 2 junction cells shared = at most 13
    expect(allCells.length).toBeLessThanOrEqual(13);

    // No cell should appear in more than 2 segments (junction overlap only)
    const cellCount = {};
    for (const s of segments) {
      for (const c of s.cells) {
        const key = `${c.gx},${c.gz}`;
        cellCount[key] = (cellCount[key] || 0) + 1;
      }
    }
    for (const [key, count] of Object.entries(cellCount)) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it('three paths forming a Y-junction produce 3 segments', () => {
    // All three paths share cell (5,5) as the junction
    // Path A: (0,5)..(5,5)
    // Path B: (5,5)..(10,5)
    // Path C: (5,5)..(5,10)
    const pathA = { cells: hPath(0, 5, 5), rank: 1 };
    const pathB = { cells: hPath(5, 10, 5), rank: 1 };
    const pathC = { cells: vPath(5, 5, 10), rank: 1 };

    const segments = mergeRoadPaths([pathA, pathB, pathC]);

    // 3 branches from the junction
    expect(segments.length).toBe(3);
  });

  it('path that is a subset of another produces single segment for shared part', () => {
    // Path A: x=0..10 at z=0
    // Path B: x=3..7 at z=0 (subset of A)
    const pathA = { cells: hPath(0, 10, 0), rank: 1 };
    const pathB = { cells: hPath(3, 7, 0), rank: 1 };

    const segments = mergeRoadPaths([pathA, pathB]);

    // Should get 3 segments: A-only [0..3], shared [3..7], A-only [7..10]
    expect(segments.length).toBe(3);

    // No duplicate coverage of cells 3..7
    const sharedCells = [];
    for (const s of segments) {
      for (const c of s.cells) {
        if (c.gx >= 3 && c.gx <= 7 && c.gz === 0) {
          sharedCells.push(`${c.gx},${c.gz}`);
        }
      }
    }
    // Cells 3 and 7 appear in 2 segments (junction overlap), cells 4-6 in 1
    const counts = {};
    for (const k of sharedCells) counts[k] = (counts[k] || 0) + 1;
    expect(counts['4,0']).toBe(1);
    expect(counts['5,0']).toBe(1);
    expect(counts['6,0']).toBe(1);
  });

  it('no shared cells keeps paths separate', () => {
    const pathA = { cells: hPath(0, 5, 0), rank: 1 };
    const pathB = { cells: hPath(0, 5, 10), rank: 1 };

    const segments = mergeRoadPaths([pathA, pathB]);

    expect(segments.length).toBe(2);
  });

  it('empty input returns empty', () => {
    expect(mergeRoadPaths([])).toEqual([]);
  });

  it('single path returns one segment', () => {
    const path = { cells: hPath(0, 5, 0), rank: 1 };
    const segments = mergeRoadPaths([path]);
    expect(segments.length).toBe(1);
    expect(segments[0].cells.length).toBe(6);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/mergeRoadPaths.test.js`
Expected: Some tests fail (the "no duplicate segments" test will fail with the current implementation).

**Step 3: Rewrite `mergeRoadPaths`**

Replace `src/core/mergeRoadPaths.js` with:

```js
/**
 * Merge road paths that share grid cells.
 *
 * Builds a cell graph from all paths, identifies junctions (where degree != 2
 * or path membership changes), then walks between junctions to extract unique
 * segments. Each segment is emitted exactly once.
 *
 * Input: Array<{ cells: Array<{gx, gz}>, rank: number }>
 * Output: Array<{ cells: Array<{gx, gz}> }>
 */

export function mergeRoadPaths(paths) {
  if (paths.length === 0) return [];

  // Build cell graph: adjacency + membership
  const cellData = new Map(); // "gx,gz" -> { gx, gz, neighbors: Set<string>, membership: Set<pathIndex> }

  function getOrCreate(gx, gz) {
    const key = `${gx},${gz}`;
    if (!cellData.has(key)) {
      cellData.set(key, { gx, gz, neighbors: new Set(), membership: new Set() });
    }
    return cellData.get(key);
  }

  for (let pi = 0; pi < paths.length; pi++) {
    const cells = paths[pi].cells;
    for (let ci = 0; ci < cells.length; ci++) {
      const cell = getOrCreate(cells[ci].gx, cells[ci].gz);
      cell.membership.add(pi);

      if (ci > 0) {
        const prev = `${cells[ci - 1].gx},${cells[ci - 1].gz}`;
        const curr = `${cells[ci].gx},${cells[ci].gz}`;
        if (prev !== curr) {
          cell.neighbors.add(prev);
          cellData.get(prev).neighbors.add(curr);
        }
      }
    }
  }

  // Identify junctions: degree != 2 OR membership differs from all neighbors
  function memberKey(cell) {
    return [...cell.membership].sort().join(',');
  }

  const junctions = new Set();
  for (const [key, cell] of cellData) {
    if (cell.neighbors.size !== 2) {
      junctions.add(key);
      continue;
    }

    // Check if membership changes at any neighbor
    const myKey = memberKey(cell);
    for (const nKey of cell.neighbors) {
      if (memberKey(cellData.get(nKey)) !== myKey) {
        junctions.add(key);
        break;
      }
    }
  }

  // Walk between junctions to extract segments
  const visitedEdges = new Set(); // "a->b" directed edge keys
  const segments = [];

  function edgeKey(a, b) { return `${a}->${b}`; }

  for (const startKey of junctions) {
    const startCell = cellData.get(startKey);

    for (const firstNeighborKey of startCell.neighbors) {
      if (visitedEdges.has(edgeKey(startKey, firstNeighborKey))) continue;

      // Walk from startKey through firstNeighborKey until we hit another junction
      const segment = [startCell];
      let prevKey = startKey;
      let currKey = firstNeighborKey;

      visitedEdges.add(edgeKey(startKey, firstNeighborKey));

      while (true) {
        const currCell = cellData.get(currKey);
        segment.push(currCell);

        if (junctions.has(currKey)) {
          // Reached another junction — mark the reverse edge and stop
          visitedEdges.add(edgeKey(currKey, prevKey));
          break;
        }

        // Continue walking: find the neighbor that isn't where we came from
        let nextKey = null;
        for (const nKey of currCell.neighbors) {
          if (nKey !== prevKey) {
            nextKey = nKey;
            break;
          }
        }

        if (!nextKey) break; // dead end (shouldn't happen if junctions are correct)

        visitedEdges.add(edgeKey(currKey, nextKey));
        prevKey = currKey;
        currKey = nextKey;
      }

      if (segment.length >= 2) {
        segments.push({
          cells: segment.map(c => ({ gx: c.gx, gz: c.gz })),
        });
      }
    }
  }

  return segments;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/mergeRoadPaths.test.js`
Expected: All PASS

**Step 5: Run existing buildRoadNetwork tests**

Run: `npx vitest run test/core/buildRoadNetwork.test.js`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/core/mergeRoadPaths.js test/core/mergeRoadPaths.test.js
git commit -m "Rewrite mergeRoadPaths: cell-graph approach eliminates duplicate segments"
```

---

### Task 2: Rewrite bridge placement to splice into triggering road

**Files:**
- Modify: `src/city/bridges.js` (rewrite `placeBridges`, remove `connectLandingToRoads` + helpers)
- Modify: `test/city/bridges.test.js` (update tests for splice behavior)

**Step 1: Update bridge tests for splice behavior**

Replace the `placeBridges` section of `test/city/bridges.test.js` with tests that verify the road polyline is modified rather than a separate feature created:

```js
describe('placeBridges', () => {
  it('splices a perpendicular bridge into the triggering road', () => {
    const map = makeTestMap();
    const roadsBefore = map.roads.length;

    const result = placeBridges(map);

    expect(result.placed).toBe(1);
    // No NEW road features — the bridge is spliced into the existing road
    expect(map.roads.length).toBe(roadsBefore);

    // The original road's polyline should now have more points (bridge detour)
    const road = map.roads.find(r => r.source === 'skeleton');
    expect(road.polyline.length).toBeGreaterThan(2);

    // The polyline should have points that detour perpendicular to the river
    // For a horizontal river with vertical road, the bridge banks should
    // be offset in X relative to the straight-line path
    const midPoints = road.polyline.slice(1, -1);
    // At least some midpoints should be near the river crossing
    const riverZ = 50 * map.cellSize;
    const nearRiver = midPoints.filter(p => Math.abs(p.z - riverZ) < 10 * map.cellSize);
    expect(nearRiver.length).toBeGreaterThan(0);
  });

  it('enforces minimum spacing — two parallel roads 15 cells apart', () => {
    const map = makeTestMap({ roads: false });

    for (const roadX of [45, 55]) {
      map.addFeature('road', {
        polyline: [
          { x: roadX * map.cellSize, z: 10 * map.cellSize },
          { x: roadX * map.cellSize, z: 90 * map.cellSize },
        ],
        width: 10,
        hierarchy: 'arterial',
        importance: 0.9,
        source: 'skeleton',
      });
    }

    const result = placeBridges(map);
    expect(result.placed).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('splices multiple bridges for road crossing two rivers', () => {
    const width = 100, height = 100, cellSize = 10;
    const map = new FeatureMap(width, height, cellSize);

    map.elevation = new Grid2D(width, height, { type: 'float32', fill: 10 });
    map.slope = new Grid2D(width, height, { type: 'float32', fill: 0 });

    // River 1 at z=20-25
    map.addFeature('river', {
      polyline: [
        { x: 0, z: 22.5 * cellSize, width: 5 * cellSize, accumulation: 50 },
        { x: width * cellSize, z: 22.5 * cellSize, width: 5 * cellSize, accumulation: 50 },
      ],
    });
    for (let gz = 20; gz <= 25; gz++) {
      for (let gx = 0; gx < width; gx++) {
        map.waterMask.set(gx, gz, 1);
        map.buildability.set(gx, gz, 0);
      }
    }

    // River 2 at z=70-75
    map.addFeature('river', {
      polyline: [
        { x: 0, z: 72.5 * cellSize, width: 5 * cellSize, accumulation: 50 },
        { x: width * cellSize, z: 72.5 * cellSize, width: 5 * cellSize, accumulation: 50 },
      ],
    });
    for (let gz = 70; gz <= 75; gz++) {
      for (let gx = 0; gx < width; gx++) {
        map.waterMask.set(gx, gz, 1);
        map.buildability.set(gx, gz, 0);
      }
    }

    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        if (map.waterMask.get(gx, gz) === 0) {
          map.buildability.set(gx, gz, 1.0);
        }
      }
    }

    map.addFeature('road', {
      polyline: [
        { x: 50 * cellSize, z: 5 * cellSize },
        { x: 50 * cellSize, z: 95 * cellSize },
      ],
      width: 10,
      hierarchy: 'arterial',
      importance: 0.9,
      source: 'skeleton',
    });

    const result = placeBridges(map);
    expect(result.placed).toBe(2);

    // Still only 1 road (both bridges spliced into it)
    expect(map.roads.filter(r => r.source === 'skeleton').length).toBe(1);
    const road = map.roads.find(r => r.source === 'skeleton');
    // Polyline should have grown from the bridge detours
    expect(road.polyline.length).toBeGreaterThan(2);
  });
});
```

Keep the `findRoadWaterCrossings`, `nearestRiverSegment`, and `findBridgeBanks` test sections unchanged.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/city/bridges.test.js`
Expected: FAIL (current placeBridges creates separate features)

**Step 3: Rewrite `placeBridges` to splice**

Replace `placeBridges` in `src/city/bridges.js`. The key changes:
- `findRoadWaterCrossings` now also returns a reference to the triggering road
- After computing bridge banks, splice the bridge into the road's polyline
- Remove `connectLandingToRoads`, `_gridPathToPolyline`, `_simplifyRDP`, `_ptSegDistSq`

```js
/**
 * Place bridges where skeleton roads cross rivers.
 * Splices perpendicular bridge segments into the triggering road's polyline.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @returns {{ placed: number, skipped: number }}
 */
export function placeBridges(map) {
  const crossings = findRoadWaterCrossings(map);
  if (crossings.length === 0) return { placed: 0, skipped: 0 };

  // Score and sort descending
  for (const c of crossings) {
    c.score = c.importance / Math.max(c.widthCells, 1);
  }
  crossings.sort((a, b) => b.score - a.score);

  const acceptedMidpoints = [];
  const spacingWorld = MIN_BRIDGE_SPACING * map.cellSize;
  const maxLengthWorld = MAX_BRIDGE_LENGTH * map.cellSize;

  let placed = 0;
  let skipped = 0;

  for (const crossing of crossings) {
    const river = nearestRiverSegment(map, crossing.midX, crossing.midZ);
    if (!river || river.dist > crossing.widthCells * map.cellSize * 2) {
      skipped++;
      continue;
    }

    // Enforce minimum spacing
    let tooClose = false;
    for (const b of acceptedMidpoints) {
      const dx = crossing.midX - b.x;
      const dz = crossing.midZ - b.z;
      if (Math.sqrt(dx * dx + dz * dz) < spacingWorld) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) { skipped++; continue; }

    // Perpendicular to river tangent
    const perpX = -river.tangentZ;
    const perpZ = river.tangentX;

    const banks = findBridgeBanks(map, crossing.midX, crossing.midZ, perpX, perpZ);
    if (!banks) { skipped++; continue; }

    // Reject bridges that are too long
    const bdx = banks.bankB.x - banks.bankA.x;
    const bdz = banks.bankB.z - banks.bankA.z;
    if (Math.sqrt(bdx * bdx + bdz * bdz) > maxLengthWorld) {
      skipped++;
      continue;
    }

    // Splice bridge into the triggering road's polyline
    _spliceBridge(crossing.road, crossing.entryX, crossing.entryZ,
                  crossing.exitX, crossing.exitZ, banks.bankA, banks.bankB);

    acceptedMidpoints.push({ x: crossing.midX, z: crossing.midZ });
    placed++;
  }

  return { placed, skipped };
}
```

Update `findRoadWaterCrossings` to include a reference to the triggering road in each crossing:

```js
crossings.push({
  road,           // ← add this reference
  entryX, entryZ,
  exitX, exitZ,
  midX: (entryX + exitX) / 2,
  midZ: (entryZ + exitZ) / 2,
  widthCells: waterCells,
  importance,
  hierarchy,
});
```

Add the `_spliceBridge` helper:

```js
/**
 * Splice a bridge into a road's polyline.
 * Finds the closest points on the polyline to the water entry/exit,
 * splits there, and inserts the bridge detour.
 *
 * @param {object} road - Road feature (modified in place)
 * @param {number} entryX - Water entry world X
 * @param {number} entryZ - Water entry world Z
 * @param {number} exitX - Water exit world X
 * @param {number} exitZ - Water exit world Z
 * @param {{x,z}} bankA - First bridge bank position
 * @param {{x,z}} bankB - Second bridge bank position
 */
function _spliceBridge(road, entryX, entryZ, exitX, exitZ, bankA, bankB) {
  const poly = road.polyline;

  // Find polyline point indices closest to entry and exit
  const entryIdx = _closestPointIndex(poly, entryX, entryZ);
  const exitIdx = _closestPointIndex(poly, exitX, exitZ);

  // Ensure entry comes before exit in the polyline
  const lo = Math.min(entryIdx, exitIdx);
  const hi = Math.max(entryIdx, exitIdx);

  // Determine which bank is closer to entry vs exit
  const entryPt = poly[lo];
  const dA = (bankA.x - entryPt.x) ** 2 + (bankA.z - entryPt.z) ** 2;
  const dB = (bankB.x - entryPt.x) ** 2 + (bankB.z - entryPt.z) ** 2;
  const [nearBank, farBank] = dA <= dB ? [bankA, bankB] : [bankB, bankA];

  // Build new polyline: before entry + bridge detour + after exit
  const before = poly.slice(0, lo + 1);
  const after = poly.slice(hi);
  const bridgeDetour = [nearBank, farBank];

  road.polyline = [...before, ...bridgeDetour, ...after];
}

/**
 * Find the index of the closest point in a polyline to a target position.
 */
function _closestPointIndex(polyline, x, z) {
  let bestDist = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < polyline.length; i++) {
    const dx = polyline[i].x - x;
    const dz = polyline[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}
```

Remove: `connectLandingToRoads`, `_gridPathToPolyline`, `_simplifyRDP`, `_ptSegDistSq`. Also remove the `import { findPath }` and `import { addRoadToGraph }` since they're no longer needed.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/city/bridges.test.js`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/city/bridges.js test/city/bridges.test.js
git commit -m "Bridge splice: modify triggering road polyline instead of creating separate feature"
```

---

### Task 3: Remove symptom-patching code from skeleton.js

**Files:**
- Modify: `src/city/skeleton.js`
- Delete tests: Remove `resolveCrossingEdges`/`resolveShallowAngles` sections from `test/core/PlanarGraph.test.js`
- Modify: `test/city/compactRoads.test.js` (remove parallel-detection tests, keep endpoint snapping tests)

**Step 1: Remove resolver functions and multi-pass loop from skeleton.js**

Remove from `src/city/skeleton.js`:
- The multi-pass resolver loop (lines 129-135) — replace with nothing
- `resolveCrossingEdges` function (lines 640-666)
- `resolveShallowAngles` function (lines 695-839)
- All shallow-angle helpers: `_orientedPoly`, `_polyLenCalc`, `_pointAtDist`, `_projectOntoPolyline`, `_trimWeakPoly` (lines 842-930)
- Constants: `DETECT_ANGLE_DEG`, `BRANCH_ANGLE_RAD` (lines 672-673)

In `buildSkeletonRoads`, the end of the function should go directly from `placeBridges(map)` to the closing brace — no resolver loop.

Remove the `resolveCrossingEdges` and `resolveShallowAngles` from the module's exports.

**Step 2: Simplify `compactRoads` — remove parallel-road detection**

In `compactRoads` (lines 475-607), keep:
- Pass 1: Endpoint snapping (lines 486-510)
- Pass 1b: Deduplicate consecutive identical points (lines 512-523)
- Pass 2a: Exact endpoint duplicate removal (lines 540-555)
- Short road removal (lines 597-600)
- Final removal from map.roads/map.features (lines 602-606)

Remove:
- Pass 2b: Near-parallel road detection (lines 557-595) — the `roadsByVertex` section

**Step 3: Update PlanarGraph tests**

Remove from `test/core/PlanarGraph.test.js`:
- The `import { resolveShallowAngles, resolveCrossingEdges }` line (line 3)
- The entire `describe('resolveCrossingEdges', ...)` block (lines 430-493)
- The entire `describe('resolveShallowAngles', ...)` block (lines 495-610)

**Step 4: Update compactRoads tests**

In `test/city/compactRoads.test.js`, remove the `parallel roads 1 cell apart get collapsed` test (lines 106-136) since that tested the near-parallel detection logic we're removing. Keep the other 5 tests that verify endpoint snapping and exact-duplicate removal.

**Step 5: Run all tests**

Run: `npx vitest run`
Expected: All PASS (with the removed test sections no longer counted)

**Step 6: Commit**

```bash
git add src/city/skeleton.js test/core/PlanarGraph.test.js test/city/compactRoads.test.js
git commit -m "Remove resolveCrossingEdges, resolveShallowAngles, and parallel-road detection

These patched symptoms of the merge duplicate-segment bug, which is
now fixed by the cell-graph merge rewrite."
```

---

### Task 4: Integration verification

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass. Note any failures — they may indicate code that depended on the removed exports.

**Step 2: Check for remaining imports of removed functions**

Search for any remaining references to `resolveCrossingEdges`, `resolveShallowAngles`, or `connectLandingToRoads` across the codebase. If found, update or remove them.

**Step 3: Visual verification**

Load the app, generate a city with a river, and verify:
- No overlapping grey/black road ribbons
- Bridges are part of the road (not disconnected stubs)
- Roads connect properly at junctions

**Step 4: Commit any fixups**

```bash
git add -A
git commit -m "Integration fixups after merge and bridge rewrite"
```
