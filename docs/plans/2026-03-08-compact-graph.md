# Compact Graph — Eliminate Parallel Paths

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate parallel/duplicate road edges from the PlanarGraph by squashing adjacent nodes and deduplicating edges.

**Architecture:** Add a `compactGraph(graph, snapDist)` method to PlanarGraph that runs two passes: (1) merge nodes within `snapDist` of each other using Union-Find, rewiring all edges to the surviving node; (2) remove duplicate edges between the same node pair, keeping the highest-hierarchy one. Called after all skeleton roads are added but before bridge placement.

**Tech Stack:** Vitest, ES modules, existing PlanarGraph.js + UnionFind.js

---

## Current State

`addRoadToGraph` in `skeleton.js` snaps endpoints to existing nodes within `cellSize * 3` and skips edges between already-connected nodes. But:
- Two nodes 8 units apart (adjacent cells at cellSize=10) both survive as separate nodes
- Two edges A→C and B→C where A and B are adjacent become parallel roads
- No post-addition cleanup exists

## Target State

After `buildSkeletonRoads` adds all roads (main + nuclei + extras), call `graph.compact(cellSize)` which:
1. Merges all node pairs within `cellSize * 1.5` (15 units) into one node
2. Rewires edges from merged nodes to surviving nodes
3. Removes duplicate edges between same node pair (keeps highest hierarchy)
4. Removes self-loops (edges where from === to after merge)

---

### Task 1: Add `mergeNodes` to PlanarGraph

**Files:**
- Modify: `src/core/PlanarGraph.js` (add method after `removeNode`)
- Test: `test/core/PlanarGraph.test.js`

**Step 1: Write the failing test**

```js
it('mergeNodes rewires edges to survivor', () => {
  const g = new PlanarGraph();
  const a = g.addNode(0, 0);
  const b = g.addNode(5, 0);   // close to a
  const c = g.addNode(100, 0);
  g.addEdge(a, c, { hierarchy: 'arterial' });
  g.addEdge(b, c, { hierarchy: 'collector' });

  g.mergeNodes(b, a); // merge b into a

  expect(g.nodes.has(b)).toBe(false);
  expect(g.nodes.has(a)).toBe(true);
  // Both edges now connect to a
  expect(g.degree(a)).toBe(2);
  // c still has 2 edges (both now from a)
  expect(g.degree(c)).toBe(2);
});

it('mergeNodes removes self-loops', () => {
  const g = new PlanarGraph();
  const a = g.addNode(0, 0);
  const b = g.addNode(5, 0);
  g.addEdge(a, b);

  g.mergeNodes(b, a);

  expect(g.nodes.has(b)).toBe(false);
  expect(g.edges.size).toBe(0); // edge became self-loop, removed
});
```

Add import: already imported.

**Step 2:** Run `npx vitest run test/core/PlanarGraph.test.js` — expect FAIL

**Step 3: Implement**

Add to `src/core/PlanarGraph.js` after `removeNode`:

```js
/**
 * Merge node `from` into node `into`.
 * Rewires all edges from `from` to point to `into` instead.
 * Removes self-loops and deletes the `from` node.
 *
 * @param {number} from - Node to remove
 * @param {number} into - Node to keep
 */
mergeNodes(from, into) {
  if (from === into) return;
  if (!this.nodes.has(from) || !this.nodes.has(into)) return;

  // Rewire all edges touching `from`
  const adj = this._adjacency.get(from);
  if (adj) {
    for (const { edgeId } of [...adj]) {
      const edge = this.edges.get(edgeId);
      if (!edge) continue;

      let newFrom = edge.from === from ? into : edge.from;
      let newTo = edge.to === from ? into : edge.to;

      // Self-loop after merge — remove
      if (newFrom === newTo) {
        this._removeEdge(edgeId);
        continue;
      }

      // Rewire in place
      edge.from = newFrom;
      edge.to = newTo;
    }

    // Move remaining adjacency entries to `into`
    const intoAdj = this._adjacency.get(into);
    for (const entry of [...adj]) {
      if (!this.edges.has(entry.edgeId)) continue; // was removed as self-loop
      // Update neighborId: if it pointed to `from`, fix it
      // The entry itself is from `from`'s perspective, now it's `into`'s
      intoAdj.push(entry);
    }

    // Also fix adjacency entries at the OTHER end of each rewired edge
    for (const entry of intoAdj) {
      const edge = this.edges.get(entry.edgeId);
      if (!edge) continue;
      const other = edge.from === into ? edge.to : edge.from;
      if (other === into) continue;
      const otherAdj = this._adjacency.get(other);
      if (!otherAdj) continue;
      for (const oe of otherAdj) {
        if (oe.edgeId === entry.edgeId) {
          oe.neighborId = into;
        }
      }
    }
  }

  // Delete the merged node
  this.nodes.delete(from);
  this._adjacency.delete(from);
}
```

**Step 4:** Run `npx vitest run test/core/PlanarGraph.test.js` — expect PASS

**Step 5:** Commit: `feat: add mergeNodes to PlanarGraph`

---

### Task 2: Add `compact` to PlanarGraph

**Files:**
- Modify: `src/core/PlanarGraph.js` (add method after `mergeNodes`)
- Test: `test/core/PlanarGraph.test.js`

**Step 1: Write the failing test**

