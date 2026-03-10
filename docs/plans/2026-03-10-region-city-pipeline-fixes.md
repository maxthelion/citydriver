# Region-to-City Pipeline Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three data flow issues: settlements not becoming nuclei, anchor roads not reaching boundaries, and rivers losing boundary continuity and tree identity.

**Architecture:** A shared `clipPolylineToBounds` utility handles boundary interpolation for both roads and rivers. Settlements are seeded as nuclei before land-value placement. Anchor roads use the smoothed regional path with boundary intersection and intermediate waypoints. Rivers get proper boundary clipping and a `systemId`.

**Tech Stack:** JavaScript/ES modules, vitest, existing `segmentsIntersect` from `src/core/math.js`

---

### Task 1: Shared boundary clipping utility

**Files:**
- Create: `src/core/clipPolyline.js`
- Create: `test/core/clipPolyline.test.js`

This utility clips a world-coordinate polyline to a rectangular boundary, interpolating exact crossing points. Used by both anchor roads and river inheritance.

**Step 1: Write the failing tests**

```js
// test/core/clipPolyline.test.js
import { describe, it, expect } from 'vitest';
import { clipPolylineToBounds } from '../../src/core/clipPolyline.js';

describe('clipPolylineToBounds', () => {
  const bounds = { minX: 100, minZ: 100, maxX: 500, maxZ: 500 };

  it('clips a polyline crossing the full bounds to boundary intersections', () => {
    // Horizontal line from outside-left to outside-right
    const polyline = [
      { x: 0, z: 300 },
      { x: 600, z: 300 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).not.toBeNull();
    expect(result.clipped[0].x).toBeCloseTo(100);
    expect(result.clipped[0].z).toBeCloseTo(300);
    expect(result.clipped[result.clipped.length - 1].x).toBeCloseTo(500);
    expect(result.clipped[result.clipped.length - 1].z).toBeCloseTo(300);
    expect(result.entryDir).toBeDefined();
    expect(result.exitDir).toBeDefined();
  });

  it('preserves interior points', () => {
    const polyline = [
      { x: 0, z: 300 },
      { x: 200, z: 250 },
      { x: 400, z: 350 },
      { x: 600, z: 300 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    // Should have entry intersection + 2 interior + exit intersection = 4 points
    expect(result.clipped.length).toBe(4);
    expect(result.clipped[1].x).toBeCloseTo(200);
    expect(result.clipped[2].x).toBeCloseTo(400);
  });

  it('handles polyline starting inside bounds (one crossing)', () => {
    const polyline = [
      { x: 300, z: 300 },
      { x: 600, z: 300 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result.clipped[0].x).toBeCloseTo(300);
    expect(result.clipped[result.clipped.length - 1].x).toBeCloseTo(500);
    expect(result.entryDir).toBeNull(); // started inside
    expect(result.exitDir).toBeDefined();
  });

  it('handles polyline ending inside bounds (one crossing)', () => {
    const polyline = [
      { x: 0, z: 300 },
      { x: 300, z: 300 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result.clipped[0].x).toBeCloseTo(100);
    expect(result.clipped[result.clipped.length - 1].x).toBeCloseTo(300);
    expect(result.entryDir).toBeDefined();
    expect(result.exitDir).toBeNull();
  });

  it('handles polyline fully inside bounds', () => {
    const polyline = [
      { x: 200, z: 200 },
      { x: 400, z: 400 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result.clipped.length).toBe(2);
    expect(result.entryDir).toBeNull();
    expect(result.exitDir).toBeNull();
  });

  it('returns null for polyline fully outside bounds', () => {
    const polyline = [
      { x: 0, z: 0 },
      { x: 50, z: 50 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    expect(result).toBeNull();
  });

  it('provides correct entry direction for diagonal crossing', () => {
    // Road enters from bottom-left corner area at 45 degrees
    const polyline = [
      { x: 0, z: 0 },
      { x: 300, z: 300 },
      { x: 600, z: 600 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    // Entry direction should be roughly (1, 1) normalized
    const len = Math.sqrt(result.entryDir.x ** 2 + result.entryDir.z ** 2);
    expect(len).toBeCloseTo(1, 1);
    expect(result.entryDir.x).toBeGreaterThan(0);
    expect(result.entryDir.z).toBeGreaterThan(0);
  });

  it('interpolates extra properties (accumulation) at boundary crossings', () => {
    const polyline = [
      { x: 0, z: 300, accumulation: 100 },
      { x: 600, z: 300, accumulation: 200 },
    ];
    const result = clipPolylineToBounds(polyline, bounds);
    // Entry at x=100, t=100/600 ≈ 0.167, accumulation ≈ 100 + 0.167*100 ≈ 116.7
    expect(result.clipped[0].accumulation).toBeGreaterThan(100);
    expect(result.clipped[0].accumulation).toBeLessThan(200);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/clipPolyline.test.js`
