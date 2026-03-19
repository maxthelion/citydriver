# Road Network Abstraction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered road mutation (3 independent data structures) with a single `RoadNetwork` class that keeps `roads`, `graph`, and `roadGrid` in sync.

**Architecture:** Two new classes — `Road` (immutable polyline + parametric bridges) and `RoadNetwork` (owns all representations, single mutation API). `FeatureMap` delegates to `RoadNetwork` with backward-compat getters so existing callers work unchanged. Callers that bypass `addFeature` (direct `roadGrid.set`, manual `addRoadToGraph`) are updated incrementally.

**Tech Stack:** Vitest, ES modules, no external dependencies.

**Spec:** `specs/v5/road-network-abstraction.md`

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/core/Road.js` | `Road` class — immutable polyline, parametric bridges, serialization |
| `src/core/RoadNetwork.js` | `RoadNetwork` class — owns roads Map, PlanarGraph, roadGrid, bridgeGrid, cellRefCounts |
| `test/core/Road.test.js` | Unit tests for Road |
| `test/core/RoadNetwork.test.js` | Unit tests for RoadNetwork |

### Modified files
| File | Change |
|---|---|
| `src/core/FeatureMap.js` | Replace `roads[]`, `graph`, `roadGrid`, `bridgeGrid` with `roadNetwork`; add backward-compat getters; update `addFeature('road')`, `_stampRoad`, `clone()` |
| `src/city/skeleton.js` | Update `compactRoads` → `network.remove()` with ref-counted unstamping; `rebuildGraphFromRoads` becomes thin wrapper; `addRoadToGraph` delegates to network |
| `src/city/bridges.js` | Replace `_spliceBridge` polyline mutation with `road.addBridge()` parametric data; update `placeBridges` to use `network.addBridge()` |
| `src/city/pipeline/growRoads.js` | Replace direct `roadGrid.set()` with returning cell arrays; caller uses `network.addFromCells()` |
| `src/city/pipeline/connectIslandZones.js` | Use `addFeature` instead of manual graph manipulation; delete dead `findNearestRoad` |
| `src/city/pipeline/layoutRibbons.js` | Remove manual graph edge addition (FeatureMap handles it now) |
| `src/city/strategies/desireLines.js` | Remove manual `addRoadToGraph` + `roadGrid.set` (FeatureMap handles it now) |
| `src/city/skeletonStrategies.js` | Remove manual `addRoadToGraph` calls |
| `test/core/FeatureMap.test.js` | Add tests for backward-compat getters, verify road add/remove sync |
| `test/city/compactRoads.test.js` | Update to test through `RoadNetwork.remove()` |
| `test/city/bridges.test.js` | Update to test parametric bridges instead of polyline splice |

---

## Task 1: Road class

**Files:**
- Create: `src/core/Road.js`
- Create: `test/core/Road.test.js`

- [ ] **Step 1: Write failing tests for Road construction and properties**

```js
// test/core/Road.test.js
import { describe, it, expect } from 'vitest';
import { Road } from '../../src/core/Road.js';