```js
it('compact merges adjacent nodes and deduplicates edges', () => {
  const g = new PlanarGraph();
  //   a(0,0) -- c(100,0)
  //   b(8,0) -- c(100,0)   (a and b are adjacent, within snapDist=15)
  const a = g.addNode(0, 0);
  const b = g.addNode(8, 0);
  const c = g.addNode(100, 0);
  g.addEdge(a, c, { hierarchy: 'arterial' });
  g.addEdge(b, c, { hierarchy: 'collector' });

  g.compact(15);

  // a and b merged into one node
  expect(g.nodes.size).toBe(2);
  // Duplicate edges to c collapsed into one (arterial wins)
  expect(g.edges.size).toBe(1);
  const edge = [...g.edges.values()][0];
  expect(edge.hierarchy).toBe('arterial');
});

it('compact removes self-loops from merged adjacent pair', () => {
  const g = new PlanarGraph();
  const a = g.addNode(0, 0);
  const b = g.addNode(5, 0);
  const c = g.addNode(100, 0);
  g.addEdge(a, b); // becomes self-loop
  g.addEdge(a, c);

  g.compact(15);

  expect(g.nodes.size).toBe(2);
  expect(g.edges.size).toBe(1); // only a→c survives
});

it('compact does not merge distant nodes', () => {
  const g = new PlanarGraph();
  const a = g.addNode(0, 0);
  const b = g.addNode(50, 0);
  const c = g.addNode(100, 0);
  g.addEdge(a, b);
  g.addEdge(b, c);

  g.compact(15);

  expect(g.nodes.size).toBe(3);
  expect(g.edges.size).toBe(2);
});
```

**Step 2:** Run `npx vitest run test/core/PlanarGraph.test.js` — expect FAIL

**Step 3: Implement**

Add to `src/core/PlanarGraph.js` after `mergeNodes`:

```js
/**
 * Compact the graph by merging nearby nodes and deduplicating edges.
 *
 * Pass 1: Merge all node pairs within snapDist using Union-Find.
 * Pass 2: Remove duplicate edges between same node pair (keep highest hierarchy).
 *
 * @param {number} snapDist - Maximum distance to merge nodes
 */
compact(snapDist) {
  const HIER_RANK = { arterial: 1, collector: 2, local: 3, track: 4 };

  // --- Pass 1: Merge nearby nodes ---
  const nodeIds = [...this.nodes.keys()];
  const nodeArr = nodeIds.map(id => this.nodes.get(id));

  // Find merge groups via simple greedy approach: for each pair within snapDist,
  // merge the second into the first (using union-find logic)
  const parent = new Map();
  for (const id of nodeIds) parent.set(id, id);

  function find(id) {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  }

  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  // O(n²) — fine for road graphs (typically <200 nodes)
  for (let i = 0; i < nodeArr.length; i++) {
    for (let j = i + 1; j < nodeArr.length; j++) {
      const dx = nodeArr[i].x - nodeArr[j].x;
      const dz = nodeArr[i].z - nodeArr[j].z;
      if (Math.sqrt(dx * dx + dz * dz) <= snapDist) {
        union(nodeArr[i].id, nodeArr[j].id);
      }
    }
  }

  // Merge nodes into their root
  for (const id of nodeIds) {
    const root = find(id);
    if (root !== id) {
      this.mergeNodes(id, root);
    }
  }

  // --- Pass 2: Deduplicate edges between same node pair ---
  // Group edges by normalized (min,max) node pair
  const pairMap = new Map(); // "min-max" → [edgeId, ...]
  for (const [edgeId, edge] of this.edges) {
    const lo = Math.min(edge.from, edge.to);
    const hi = Math.max(edge.from, edge.to);
    const key = `${lo}-${hi}`;
    if (!pairMap.has(key)) pairMap.set(key, []);
    pairMap.get(key).push(edgeId);
  }

  for (const [, edgeIds] of pairMap) {
    if (edgeIds.length <= 1) continue;
    // Keep the edge with best (lowest rank number) hierarchy
    edgeIds.sort((a, b) => {
      const ea = this.edges.get(a), eb = this.edges.get(b);
      return (HIER_RANK[ea.hierarchy] || 9) - (HIER_RANK[eb.hierarchy] || 9);
    });
    // Remove all but the best
    for (let i = 1; i < edgeIds.length; i++) {
      this._removeEdge(edgeIds[i]);
    }
  }
}
```

**Step 4:** Run `npx vitest run test/core/PlanarGraph.test.js` — expect PASS

**Step 5:** Commit: `feat: add compact() to PlanarGraph — merge nearby nodes, deduplicate edges`

---

### Task 3: Call `compact` in skeleton

**Files:**
- Modify: `src/city/skeleton.js:89` (add compact call before bridges)

**Step 1:** Add after the `_addExtraEdges` call and before `placeBridges`:

```js
  // 7a. Compact graph: merge adjacent nodes, deduplicate parallel edges
  map.graph.compact(map.cellSize * 1.5);
```

So the skeleton end becomes:
```js
  _addExtraEdges(map, extraConnections);

  // 7a. Compact graph: merge adjacent nodes, deduplicate parallel edges
  map.graph.compact(map.cellSize * 1.5);

  // 8. Place bridges where skeleton roads cross rivers.
  placeBridges(map);
```

**Step 2:** Run `npx vitest run test/city/skeleton.test.js` — expect PASS

**Step 3:** Run `npx vitest run` — expect all tests PASS

**Step 4:** Commit: `feat: compact graph after skeleton to eliminate parallel roads`

---

### Task 4: Verify visually

**Step 1:** Open `http://localhost:3000/?seed=652341&mode=skeletons&gx=97&gz=103`

**Step 2:** Check:
- Parallel road lines are gone (single line where before there were 2-3)
- Graph nodes (green dots) are fewer — adjacent pairs merged
- Road topology still correct (no missing connections)
- Dead ends and junctions look reasonable

**Step 3:** Spot-check 2-3 other seeds.