Expected: FAIL — module not found

**Step 3: Implement clipPolylineToBounds**

```js
// src/core/clipPolyline.js
/**
 * Clip a polyline to a rectangular boundary, interpolating exact crossing points.
 * Returns the clipped polyline with entry/exit directions.
 *
 * @param {Array<{x, z, ...}>} polyline - World-coordinate points (may have extra properties)
 * @param {{ minX, minZ, maxX, maxZ }} bounds
 * @returns {{ clipped: Array<{x, z, ...}>, entryDir: {x,z}|null, exitDir: {x,z}|null }} | null
 */
export function clipPolylineToBounds(polyline, bounds) {
  if (!polyline || polyline.length < 2) return null;

  const { minX, minZ, maxX, maxZ } = bounds;
  const edges = [
    [{ x: minX, z: minZ }, { x: maxX, z: minZ }], // top
    [{ x: maxX, z: minZ }, { x: maxX, z: maxZ }], // right
    [{ x: maxX, z: maxZ }, { x: minX, z: maxZ }], // bottom
    [{ x: minX, z: maxZ }, { x: minX, z: minZ }], // left
  ];

  function isInside(p) {
    return p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ;
  }

  function segRectIntersect(a, b) {
    let bestT = Infinity;
    let bestPt = null;
    for (const [e1, e2] of edges) {
      const hit = _segSegIntersect(a, b, e1, e2);
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        bestPt = hit;
      }
    }
    return bestPt;
  }

  // Walk polyline, find first entry and last exit
  const clipped = [];
  let entryDir = null;
  let exitDir = null;
  let entered = false;

  for (let i = 0; i < polyline.length; i++) {
    const p = polyline[i];
    const inside = isInside(p);

    if (i > 0) {
      const prev = polyline[i - 1];
      const prevInside = isInside(prev);

      if (!prevInside && inside && !entered) {
        // Crossing into bounds — find entry point
        const hit = segRectIntersect(prev, p);
        if (hit) {
          const interpPt = _interpolatePoint(prev, p, hit.t);
          clipped.push(interpPt);
          const dx = p.x - prev.x, dz = p.z - prev.z;
          const len = Math.sqrt(dx * dx + dz * dz);
          entryDir = len > 0 ? { x: dx / len, z: dz / len } : null;
        }
        entered = true;
      }

      if (prevInside && !inside) {
        // Crossing out of bounds — find exit point
        const hit = segRectIntersect(prev, p);
        if (hit) {
          const interpPt = _interpolatePoint(prev, p, hit.t);
          clipped.push(interpPt);
          const dx = p.x - prev.x, dz = p.z - prev.z;
          const len = Math.sqrt(dx * dx + dz * dz);
          exitDir = len > 0 ? { x: dx / len, z: dz / len } : null;
        }
        break; // stop after first exit
      }
    }

    if (inside) {
      if (!entered) entered = true; // started inside
      clipped.push({ ...p });
    }
  }

  if (clipped.length < 2) return null;
  return { clipped, entryDir, exitDir };
}

/**
 * Segment-segment intersection returning t parameter on first segment.
 */
function _segSegIntersect(a1, a2, b1, b2) {
  const dx1 = a2.x - a1.x, dz1 = a2.z - a1.z;
  const dx2 = b2.x - b1.x, dz2 = b2.z - b1.z;
  const denom = dx1 * dz2 - dz1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;

  const dx3 = b1.x - a1.x, dz3 = b1.z - a1.z;
  const t = (dx3 * dz2 - dz3 * dx2) / denom;
  const u = (dx3 * dz1 - dz3 * dx1) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: a1.x + t * dx1,
      z: a1.z + t * dz1,
      t,
    };
  }
  return null;
}

/**
 * Interpolate all numeric properties between two points at parameter t.
 */
function _interpolatePoint(a, b, t) {
  const result = {};
  for (const key of Object.keys(a)) {
    if (typeof a[key] === 'number' && typeof b[key] === 'number') {
      result[key] = a[key] + t * (b[key] - a[key]);
    } else {
      result[key] = a[key];
    }
  }
  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/clipPolyline.test.js`
Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add src/core/clipPolyline.js test/core/clipPolyline.test.js
git commit -m "feat: clipPolylineToBounds utility for boundary interpolation"
```

---

### Task 2: Regional settlements as nuclei

**Files:**
- Modify: `src/city/setup.js:216-336` (placeNuclei function)
- Modify: `test/city/setup.test.js`

**Step 1: Write the failing tests**

Add to `test/city/setup.test.js`:

```js
describe('placeNuclei with regional settlements', () => {
  it('seeds nuclei at regional settlement positions', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length < 2) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    // Regional settlements (excluding the city's own) should appear as nuclei
    const otherSettlements = map.regionalSettlements.filter(s =>
      s.gx !== settlement.gx || s.gz !== settlement.gz
    );

    for (const rs of otherSettlements) {
      // Find a nucleus near this settlement's city coords
      const match = map.nuclei.find(n =>
        Math.abs(n.gx - rs.cityGx) < 15 && Math.abs(n.gz - rs.cityGz) < 15
      );
      expect(match).toBeDefined();
    }
  });

  it('regional settlement nuclei keep their regional tier', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length < 2) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    const otherSettlements = map.regionalSettlements.filter(s =>
      s.gx !== settlement.gx || s.gz !== settlement.gz
    );

    for (const rs of otherSettlements) {
      const match = map.nuclei.find(n =>
        Math.abs(n.gx - rs.cityGx) < 15 && Math.abs(n.gz - rs.cityGz) < 15
      );
      if (match) {
        expect(match.tier).toBe(rs.tier);
      }
    }
  });

  it('land-value nuclei have lower priority (higher tier number) than regional settlements', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length < 2) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    const regionalTiers = map.regionalSettlements.map(s => s.tier);
    const maxRegionalTier = Math.max(...regionalTiers, 1);

    // Non-regional nuclei (those not near a regional settlement) should have tier > maxRegionalTier
    const otherSettlements = map.regionalSettlements.filter(s =>
      s.gx !== settlement.gx || s.gz !== settlement.gz
    );
    const regionalNucleusPositions = new Set();
    for (const rs of otherSettlements) {
      const match = map.nuclei.find(n =>
        Math.abs(n.gx - rs.cityGx) < 15 && Math.abs(n.gz - rs.cityGz) < 15
      );
      if (match) regionalNucleusPositions.add(match.index);
    }
    // Also exclude the center nucleus (index 0)
    for (const n of map.nuclei) {
      if (n.index === 0) continue;
      if (regionalNucleusPositions.has(n.index)) continue;
      expect(n.tier).toBeGreaterThan(maxRegionalTier);
    }
  });

  it('regional settlement nuclei are not placed on water', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length < 2) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    for (const n of map.nuclei) {
      expect(map.waterMask.get(n.gx, n.gz)).toBe(0);
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/city/setup.test.js`
Expected: FAIL — regional settlements not seeded as nuclei

**Step 3: Modify placeNuclei to seed regional settlements**

In `src/city/setup.js`, modify `placeNuclei` — after the center nucleus block (line 253) and before the buildable cells scan (line 255), add:

```js
  // Seed nuclei at regional settlement positions
  const regionalCellSize = map.regionalLayers.getData('params').cellSize;
  const centerSettlement = map.settlement;
  let maxRegionalTier = 1; // center nucleus tier

  if (map.regionalSettlements) {
    for (const rs of map.regionalSettlements) {
      if (nuclei.length >= cap) break;

      // Skip the city's own settlement (already placed as center nucleus)
      if (rs.gx === centerSettlement.gx && rs.gz === centerSettlement.gz) continue;

      let gx = rs.cityGx;
      let gz = rs.cityGz;
      if (gx < 10 || gx >= map.width - 10 || gz < 10 || gz >= map.height - 10) continue;

      // Nudge off water/unbuildable to nearest viable cell
      if (map.buildability.get(gx, gz) < NUCLEUS_MIN_BUILDABILITY) {
        const searchR = 15;
        let bestDist = Infinity, bestGx = -1, bestGz = -1;
        for (let dz = -searchR; dz <= searchR; dz++) {
          for (let dx = -searchR; dx <= searchR; dx++) {
            const nx = gx + dx, nz = gz + dz;
            if (nx < 10 || nx >= map.width - 10 || nz < 10 || nz >= map.height - 10) continue;
            if (map.buildability.get(nx, nz) < NUCLEUS_MIN_BUILDABILITY) continue;
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; bestGx = nx; bestGz = nz; }
          }
        }
        if (bestGx < 0) continue; // no viable spot
        gx = bestGx;
        gz = bestGz;
      }

      // Check min spacing from existing nuclei
      let tooClose = false;
      for (const n of nuclei) {
        if (distance2D(gx, gz, n.gx, n.gz) < NUCLEUS_MIN_SPACING) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const rsTier = rs.tier || 3;
      if (rsTier > maxRegionalTier) maxRegionalTier = rsTier;

      nuclei.push({
        gx, gz,
        type: classifyNucleus(map, gx, gz),
        tier: rsTier,
        index: nuclei.length,
      });

      _addSuppression(suppression, map.width, map.height, gx, gz, NUCLEUS_SUPPRESSION_RADIUS);
    }
  }
```

Then in the greedy loop where land-value nuclei are placed (around current line 323), change the tier assignment from:

```js
const nucleusTier = nuclei.length < 3 ? 2 : (nuclei.length < 6 ? 3 : 4);
```

to:

```js
const nucleusTier = maxRegionalTier + 1 + Math.floor(nuclei.length / 4);
```

This ensures land-value nuclei always have a higher tier number (lower priority) than any regional settlement.

Note: the `suppression` array and `waterDist` array are created before this new code block. The `suppression` array already has the center nucleus's suppression applied. The new code must appear after those declarations. Looking at the current code, the `suppression` and `waterDist` are created around lines 271-283, so the regional settlement seeding block goes after line 284 (after the center nucleus suppression is applied).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/city/setup.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/city/setup.js test/city/setup.test.js
git commit -m "feat: seed nuclei at regional settlement positions with correct tier"
```

---

### Task 3: Anchor roads to boundary with correct angle

**Files:**
- Modify: `src/city/skeleton.js:131-195` (getAnchorConnections function)
- Create: `test/city/anchorRoads.test.js`

**Step 1: Write the failing tests**

```js
// test/city/anchorRoads.test.js
import { describe, it, expect } from 'vitest';
import { clipPolylineToBounds } from '../../src/core/clipPolyline.js';

// Test the boundary clipping logic as it applies to anchor road generation.
// These tests validate the approach getAnchorConnections will use.
describe('anchor road boundary clipping', () => {
  const bounds = {
    minX: 1000, minZ: 1000,
    maxX: 3000, maxZ: 3000,
  };

  it('finds entry and exit points on the boundary for a crossing road', () => {
    // Regional road crossing city from left to right
    const path = [
      { x: 500, z: 2000 },
      { x: 1500, z: 2000 },
      { x: 2500, z: 2000 },
      { x: 3500, z: 2000 },
    ];
    const result = clipPolylineToBounds(path, bounds);
    expect(result).not.toBeNull();
    expect(result.clipped[0].x).toBeCloseTo(1000);
    expect(result.clipped[result.clipped.length - 1].x).toBeCloseTo(3000);
  });

  it('entry direction matches the regional road approach angle', () => {
    // Road enters from bottom-left at ~45 degrees
    const path = [
      { x: 500, z: 500 },
      { x: 2000, z: 2000 },
      { x: 3500, z: 3500 },
    ];
    const result = clipPolylineToBounds(path, bounds);
    // Direction should be roughly (0.707, 0.707)
    expect(result.entryDir.x).toBeCloseTo(result.entryDir.z, 1);
    expect(result.entryDir.x).toBeGreaterThan(0);
  });

  it('preserves intermediate waypoints inside bounds', () => {
    const path = [
      { x: 500, z: 2000 },
      { x: 1500, z: 1800 },
      { x: 2000, z: 2200 },
      { x: 2500, z: 1900 },
      { x: 3500, z: 2000 },
    ];
    const result = clipPolylineToBounds(path, bounds);
    // Should have: boundary entry + 3 interior points + boundary exit = 5
    expect(result.clipped.length).toBe(5);
  });

  it('handles road starting inside (at settlement) with one exit', () => {
    const path = [
      { x: 2000, z: 2000 },
      { x: 2500, z: 2000 },
      { x: 3500, z: 2000 },
    ];
    const result = clipPolylineToBounds(path, bounds);
    expect(result.entryDir).toBeNull();
    expect(result.exitDir).toBeDefined();
    expect(result.clipped[0].x).toBeCloseTo(2000);
    expect(result.clipped[result.clipped.length - 1].x).toBeCloseTo(3000);
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run test/city/anchorRoads.test.js`
Expected: PASS (these test `clipPolylineToBounds` from Task 1, confirming it works for the anchor road use case)

**Step 3: Rewrite getAnchorConnections**

Replace `getAnchorConnections` in `src/city/skeleton.js:131-195` with:

```js
import { clipPolylineToBounds } from '../core/clipPolyline.js';

function getAnchorConnections(map, layers) {
  const roads = layers.getData('roads');
  if (!roads || roads.length === 0) return [];

  const params = layers.getData('params');
  const regionalCellSize = params.cellSize;

  const bounds = {
    minX: map.originX,
    minZ: map.originZ,
    maxX: map.originX + map.width * map.cellSize,
    maxZ: map.originZ + map.height * map.cellSize,
  };

  const hierRank = { arterial: 1, collector: 2, local: 3, track: 4 };

  // Convert regional roads to world-coord polylines and check relevance
  const relevantRoads = [];
  for (const road of roads) {
    const path = road.path || road.rawPath;
    if (!path || path.length < 2) continue;

    // Convert to world coords
    const worldPoly = path.map(p => ({
      x: p.gx * regionalCellSize,
      z: p.gz * regionalCellSize,
    }));

    const clipped = clipPolylineToBounds(worldPoly, bounds);
    if (!clipped || clipped.clipped.length < 2) continue;

    relevantRoads.push({
      clipped,
      hierarchy: road.hierarchy || 'local',
    });
  }

  // Sort by hierarchy (arterials first)
  relevantRoads.sort((a, b) => (hierRank[a.hierarchy] || 3) - (hierRank[b.hierarchy] || 3));

  const connections = [];
  for (const { clipped, hierarchy } of relevantRoads) {
    const pts = clipped.clipped;

    // Convert clipped world-coord points to city grid coords
    const gridPts = pts.map(p => ({
      gx: Math.round((p.x - map.originX) / map.cellSize),
      gz: Math.round((p.z - map.originZ) / map.cellSize),
    })).filter(p =>
      p.gx >= 0 && p.gx < map.width && p.gz >= 0 && p.gz < map.height
    );

    if (gridPts.length < 2) continue;

    const startPt = gridPts[0];
    const endPt = gridPts[gridPts.length - 1];
    if (distance2D(startPt.gx, startPt.gz, endPt.gx, endPt.gz) < 5) continue;

    // Break into chained connections through intermediate waypoints
    for (let i = 0; i < gridPts.length - 1; i++) {
      const from = gridPts[i];
      const to = gridPts[i + 1];
      if (distance2D(from.gx, from.gz, to.gx, to.gz) < 3) continue;
      connections.push({ from, to, hierarchy });
    }
  }

  return connections;
}
```

Add the import for `clipPolylineToBounds` at the top of `skeleton.js` (near line 1):

```js
import { clipPolylineToBounds } from '../core/clipPolyline.js';
```

**Step 4: Run existing skeleton tests**

Run: `npx vitest run test/city/skeleton.test.js`
Expected: PASS (existing tests should still pass)

**Step 5: Write integration test**

Add to `test/city/anchorRoads.test.js`:

```js
import { setupCity } from '../../src/city/setup.js';
import { buildSkeletonRoads } from '../../src/city/skeleton.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('anchor roads integration', () => {
  it('skeleton roads reach the city boundary', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({
      width: 128, height: 128, cellSize: 50, seaLevel: 0, coastEdge: null,
    }, rng);

    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length === 0) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));
    buildSkeletonRoads(map);

    // At least one road should have an endpoint within 2 cells of the boundary
    const margin = 2;
    let reachesBoundary = false;
    for (const road of map.roads) {
      const pts = road.polyline;
      if (!pts || pts.length < 2) continue;
      for (const p of [pts[0], pts[pts.length - 1]]) {
        const gx = Math.round((p.x - map.originX) / map.cellSize);
        const gz = Math.round((p.z - map.originZ) / map.cellSize);
        if (gx <= margin || gx >= map.width - margin ||
            gz <= margin || gz >= map.height - margin) {
          reachesBoundary = true;
        }
      }
    }
    expect(reachesBoundary).toBe(true);
  });
});
```

**Step 6: Run all tests**

Run: `npx vitest run test/city/anchorRoads.test.js test/city/skeleton.test.js`
Expected: PASS

**Step 7: Commit**

```bash
git add src/city/skeleton.js test/city/anchorRoads.test.js
git commit -m "feat: anchor roads reach city boundary with correct angle and waypoints"
```

---

### Task 4: River boundary clipping and systemId

**Files:**
- Modify: `src/core/inheritRivers.js`
- Modify: `test/core/inheritRivers.test.js` (create if doesn't exist)

**Step 1: Write the failing tests**

```js
// test/core/inheritRivers.test.js
import { describe, it, expect } from 'vitest';
import { inheritRivers } from '../../src/core/inheritRivers.js';

// Minimal river tree for testing
function makeRiverTree() {
  return [
    {
      points: [
        { x: 0, z: 500, accumulation: 100, width: 10 },
        { x: 200, z: 500, accumulation: 120, width: 12 },
        { x: 400, z: 500, accumulation: 140, width: 14 },
        { x: 600, z: 500, accumulation: 160, width: 16 },
        { x: 800, z: 500, accumulation: 180, width: 18 },
      ],
      children: [
        {
          points: [
            { x: 400, z: 300, accumulation: 50, width: 6 },
            { x: 400, z: 400, accumulation: 60, width: 7 },
            { x: 400, z: 500, accumulation: 70, width: 8 },
          ],
          children: [],
        },
      ],
    },
  ];
}

describe('inheritRivers', () => {
  const bounds = { minX: 100, minZ: 100, maxX: 700, maxZ: 700 };

  it('clips rivers to boundary with interpolated crossing points', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    expect(rivers.length).toBeGreaterThanOrEqual(1);

    // Main river should start near x=100 (boundary) not x=200 (first interior point)
    const main = rivers.find(r => r.polyline.length > 3);
    expect(main).toBeDefined();
    expect(main.polyline[0].x).toBeLessThanOrEqual(110); // near boundary, allowing smoothing margin
  });

  it('clips rivers at trailing boundary too', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    const main = rivers.find(r => r.polyline.length > 3);
    expect(main).toBeDefined();
    const last = main.polyline[main.polyline.length - 1];
    expect(last.x).toBeGreaterThanOrEqual(690); // near boundary
  });

  it('assigns systemId from tree root', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    // All rivers from the same root should share a systemId
    const ids = rivers.map(r => r.systemId);
    expect(ids.every(id => id === ids[0])).toBe(true);
  });

  it('different roots get different systemIds', () => {
    const tree = [
      ...makeRiverTree(),
      {
        points: [
          { x: 100, z: 200, accumulation: 80, width: 8 },
          { x: 300, z: 200, accumulation: 90, width: 9 },
          { x: 500, z: 200, accumulation: 100, width: 10 },
        ],
        children: [],
      },
    ];
    const rivers = inheritRivers(tree, bounds);
    const ids = new Set(rivers.map(r => r.systemId));
    expect(ids.size).toBe(2);
  });

  it('interpolates accumulation at boundary crossing', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    const main = rivers.find(r => r.polyline.length > 3);
    // First point should have interpolated accumulation between 100 and 120
    expect(main.polyline[0].accumulation).toBeGreaterThanOrEqual(100);
    expect(main.polyline[0].accumulation).toBeLessThanOrEqual(120);
  });

  it('handles tributary whose confluence is just outside bounds', () => {
    const narrowBounds = { minX: 100, minZ: 350, maxX: 700, maxZ: 700 };
    // Tributary starts at z=300 (outside) and reaches z=500 (inside)
    // Confluence at z=500 is inside, but tributary origin at z=300 is outside
    const rivers = inheritRivers(makeRiverTree(), narrowBounds);
    // Should still get the tributary with a clipped entry point
    const trib = rivers.find(r =>
      r.polyline.some(p => Math.abs(p.x - 400) < 50 && p.z < 450)
    );
    expect(trib).toBeDefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/inheritRivers.test.js`
Expected: FAIL — no systemId, no boundary interpolation

**Step 3: Rewrite inheritRivers**

Replace the contents of `src/core/inheritRivers.js`:

```js
/**
 * Shared river inheritance: clip river paths from a parent map to child bounds,
 * interpolating exact boundary crossing points.
 *
 * Used by city setup to import regional rivers.
 */

import { chaikinSmooth, riverHalfWidth } from './riverGeometry.js';
import { clipPolylineToBounds } from './clipPolyline.js';

/**
 * Extract river polylines from a river segment tree, clipped to a bounding box.
 *
 * @param {Array} riverPaths - River segment tree (each has .points, .children)
 * @param {object} bounds - { minX, minZ, maxX, maxZ } in world coordinates
 * @param {object} [options]
 * @param {number} [options.chaikinPasses=1] - Extra Chaikin smoothing iterations
 * @param {number} [options.margin=0] - Extra margin around bounds for clipping
 * @returns {Array<{ polyline: Array<{x, z, accumulation, width}>, systemId: number }>}
 */
export function inheritRivers(riverPaths, bounds, options = {}) {
  const { chaikinPasses = 1, margin = 0 } = options;
  const expandedBounds = {
    minX: bounds.minX - margin,
    minZ: bounds.minZ - margin,
    maxX: bounds.maxX + margin,
    maxZ: bounds.maxZ + margin,
  };

  const result = [];
  for (let rootIdx = 0; rootIdx < riverPaths.length; rootIdx++) {
    _walkTree(riverPaths[rootIdx], expandedBounds, chaikinPasses, rootIdx, result);
  }
  return result;
}

function _walkTree(seg, bounds, chaikinPasses, systemId, result) {
  if (seg.points && seg.points.length >= 2) {
    const clipped = clipPolylineToBounds(seg.points, bounds);

    if (clipped && clipped.clipped.length >= 2) {
      const smoothed = chaikinSmooth(
        clipped.clipped.map(p => ({ x: p.x, z: p.z, accumulation: p.accumulation })),
        chaikinPasses,
      );

      result.push({
        polyline: smoothed.map(p => ({
          x: p.x,
          z: p.z,
          accumulation: p.accumulation,
          width: riverHalfWidth(p.accumulation) * 2,
        })),
        systemId,
      });
    }
  }

  if (seg.children) {
    for (const child of seg.children) {
      _walkTree(child, bounds, chaikinPasses, systemId, result);
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/inheritRivers.test.js`
Expected: PASS

**Step 5: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS (no regressions — the return format adds `systemId` but existing consumers only read `.polyline`)

**Step 6: Commit**

```bash
git add src/core/inheritRivers.js test/core/inheritRivers.test.js
git commit -m "feat: rivers clip to boundary with interpolation and carry systemId"
```

---

### Task 5: Wire systemId through to FeatureMap

**Files:**
- Modify: `src/city/setup.js:142-144` (where rivers are added as features)

**Step 1: Verify current wiring**

The current code in setup.js:142 is:
```js
for (const river of cityRivers) {
  map.addFeature('river', { polyline: river.polyline });
}
```

Change to pass `systemId` through:

```js
for (const river of cityRivers) {
  map.addFeature('river', { polyline: river.polyline, systemId: river.systemId });
}
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS (addFeature stores all properties, downstream code reads `.polyline` and ignores unknown properties)

**Step 3: Commit**

```bash
git add src/city/setup.js
git commit -m "feat: pass river systemId through to FeatureMap"
```

---

### Verification

After all tasks:

1. `npx vitest run` — all tests pass, no regressions
2. Load the debug viewer — regional settlements should appear as nuclei, roads should reach boundaries, rivers should flow smoothly across boundaries
3. Load the 3D city view — roads should connect to the map edges, rivers should not start/end abruptly mid-terrain