describe('Road', () => {
  it('assigns auto-incrementing id', () => {
    const r1 = new Road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    const r2 = new Road([{ x: 0, z: 0 }, { x: 50, z: 50 }]);
    expect(r2.id).toBe(r1.id + 1);
  });

  it('stores polyline as defensive copy', () => {
    const pts = [{ x: 0, z: 0 }, { x: 100, z: 0 }];
    const road = new Road(pts);
    pts[0].x = 999;
    expect(road.polyline[0].x).toBe(0);
  });

  it('exposes start and end', () => {
    const road = new Road([{ x: 10, z: 20 }, { x: 30, z: 40 }, { x: 50, z: 60 }]);
    expect(road.start).toEqual({ x: 10, z: 20 });
    expect(road.end).toEqual({ x: 50, z: 60 });
  });

  it('stores width, hierarchy, importance, source from options', () => {
    const road = new Road([{ x: 0, z: 0 }, { x: 1, z: 1 }], {
      width: 12, hierarchy: 'arterial', importance: 0.9, source: 'skeleton',
    });
    expect(road.width).toBe(12);
    expect(road.hierarchy).toBe('arterial');
    expect(road.importance).toBe(0.9);
    expect(road.source).toBe('skeleton');
  });

  it('defaults width=6, hierarchy=local, importance=0.45', () => {
    const road = new Road([{ x: 0, z: 0 }, { x: 1, z: 1 }]);
    expect(road.width).toBe(6);
    expect(road.hierarchy).toBe('local');
    expect(road.importance).toBe(0.45);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/Road.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Road class (construction, properties)**

```js
// src/core/Road.js
let nextId = 0;

/** Reset ID counter (for tests only). */
export function _resetRoadIds() { nextId = 0; }

export class Road {
  #id;
  #polyline;
  #bridges;

  constructor(polyline, { width = 6, hierarchy = 'local', importance = 0.45, source } = {}) {
    this.#id = nextId++;
    this.#polyline = polyline.map(p => ({ x: p.x, z: p.z }));
    this.#bridges = [];
    this.width = width;
    this.hierarchy = hierarchy;
    this.importance = importance;
    this.source = source;
  }

  get id() { return this.#id; }
  get polyline() { return this.#polyline; }
  get start() { return this.#polyline[0]; }
  get end() { return this.#polyline[this.#polyline.length - 1]; }
  get bridges() { return [...this.#bridges]; }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/Road.test.js`
Expected: PASS

- [ ] **Step 5: Write failing tests for bridges**

Add to `test/core/Road.test.js`:

```js
describe('bridges', () => {
  it('starts with no bridges', () => {
    const road = new Road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    expect(road.bridges).toEqual([]);
  });

  it('addBridge stores parametric bridge data', () => {
    const road = new Road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    road.addBridge({ x: 40, z: -5 }, { x: 40, z: 5 }, 0.35, 0.65);
    expect(road.bridges.length).toBe(1);
    expect(road.bridges[0]).toEqual({
      bankA: { x: 40, z: -5 }, bankB: { x: 40, z: 5 },
      entryT: 0.35, exitT: 0.65,
    });
  });

  it('bridges getter returns snapshot (not live reference)', () => {
    const road = new Road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    road.addBridge({ x: 40, z: -5 }, { x: 40, z: 5 }, 0.35, 0.65);
    const snap = road.bridges;
    road.addBridge({ x: 80, z: -5 }, { x: 80, z: 5 }, 0.75, 0.85);
    expect(snap.length).toBe(1);
    expect(road.bridges.length).toBe(2);
  });

  it('resolvedPolyline returns base polyline when no bridges', () => {
    const road = new Road([{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }]);
    expect(road.resolvedPolyline()).toEqual(road.polyline);
  });

  it('resolvedPolyline splices bridge banks into polyline', () => {
    // Straight road from (0,0) to (100,0), bridge from t=0.4 to t=0.6
    const road = new Road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    road.addBridge({ x: 40, z: -5 }, { x: 60, z: 5 }, 0.4, 0.6);
    const resolved = road.resolvedPolyline();
    // Should contain bank points
    expect(resolved.length).toBeGreaterThan(2);
    const hasBankA = resolved.some(p => p.x === 40 && p.z === -5);
    const hasBankB = resolved.some(p => p.x === 60 && p.z === 5);
    expect(hasBankA).toBe(true);
    expect(hasBankB).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run test/core/Road.test.js`
Expected: FAIL — addBridge/resolvedPolyline not defined

- [ ] **Step 7: Implement addBridge and resolvedPolyline**

Add to `Road` class in `src/core/Road.js`:

```js
addBridge(bankA, bankB, entryT, exitT) {
  this.#bridges.push({
    bankA: { x: bankA.x, z: bankA.z },
    bankB: { x: bankB.x, z: bankB.z },
    entryT,
    exitT,
  });
}

resolvedPolyline() {
  if (this.#bridges.length === 0) return this.#polyline;
  return _resolvePolylineWithBridges(this.#polyline, this.#bridges);
}
```

Add module-level helper:

```js
function _resolvePolylineWithBridges(polyline, bridges) {
  // Compute cumulative arc lengths
  const arcLengths = [0];
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].x - polyline[i - 1].x;
    const dz = polyline[i].z - polyline[i - 1].z;
    arcLengths.push(arcLengths[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const totalLen = arcLengths[arcLengths.length - 1];
  if (totalLen < 0.001) return polyline;

  // Sort bridges by entryT
  const sorted = [...bridges].sort((a, b) => a.entryT - b.entryT);

  // Interpolate a point at parametric position t (0..1 along arc length)
  function pointAtT(t) {
    const targetLen = t * totalLen;
    for (let i = 1; i < arcLengths.length; i++) {
      if (arcLengths[i] >= targetLen) {
        const segLen = arcLengths[i] - arcLengths[i - 1];
        const frac = segLen > 0 ? (targetLen - arcLengths[i - 1]) / segLen : 0;
        return {
          x: polyline[i - 1].x + (polyline[i].x - polyline[i - 1].x) * frac,
          z: polyline[i - 1].z + (polyline[i].z - polyline[i - 1].z) * frac,
        };
      }
    }
    return { ...polyline[polyline.length - 1] };
  }

  // Collect segment-index for a given t
  function segmentIndexAtT(t) {
    const targetLen = t * totalLen;
    for (let i = 1; i < arcLengths.length; i++) {
      if (arcLengths[i] >= targetLen) return i - 1;
    }
    return arcLengths.length - 2;
  }

  // Build result: base points before first bridge, then bridge banks, then between, etc.
  const result = [];
  let lastSegEnd = 0; // index into polyline — up to but not including this segment's end vertex

  for (const bridge of sorted) {
    // Add base polyline points before the entry point
    const entrySegIdx = segmentIndexAtT(bridge.entryT);
    for (let i = lastSegEnd; i <= entrySegIdx; i++) {
      result.push(polyline[i]);
    }
    // Add interpolated entry point (if not already at a vertex)
    result.push(pointAtT(bridge.entryT));
    // Add bridge banks
    result.push({ x: bridge.bankA.x, z: bridge.bankA.z });
    result.push({ x: bridge.bankB.x, z: bridge.bankB.z });
    // Add interpolated exit point
    result.push(pointAtT(bridge.exitT));

    const exitSegIdx = segmentIndexAtT(bridge.exitT);
    lastSegEnd = exitSegIdx + 1;
  }

  // Add remaining base polyline points after last bridge
  for (let i = lastSegEnd; i < polyline.length; i++) {
    result.push(polyline[i]);
  }

  return result;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/core/Road.test.js`
Expected: PASS

- [ ] **Step 9: Write failing tests for serialization**

Add to `test/core/Road.test.js`:

```js
describe('serialization', () => {
  it('toJSON round-trips through fromJSON', () => {
    const road = new Road(
      [{ x: 0, z: 0 }, { x: 50, z: 25 }, { x: 100, z: 0 }],
      { width: 12, hierarchy: 'arterial', importance: 0.9, source: 'skeleton' },
    );
    road.addBridge({ x: 40, z: -5 }, { x: 60, z: 5 }, 0.35, 0.65);

    const json = road.toJSON();
    const restored = Road.fromJSON(json);

    expect(restored.polyline).toEqual(road.polyline);
    expect(restored.width).toBe(12);
    expect(restored.hierarchy).toBe('arterial');
    expect(restored.importance).toBe(0.9);
    expect(restored.source).toBe('skeleton');
    expect(restored.bridges.length).toBe(1);
    expect(restored.bridges[0].entryT).toBe(0.35);
  });
});
```

- [ ] **Step 10: Implement toJSON and fromJSON**

Add to `Road` class:

```js
toJSON() {
  return {
    id: this.#id,
    polyline: this.#polyline,
    bridges: this.#bridges,
    width: this.width,
    hierarchy: this.hierarchy,
    importance: this.importance,
    source: this.source,
  };
}

static fromJSON(data) {
  const road = new Road(data.polyline, {
    width: data.width,
    hierarchy: data.hierarchy,
    importance: data.importance,
    source: data.source,
  });
  for (const b of (data.bridges || [])) {
    road.addBridge(b.bankA, b.bankB, b.entryT, b.exitT);
  }
  return road;
}
```

- [ ] **Step 11: Run all Road tests**

Run: `npx vitest run test/core/Road.test.js`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/core/Road.js test/core/Road.test.js
git commit -m "feat: add Road class with immutable polyline and parametric bridges"
```

---

## Task 2: RoadNetwork class

**Files:**
- Create: `src/core/RoadNetwork.js`
- Create: `test/core/RoadNetwork.test.js`

- [ ] **Step 1: Write failing tests for add() and read-only accessors**

```js
// test/core/RoadNetwork.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { RoadNetwork } from '../../src/core/RoadNetwork.js';
import { _resetRoadIds } from '../../src/core/Road.js';

// Small 20x20 grid, 10m cells
function makeNetwork() {
  return new RoadNetwork(20, 20, 10);
}

describe('RoadNetwork', () => {
  beforeEach(() => _resetRoadIds());

  describe('add', () => {
    it('returns a Road with an id', () => {
      const net = makeNetwork();
      const road = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
      expect(road.id).toBeDefined();
      expect(net.roadCount).toBe(1);
    });

    it('stamps roadGrid cells along the polyline', () => {
      const net = makeNetwork();
      net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }], { width: 6 });
      // Cell at (5, 0) should be stamped (50m along x-axis)
      expect(net.roadGrid.get(5, 0)).toBe(1);
    });

    it('adds edge to graph', () => {
      const net = makeNetwork();
      net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
      expect(net.graph.edges.size).toBe(1);
      expect(net.graph.nodes.size).toBe(2);
    });

    it('snaps graph nodes within cellSize * 3', () => {
      const net = makeNetwork();
      net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
      // Second road starts 20m from first road's end (within 30m snap)
      net.add([{ x: 105, z: 5 }, { x: 190, z: 0 }]);
      // Start node of second road should snap to end node of first
      expect(net.graph.nodes.size).toBe(3); // 3 distinct nodes, not 4
    });
  });

  describe('roads accessor', () => {
    it('returns all roads', () => {
      const net = makeNetwork();
      net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
      net.add([{ x: 0, z: 50 }, { x: 100, z: 50 }]);
      expect(net.roads.length).toBe(2);
    });
  });

  describe('getRoad', () => {
    it('retrieves road by id', () => {
      const net = makeNetwork();
      const road = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
      expect(net.getRoad(road.id)).toBe(road);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/RoadNetwork.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement RoadNetwork with add() and accessors**

```js
// src/core/RoadNetwork.js
import { Road } from './Road.js';
import { PlanarGraph } from './PlanarGraph.js';
import { Grid2D } from './Grid2D.js';

export class RoadNetwork {
  #roads;
  #graph;
  #roadGrid;
  #bridgeGrid;
  #cellRefCounts;
  #width; #height; #cellSize; #originX; #originZ;

  constructor(width, height, cellSize, originX = 0, originZ = 0) {
    this.#roads = new Map();
    this.#graph = new PlanarGraph();
    this.#roadGrid = new Grid2D(width, height, { type: 'uint8', cellSize, originX, originZ });
    this.#bridgeGrid = new Grid2D(width, height, { type: 'uint8', cellSize, originX, originZ });
    this.#cellRefCounts = new Grid2D(width, height, { type: 'uint16', cellSize, originX, originZ });
    this.#width = width;
    this.#height = height;
    this.#cellSize = cellSize;
    this.#originX = originX;
    this.#originZ = originZ;
  }

  // ---- Public API ----

  add(polyline, attrs = {}) {
    const road = new Road(polyline, attrs);
    this.#roads.set(road.id, road);
    this.#stampRoad(road);
    this.#addToGraph(road);
    return road;
  }

  // ---- Read-only accessors ----

  get roads() { return [...this.#roads.values()]; }
  get roadCount() { return this.#roads.size; }
  get graph() { return this.#graph; }
  get roadGrid() { return this.#roadGrid; }
  get bridgeGrid() { return this.#bridgeGrid; }

  getRoad(id) { return this.#roads.get(id); }

  // ---- Private stamping ----

  #stampRoad(road) {
    const polyline = road.polyline;
    if (!polyline || polyline.length < 2) return;

    const halfWidth = (road.width || 6) / 2;
    const cs = this.#cellSize;
    const ox = this.#originX;
    const oz = this.#originZ;
    const w = this.#width;
    const h = this.#height;
    const stepSize = cs * 0.5;

    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x, az = polyline[i].z;
      const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
      const dx = bx - ax, dz = bz - az;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      const steps = Math.ceil(segLen / stepSize);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t;
        const pz = az + dz * t;

        const effectiveRadius = Math.max(halfWidth, cs * 0.75);
        const cellRadius = Math.ceil(effectiveRadius / cs);
        const cgx = Math.round((px - ox) / cs);
        const cgz = Math.round((pz - oz) / cs);

        for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
          for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
            const gx = cgx + ddx, gz = cgz + ddz;
            if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
            const cellX = ox + gx * cs;
            const cellZ = oz + gz * cs;
            const distSq = (cellX - px) ** 2 + (cellZ - pz) ** 2;
            if (distSq <= effectiveRadius * effectiveRadius) {
              this.#roadGrid.set(gx, gz, 1);
              const prev = this.#cellRefCounts.get(gx, gz);
              this.#cellRefCounts.set(gx, gz, prev + 1);
            }
          }
        }
      }
    }
  }

  #addToGraph(road) {
    const polyline = road.polyline;
    if (polyline.length < 2) return;

    const snapDist = this.#cellSize * 3;
    const startPt = polyline[0];
    const endPt = polyline[polyline.length - 1];

    const startNodeId = this.#findOrCreateNode(startPt.x, startPt.z, snapDist);
    const endNodeId = this.#findOrCreateNode(endPt.x, endPt.z, snapDist);

    if (startNodeId === endNodeId) return;
    if (this.#graph.neighbors(startNodeId).includes(endNodeId)) {
      console.warn(`[RoadNetwork] Alternate route dropped between nodes ${startNodeId}–${endNodeId}`);
      return;
    }

    const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
    this.#graph.addEdge(startNodeId, endNodeId, {
      points, width: road.width, hierarchy: road.hierarchy,
    });
  }

  #findOrCreateNode(x, z, snapDist) {
    const nearest = this.#graph.nearestNode(x, z);
    if (nearest && nearest.dist < snapDist) return nearest.id;
    return this.#graph.addNode(x, z);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/RoadNetwork.test.js`
Expected: PASS

- [ ] **Step 5: Write failing tests for remove()**

Add to `test/core/RoadNetwork.test.js`:

```js
describe('remove', () => {
  it('removes road from collection', () => {
    const net = makeNetwork();
    const road = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    expect(net.roadCount).toBe(1);
    net.remove(road.id);
    expect(net.roadCount).toBe(0);
    expect(net.getRoad(road.id)).toBeUndefined();
  });

  it('clears roadGrid cells when ref count reaches zero', () => {
    const net = makeNetwork();
    const road = net.add([{ x: 50, z: 50 }, { x: 150, z: 50 }], { width: 6 });
    // Cell (5, 5) should be stamped (center of road)
    expect(net.roadGrid.get(5, 5)).toBe(1);
    net.remove(road.id);
    expect(net.roadGrid.get(5, 5)).toBe(0);
  });

  it('preserves roadGrid cells shared with another road', () => {
    const net = makeNetwork();
    const r1 = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }], { width: 6 });
    // Second road overlaps at the start
    net.add([{ x: 0, z: 0 }, { x: 0, z: 100 }], { width: 6 });
    // Cell near (0,0) should have ref count 2
    net.remove(r1.id);
    // Cell near origin should still be stamped (second road)
    expect(net.roadGrid.get(0, 0)).toBe(1);
  });

  it('removes graph edge', () => {
    const net = makeNetwork();
    const road = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    expect(net.graph.edges.size).toBe(1);
    net.remove(road.id);
    expect(net.graph.edges.size).toBe(0);
  });

  it('is a no-op for unknown id', () => {
    const net = makeNetwork();
    net.remove(999);
    expect(net.roadCount).toBe(0);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run test/core/RoadNetwork.test.js`
Expected: FAIL — remove not defined

- [ ] **Step 7: Implement remove() with ref-counted unstamping**

Add to `RoadNetwork`:

```js
remove(id) {
  const road = this.#roads.get(id);
  if (!road) return;
  this.#unstampRoad(road);
  this.#removeFromGraph(road);
  this.#roads.delete(id);
}

#unstampRoad(road) {
  const polyline = road.polyline;
  if (!polyline || polyline.length < 2) return;

  const halfWidth = (road.width || 6) / 2;
  const cs = this.#cellSize;
  const ox = this.#originX;
  const oz = this.#originZ;
  const w = this.#width;
  const h = this.#height;
  const stepSize = cs * 0.5;

  for (let i = 0; i < polyline.length - 1; i++) {
    const ax = polyline[i].x, az = polyline[i].z;
    const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 0.01) continue;

    const steps = Math.ceil(segLen / stepSize);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = ax + dx * t;
      const pz = az + dz * t;

      const effectiveRadius = Math.max(halfWidth, cs * 0.75);
      const cellRadius = Math.ceil(effectiveRadius / cs);
      const cgx = Math.round((px - ox) / cs);
      const cgz = Math.round((pz - oz) / cs);

      for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
        for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
          const gx = cgx + ddx, gz = cgz + ddz;
          if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
          const cellX = ox + gx * cs;
          const cellZ = oz + gz * cs;
          const distSq = (cellX - px) ** 2 + (cellZ - pz) ** 2;
          if (distSq <= effectiveRadius * effectiveRadius) {
            const prev = this.#cellRefCounts.get(gx, gz);
            if (prev > 0) {
              this.#cellRefCounts.set(gx, gz, prev - 1);
              if (prev === 1) {
                this.#roadGrid.set(gx, gz, 0);
              }
            }
          }
        }
      }
    }
  }
}

#removeFromGraph(road) {
  const polyline = road.polyline;
  if (polyline.length < 2) return;

  const snapDist = this.#cellSize * 3;
  const startPt = polyline[0];
  const endPt = polyline[polyline.length - 1];

  // Find the nodes this road connects
  const startNode = this.#graph.nearestNode(startPt.x, startPt.z);
  const endNode = this.#graph.nearestNode(endPt.x, endPt.z);
  if (!startNode || startNode.dist > snapDist) return;
  if (!endNode || endNode.dist > snapDist) return;

  // Find and remove the edge between them
  const adj = this.#graph.neighbors(startNode.id);
  if (!adj.includes(endNode.id)) return;

  // Find edge ID between these nodes
  for (const [edgeId, edge] of this.#graph.edges) {
    if ((edge.from === startNode.id && edge.to === endNode.id) ||
        (edge.from === endNode.id && edge.to === startNode.id)) {
      this.#graph.removeEdge(edgeId);
      break;
    }
  }

  // Clean up degree-0 nodes
  if (this.#graph.degree(startNode.id) === 0) {
    this.#graph.removeNode(startNode.id);
  }
  if (this.#graph.degree(endNode.id) === 0) {
    this.#graph.removeNode(endNode.id);
  }
}
```

**Note:** `PlanarGraph` needs `removeEdge(id)` and `removeNode(id)` methods. If they don't exist, add them in this step:

In `src/core/PlanarGraph.js`, add:

```js
removeEdge(id) {
  const edge = this.edges.get(id);
  if (!edge) return;
  this.edges.delete(id);
  // Remove from adjacency
  const fromAdj = this._adjacency.get(edge.from);
  if (fromAdj) {
    const idx = fromAdj.findIndex(e => e.edgeId === id);
    if (idx >= 0) fromAdj.splice(idx, 1);
  }
  const toAdj = this._adjacency.get(edge.to);
  if (toAdj) {
    const idx = toAdj.findIndex(e => e.edgeId === id);
    if (idx >= 0) toAdj.splice(idx, 1);
  }
}

removeNode(id) {
  this.nodes.delete(id);
  this._adjacency.delete(id);
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/core/RoadNetwork.test.js`
Expected: PASS

- [ ] **Step 9: Write failing tests for addFromCells()**

Add to `test/core/RoadNetwork.test.js`:

```js
describe('addFromCells', () => {
  it('converts grid cells to world polyline and adds road', () => {
    const net = makeNetwork();
    const cells = [{ gx: 2, gz: 3 }, { gx: 4, gz: 3 }, { gx: 6, gz: 3 }];
    const road = net.addFromCells(cells);
    expect(road).not.toBeNull();
    expect(road.polyline[0]).toEqual({ x: 20, z: 30 });
    expect(road.polyline[2]).toEqual({ x: 60, z: 30 });
    expect(net.roadCount).toBe(1);
  });

  it('returns null for fewer than 2 cells', () => {
    const net = makeNetwork();
    expect(net.addFromCells([{ gx: 1, gz: 1 }])).toBeNull();
    expect(net.addFromCells([])).toBeNull();
  });

  it('stamps roadGrid and adds graph edge', () => {
    const net = makeNetwork();
    net.addFromCells([{ gx: 2, gz: 5 }, { gx: 8, gz: 5 }]);
    expect(net.roadGrid.get(5, 5)).toBe(1);
    expect(net.graph.edges.size).toBe(1);
  });
});
```

- [ ] **Step 10: Implement addFromCells()**

Add to `RoadNetwork`:

```js
addFromCells(cells, attrs = {}) {
  if (cells.length < 2) return null;
  const polyline = cells.map(c => ({
    x: this.#originX + c.gx * this.#cellSize,
    z: this.#originZ + c.gz * this.#cellSize,
  }));
  return this.add(polyline, attrs);
}
```

- [ ] **Step 11: Write failing tests for addBridge()**

```js
describe('addBridge', () => {
  it('records bridge on road and stamps bridgeGrid', () => {
    const net = new RoadNetwork(20, 20, 10);
    // Set up a "water" area — bridgeGrid stamping checks waterMask
    const road = net.add([{ x: 0, z: 0 }, { x: 190, z: 0 }]);
    net.addBridge(road.id, { x: 80, z: -10 }, { x: 80, z: 10 }, 0.4, 0.6);
    expect(road.bridges.length).toBe(1);
  });

  it('is a no-op for unknown roadId', () => {
    const net = makeNetwork();
    net.addBridge(999, { x: 0, z: 0 }, { x: 1, z: 1 }, 0, 1);
    // Should not throw
  });
});
```

- [ ] **Step 12: Implement addBridge()**

Add to `RoadNetwork`:

```js
addBridge(roadId, bankA, bankB, entryT, exitT) {
  const road = this.#roads.get(roadId);
  if (!road) return;
  road.addBridge(bankA, bankB, entryT, exitT);
  this.#stampBridge(bankA, bankB);
}

#stampBridge(bankA, bankB) {
  const cs = this.#cellSize;
  const ox = this.#originX;
  const oz = this.#originZ;
  const dx = bankB.x - bankA.x, dz = bankB.z - bankA.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) return;

  const steps = Math.ceil(len / cs);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const wx = bankA.x + dx * t;
    const wz = bankA.z + dz * t;
    const gx = Math.round((wx - ox) / cs);
    const gz = Math.round((wz - oz) / cs);
    if (gx < 0 || gx >= this.#width || gz < 0 || gz >= this.#height) continue;
    this.#bridgeGrid.set(gx, gz, 1);
  }
}
```

- [ ] **Step 13: Run all RoadNetwork tests**

Run: `npx vitest run test/core/RoadNetwork.test.js`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add src/core/RoadNetwork.js test/core/RoadNetwork.test.js src/core/PlanarGraph.js
git commit -m "feat: add RoadNetwork class — single mutation point for roads, graph, and grid"
```

---

## Task 3: Wire FeatureMap to RoadNetwork

**Files:**
- Modify: `src/core/FeatureMap.js`
- Modify: `test/core/FeatureMap.test.js`

This is the critical integration step. After this, all existing `map.addFeature('road', ...)` callers automatically go through `RoadNetwork.add()` without code changes.

- [ ] **Step 1: Write failing test for backward-compat accessors**

Add to `test/core/FeatureMap.test.js`:

```js
it('exposes roadNetwork and backward-compat accessors', () => {
  const map = makeMap();
  expect(map.roadNetwork).toBeDefined();
  // roads, graph, roadGrid, bridgeGrid should be accessible
  expect(map.roads).toBeDefined();
  expect(map.graph).toBeDefined();
  expect(map.roadGrid).toBeDefined();
  expect(map.bridgeGrid).toBeDefined();
});

it('addFeature road goes through roadNetwork', () => {
  const map = makeMap();
  map.addFeature('road', {
    polyline: [{ x: 100, z: 250 }, { x: 400, z: 250 }],
    width: 10,
    hierarchy: 'collector',
  });
  expect(map.roadNetwork.roadCount).toBe(1);
  expect(map.roads.length).toBe(1);
  expect(map.graph.edges.size).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/FeatureMap.test.js`
Expected: FAIL — roadNetwork not defined

- [ ] **Step 3: Modify FeatureMap constructor**

In `src/core/FeatureMap.js`:

1. Add import: `import { RoadNetwork } from './RoadNetwork.js';`
2. In constructor, replace the separate road structures:

```js
// REMOVE these lines:
// this.roads = [];
// this.graph = new PlanarGraph();
// this.roadGrid = new Grid2D(width, height, { ...gridOpts, type: 'uint8' });
// this.bridgeGrid = new Grid2D(width, height, { ...gridOpts, type: 'uint8' });

// ADD:
this.roadNetwork = new RoadNetwork(width, height, cellSize, originX, originZ);
```

3. Add backward-compat getters:

```js
get roads() { return this.roadNetwork.roads; }
set roads(val) { this._legacyRoads = val; } // used by compactRoads during migration
get graph() { return this.roadNetwork.graph; }
set graph(val) { /* allow legacy rebuildGraphFromRoads to set */ this._legacyGraph = val; }
get roadGrid() { return this.roadNetwork.roadGrid; }
get bridgeGrid() { return this.roadNetwork.bridgeGrid; }
```

**Note:** The `roads` getter needs careful handling. Many callers do `map.roads.filter(...)`, `map.roads.length`, `map.roads.find(...)`, etc. The RoadNetwork returns `Road` objects, but callers expect plain objects with `polyline`, `width`, `hierarchy`, `importance`, `source`, `id`, `type` properties.

The `Road` class already exposes these as public properties, so most reads work. However, callers that do `road.polyline = [...]` (like `compactRoads`) need special handling — defer this to Task 5.

For the `roads` getter to return objects compatible with existing callers, we need Road objects to have the same shape. Road already has `polyline`, `width`, `hierarchy`, `importance`, `source`, `id` — this covers all read-only access.

The `features` array should still contain road entries for non-road code that iterates `map.features`. Add roads to `features` in `addFeature`:

```js
case 'road': {
  const road = this.roadNetwork.add(data.polyline, data);
  // Store a reference for features[] — use the Road object directly
  const feature = { type: 'road', ...data, id: road.id, _road: road };
  this.features.push(feature);
  // Don't call _stampRoad — RoadNetwork handles it
  break;
}
```

4. Remove `_stampRoad` method (RoadNetwork handles stamping).
5. Remove `_stampRoadValue` method (dead code).
6. Update `_stampRoad`'s buildability zeroing — move into RoadNetwork or keep as a separate post-stamp step on FeatureMap.

**Important:** The buildability zeroing (`this.buildability.set(gx, gz, 0)`) currently lives in `_stampRoad`. Since `RoadNetwork` doesn't know about buildability, keep this as a callback or do it in `addFeature` after the `network.add()` call. Simplest approach: iterate the road's polyline and zero buildability after adding.

Actually, the cleanest approach: add a `stampBuildability` method on FeatureMap that zeros buildability along a road polyline. Call it from `addFeature('road')` after `roadNetwork.add()`.

- [ ] **Step 4: Run existing FeatureMap tests**

Run: `npx vitest run test/core/FeatureMap.test.js`
Expected: PASS — backward compat getters make existing tests pass

- [ ] **Step 5: Update FeatureMap.clone() to clone roadNetwork**

In the `clone()` method, replace the road-related cloning:

```js
// REMOVE:
// copy.bridgeGrid = this.bridgeGrid.clone();
// copy.roadGrid = this.roadGrid.clone();
// ...road feature deep copy...

// The roadNetwork contains roadGrid and bridgeGrid.
// For clone, we need to reconstruct roads in the new network.
// Simplest: re-add each road from serialized data.
for (const road of this.roadNetwork.roads) {
  const json = road.toJSON();
  copy.roadNetwork.add(json.polyline, json);
  // Bridges
  for (const b of json.bridges) {
    copy.roadNetwork.addBridge(/* latest road id */, b.bankA, b.bankB, b.entryT, b.exitT);
  }
}
```

Actually, simpler: clone the underlying grids directly and rebuild the roads map. Or just iterate and re-add. The re-add approach ensures everything is in sync.

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: All existing tests pass. Fix any breakage from the getter change.

- [ ] **Step 7: Commit**

```bash
git add src/core/FeatureMap.js test/core/FeatureMap.test.js
git commit -m "feat: wire FeatureMap to RoadNetwork with backward-compat getters"
```

---

## Task 4: Update growRoads to use RoadNetwork

**Files:**
- Modify: `src/city/pipeline/growRoads.js`
- Modify: `test/city/pipeline/growRoads.test.js`

Currently `growRoads` writes to `roadGrid` directly. Change it to collect cells and call `network.addFromCells()`.

- [ ] **Step 1: Read and understand growRoads.test.js**

Check existing tests to understand the test setup and assertions.

- [ ] **Step 2: Update growRoads to accept roadNetwork parameter**

Change the function signature to accept either `roadGrid` (legacy) or `roadNetwork`. When `roadNetwork` is provided, collect stamped cells and add them as roads at the end.

The simplest approach: keep `roadGrid.set()` calls since they flow through `RoadNetwork` now (FeatureMap's `roadGrid` getter returns the network's grid). The direct `roadGrid.set()` calls in `growRoads` bypass the network though — these are the cells that need to become proper roads.

Better approach: have `growRoads` collect cell arrays for each logical road segment (ribbon gaps, cross streets, path closings) and return them. The caller then calls `network.addFromCells()` for each.

Refactor `growRoads` to:
1. Still take `roadGrid` for reads (checking where existing roads are)
2. Collect new cells into arrays instead of writing to roadGrid directly
3. Return `{ ribbonCells, crossStreetCells, closingCells }` (arrays of cell arrays)
4. Caller stamps them via `network.addFromCells()`

Or simpler: add an optional `roadNetwork` param. When present, use `roadNetwork.addFromCells()` for each logical segment. When absent, fall back to direct grid writes (for tests that don't use a full network).

- [ ] **Step 3: Update growRoads implementation**

Change each `roadGrid.set(gx, gz, 1)` block to collect cells into arrays, then at logical segment boundaries, call `roadNetwork.addFromCells(cells)` or fall back to direct grid writes.

- [ ] **Step 4: Update growRoads tests**

Update test setup to pass a `RoadNetwork` or verify the new return values.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/city/pipeline/growRoads.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/city/pipeline/growRoads.js test/city/pipeline/growRoads.test.js
git commit -m "feat: growRoads collects cells and creates proper Road objects via RoadNetwork"
```

---

## Task 5: Update compactRoads to use RoadNetwork.remove()

**Files:**
- Modify: `src/city/skeleton.js`
- Modify: `test/city/compactRoads.test.js`

Currently `compactRoads` filters `map.roads` and `map.features` arrays. With RoadNetwork, it should call `network.remove(id)` which properly decrements ref counts.

- [ ] **Step 1: Read current compactRoads tests**

Already read — see `test/city/compactRoads.test.js`.

- [ ] **Step 2: Update compactRoads to use roadNetwork API**

The endpoint snapping logic (Pass 1) still needs to work on polylines. But instead of mutating `road.polyline` directly (which Road makes immutable), we need a different approach.

Option A: compactRoads works on Road objects, uses a new `network.updatePolyline()` to apply snapped endpoints.
Option B: compactRoads identifies which roads to remove (Pass 2), calls `network.remove()` for those, and does endpoint snapping via `network.updatePolyline()`.

Go with B — it's closer to the spec's `deduplicateByEndpoints(snapDist)` method.

Refactor compactRoads:
1. Get skeleton roads from `network.roads` (filtered by source === 'skeleton')
2. For Pass 1 (snapping), compute snapped positions but don't mutate — build a Map of road.id → {newStart, newEnd}
3. For Pass 2 (dedup), use snapped endpoints to identify duplicates, call `network.remove(id)` for losers

The endpoint snapping needs to update the actual polylines in the network. Add `updatePolyline` to RoadNetwork (as specified in the spec).

- [ ] **Step 3: Add `updatePolyline` to RoadNetwork**

Add to `RoadNetwork`:

```js
updatePolyline(id, newPolyline) {
  const road = this.#roads.get(id);
  if (!road) return;
  this.#unstampRoad(road);
  this.#removeFromGraph(road);
  // Replace polyline — need friend access to Road's private field
  road._replacePolyline(newPolyline);
  this.#stampRoad(road);
  this.#addToGraph(road);
}
```

Add `_replacePolyline` to `Road` (package-private by convention):

```js
_replacePolyline(newPolyline) {
  this.#polyline = newPolyline.map(p => ({ x: p.x, z: p.z }));
}
```

- [ ] **Step 4: Rewrite compactRoads**

```js
export function compactRoads(map, snapDist) {
  const network = map.roadNetwork;
  const roads = network.roads.filter(r => r.source === 'skeleton');
  if (roads.length === 0) return;

  const snapDistSq = snapDist * snapDist;
  const reps = [];

  function snapPoint(p) {
    let bestDist = snapDistSq, bestRep = null;
    for (const rep of reps) {
      const dx = p.x - rep.x, dz = p.z - rep.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist) { bestDist = d2; bestRep = rep; }
    }
    if (bestRep) return { x: bestRep.x, z: bestRep.z };
    reps.push({ x: p.x, z: p.z });
    return { x: p.x, z: p.z };
  }

  // Pass 1: Compute snapped endpoints
  const snappedEndpoints = new Map(); // roadId → { start, end }
  for (const road of roads) {
    const poly = road.polyline;
    if (poly.length < 2) continue;
    const start = snapPoint(poly[0]);
    const end = snapPoint(poly[poly.length - 1]);
    snappedEndpoints.set(road.id, { start, end });
  }

  // Apply snapped endpoints via updatePolyline
  for (const road of roads) {
    const snap = snappedEndpoints.get(road.id);
    if (!snap) continue;
    const poly = road.polyline;
    const newPoly = [...poly];
    newPoly[0] = snap.start;
    newPoly[newPoly.length - 1] = snap.end;

    // Deduplicate consecutive identical points
    const deduped = [newPoly[0]];
    for (let i = 1; i < newPoly.length; i++) {
      if (newPoly[i].x !== deduped[deduped.length - 1].x ||
          newPoly[i].z !== deduped[deduped.length - 1].z) {
        deduped.push(newPoly[i]);
      }
    }

    if (deduped.length < 2) {
      network.remove(road.id);
      continue;
    }

    network.updatePolyline(road.id, deduped);
  }

  // Pass 2: Remove duplicate roads (same snapped endpoints, keep best hierarchy)
  const HIER_RANK = { arterial: 1, collector: 2, local: 3, track: 4 };
  const remaining = network.roads.filter(r => r.source === 'skeleton');
  const byEndpoints = new Map();

  for (const road of remaining) {
    const s = road.start, e = road.end;
    const key = s.x < e.x || (s.x === e.x && s.z <= e.z)
      ? `${s.x},${s.z}-${e.x},${e.z}`
      : `${e.x},${e.z}-${s.x},${s.z}`;
    if (!byEndpoints.has(key)) byEndpoints.set(key, []);
    byEndpoints.get(key).push(road);
  }

  for (const [, group] of byEndpoints) {
    if (group.length <= 1) continue;
    group.sort((a, b) => (HIER_RANK[a.hierarchy] || 9) - (HIER_RANK[b.hierarchy] || 9));
    for (let i = 1; i < group.length; i++) {
      network.remove(group[i].id);
    }
  }
}
```

- [ ] **Step 5: Update rebuildGraphFromRoads**

```js
export function rebuildGraphFromRoads(map) {
  // With RoadNetwork, the graph is already in sync.
  // Just compact the graph nodes.
  map.graph.compact(map.cellSize * 1.5);
}
```

- [ ] **Step 6: Run compactRoads tests**

Run: `npx vitest run test/city/compactRoads.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/city/skeleton.js src/core/RoadNetwork.js src/core/Road.js test/city/compactRoads.test.js
git commit -m "feat: compactRoads uses RoadNetwork.remove() for ref-counted grid cleanup"
```

---

## Task 6: Update bridges to use parametric bridge data

**Files:**
- Modify: `src/city/bridges.js`
- Modify: `test/city/bridges.test.js`

Replace `_spliceBridge` (destructive polyline mutation) with `road.addBridge()` (parametric data). Rendering uses `road.resolvedPolyline()` instead of the base polyline.

- [ ] **Step 1: Update _spliceBridge → addBridge**

In `src/city/bridges.js`, replace the `_spliceBridge` call in `placeBridges`:

```js
// BEFORE:
// _spliceBridge(crossing.road, crossing.entryX, crossing.entryZ,
//               crossing.exitX, crossing.exitZ, banks.bankA, banks.bankB);

// AFTER:
// Compute parametric positions along polyline arc length
const entryT = _computeParametricT(crossing.road.polyline, crossing.entryX, crossing.entryZ);
const exitT = _computeParametricT(crossing.road.polyline, crossing.exitX, crossing.exitZ);
if (entryT !== null && exitT !== null) {
  crossing.road.addBridge(banks.bankA, banks.bankB, Math.min(entryT, exitT), Math.max(entryT, exitT));
}
```

Add helper:

```js
function _computeParametricT(polyline, wx, wz) {
  // Compute arc lengths
  let totalLen = 0;
  const segLens = [];
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].x - polyline[i - 1].x;
    const dz = polyline[i].z - polyline[i - 1].z;
    const len = Math.sqrt(dx * dx + dz * dz);
    segLens.push(len);
    totalLen += len;
  }
  if (totalLen < 0.001) return null;

  // Find closest point on polyline
  let bestDist = Infinity, bestT = 0, cumLen = 0;
  for (let i = 0; i < segLens.length; i++) {
    const a = polyline[i], b = polyline[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    let t = 0;
    if (lenSq > 0.001) {
      t = Math.max(0, Math.min(1, ((wx - a.x) * dx + (wz - a.z) * dz) / lenSq));
    }
    const px = a.x + t * dx, pz = a.z + t * dz;
    const dist = (wx - px) ** 2 + (wz - pz) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestT = (cumLen + t * segLens[i]) / totalLen;
    }
    cumLen += segLens[i];
  }
  return bestT;
}
```

- [ ] **Step 2: Remove _spliceBridge and _closestPointIndex (dead after this change)**

Delete the `_spliceBridge` and `_closestPointIndex` functions.

- [ ] **Step 3: Update _stampBridgeGrid to use network**

If `map.roadNetwork` is available, call `network.addBridge(roadId, bankA, bankB, entryT, exitT)` which handles both the Road's bridge data and the bridgeGrid stamping.

If callers still need `placeBridges` to work with the old FeatureMap shape during migration, keep the direct `_stampBridgeGrid` call as fallback.

- [ ] **Step 4: Update findRoadWaterCrossings to work with Road objects**

The crossings currently reference `crossing.road` (a plain object). With Road objects, `road.polyline` is a getter that returns the private array — this should still work for reading.

The key change: `crossing.road` is now a `Road` instance, not a plain object. The `importance` and `hierarchy` access patterns (`road.importance || 0.45`) still work because Road has those as public properties.

- [ ] **Step 5: Update rendering to use resolvedPolyline**

In `src/rendering/prepareCityScene.js` (line ~50), where roads are mapped for rendering, use `road.resolvedPolyline()` if available, falling back to `road.polyline`:

```js
polyline: road.resolvedPolyline ? road.resolvedPolyline() : road.polyline,
```

- [ ] **Step 6: Update bridge tests**

Update `test/city/bridges.test.js`:
- The "splices a perpendicular bridge" test should check `road.bridges.length === 1` instead of checking polyline mutation.
- The "multiple bridges for road crossing two rivers" test should check `road.bridges.length === 2`.

- [ ] **Step 7: Run bridge tests**

Run: `npx vitest run test/city/bridges.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/city/bridges.js test/city/bridges.test.js src/rendering/prepareCityScene.js
git commit -m "feat: bridges use parametric data instead of destructive polyline splice"
```

---

## Task 7: Update callers that manually manage graph

**Files:**
- Modify: `src/city/pipeline/layoutRibbons.js`
- Modify: `src/city/pipeline/connectIslandZones.js`
- Modify: `src/city/strategies/desireLines.js`
- Modify: `src/city/skeletonStrategies.js`
- Modify: `src/city/pipeline/zoneBoundaryRoads.js`
- Modify: `src/city/pipeline/connectToNetwork.js`
- Modify: `src/city/pipeline/wrapZoneWithRoad.js`
- Modify: `src/city/strategies/faceSubdivision.js`
- Modify: `src/city/strategies/offsetInfill.js`
- Modify: `src/city/strategies/stripDevelopment.js`
- Modify: `src/city/strategies/triangleMergeSubdiv.js`
- Modify: `src/city/strategies/frontagePressure.js`

These callers do one or more of:
1. Call `addRoadToGraph(map, polyline, ...)` after `addFeature('road', ...)`
2. Write to `roadGrid.set(gx, gz, 1)` directly
3. Manually create graph edges via `map.graph.addEdge(...)`
4. Push to `map.roads` directly

Since `addFeature('road', ...)` now delegates to `RoadNetwork.add()`, which stamps the grid AND adds the graph edge, callers that do both `addFeature` AND `addRoadToGraph` now double-add graph edges.

The fix for each caller is: **remove the manual `addRoadToGraph` / `map.graph.addEdge` / `roadGrid.set` calls** that follow `addFeature('road', ...)`, since the network handles all of it.

- [ ] **Step 1: Update layoutRibbons.js**

Remove lines 92-103 (manual graph edge addition after addFeature). The `addFeature` call at line 87 now handles graph addition via RoadNetwork.

- [ ] **Step 2: Update connectIslandZones.js**

Remove lines 91-103 (manual graph edge addition). Delete the dead `findNearestRoad` function (lines 129-151). Remove the local `findOrCreate` helper if it's only used for graph manipulation.

- [ ] **Step 3: Update desireLines.js**

Remove the `addRoadToGraph` import and call (line 133). Remove the `roadGrid.set` loop (lines 136-140) — road stamping is handled by `addFeature` → `RoadNetwork.add()`.

Also remove the second occurrence around line 296 if there's another `addRoadToGraph` + `roadGrid.set` block.

- [ ] **Step 4: Update skeletonStrategies.js**

Remove the `addRoadToGraph` import and call (line ~363).

- [ ] **Step 5: Update zoneBoundaryRoads.js, connectToNetwork.js, wrapZoneWithRoad.js**

These files manually add graph edges after adding road features. Remove the manual graph manipulation since `addFeature('road')` now handles it.

For `zoneBoundaryRoads.js` which heavily uses `map.graph` for face extraction — this is read-only access and still works through the backward-compat getter.

- [ ] **Step 6: Update strategy files that read from map.graph**

`faceSubdivision.js`, `offsetInfill.js`, `stripDevelopment.js`, `triangleMergeSubdiv.js`, `frontagePressure.js` — these primarily READ from `map.graph` (face extraction, pathfinding). They should work unchanged through backward-compat getters.

Check if any of them also write to graph. If they call `addFeature('road')` + manually add graph edges, remove the manual graph part.

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all tests should pass with the unified mutation path.

Fix any failures caused by double graph edges (duplicate edge detection) or missing imports.

- [ ] **Step 8: Commit**

```bash
git add src/city/pipeline/ src/city/strategies/ src/city/skeleton.js src/city/skeletonStrategies.js
git commit -m "refactor: remove manual graph/grid management — RoadNetwork handles all sync"
```

---

## Task 8: Delete dead code and clean up

**Files:**
- Modify: `src/core/FeatureMap.js`
- Modify: `src/city/skeleton.js`
- Modify: `src/city/pipeline/connectIslandZones.js`

- [ ] **Step 1: Delete _stampRoadValue from FeatureMap**

Remove the no-op `_stampRoadValue` method and its call in `addFeature`.

- [ ] **Step 2: Delete findNearestRoad from connectIslandZones.js**

If not already deleted in Task 7.

- [ ] **Step 3: Delete the standalone addRoadToGraph export from skeleton.js**

If no callers remain after Task 7 updates. Update the export list.

Check that `rebuildGraphFromRoads` is updated (Task 5 simplified it to just compact).

- [ ] **Step 4: Remove PlanarGraph import from FeatureMap if unused**

FeatureMap no longer creates a PlanarGraph directly.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: delete dead code — _stampRoadValue, findNearestRoad, standalone addRoadToGraph"
```

---

## Task 9: Update FeatureMap.clone()

**Files:**
- Modify: `src/core/FeatureMap.js`

- [ ] **Step 1: Write a test for cloning with roads**

Add to `test/core/FeatureMap.test.js`:

```js
it('clone preserves roads and roadGrid via RoadNetwork', () => {
  const map = makeMap();
  map.addFeature('road', {
    polyline: [{ x: 100, z: 250 }, { x: 400, z: 250 }],
    width: 10,
    hierarchy: 'collector',
    source: 'skeleton',
  });

  const copy = map.clone();

  expect(copy.roads.length).toBe(1);
  expect(copy.roadNetwork.roadCount).toBe(1);
  // roadGrid should have same stamped cells
  let origCells = 0, copyCells = 0;
  for (let gz = 0; gz < map.height; gz++) {
    for (let gx = 0; gx < map.width; gx++) {
      if (map.roadGrid.get(gx, gz) > 0) origCells++;
      if (copy.roadGrid.get(gx, gz) > 0) copyCells++;
    }
  }
  expect(copyCells).toBe(origCells);
  // Graph should have same structure
  expect(copy.graph.edges.size).toBe(map.graph.edges.size);
});
```

- [ ] **Step 2: Implement clone for roadNetwork**

In `FeatureMap.clone()`, replace the manual road/grid cloning with:

```js
// Re-add all roads to the copy's network
for (const road of this.roadNetwork.roads) {
  const r = copy.roadNetwork.add(road.polyline, {
    width: road.width,
    hierarchy: road.hierarchy,
    importance: road.importance,
    source: road.source,
  });
  for (const b of road.bridges) {
    copy.roadNetwork.addBridge(r.id, b.bankA, b.bankB, b.entryT, b.exitT);
  }
}
```

Remove the old `copy.roadGrid = this.roadGrid.clone()` and `copy.bridgeGrid = this.bridgeGrid.clone()` lines since the network owns those grids.

Also remove the road entries from the `features` deep copy loop (they're re-added above) — or re-add feature entries for the copy.

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/core/FeatureMap.test.js`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/FeatureMap.js test/core/FeatureMap.test.js
git commit -m "feat: FeatureMap.clone() properly clones RoadNetwork state"
```

---

## Final verification

- [ ] **Run full test suite one last time**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Visual smoke test**

Run a city generation with a seed and verify the output looks correct:
`node scripts/run-experiment.js` (or equivalent rendering script)

Verify:
- Roads render correctly
- Bridges appear at river crossings
- No ghost corridors visible
- Block extraction (face-based subdivision) still works
