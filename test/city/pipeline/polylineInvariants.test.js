// test/city/pipeline/polylineInvariants.test.js
import { describe, it, expect } from 'vitest';
import { checkAllPolylineInvariants, makePolylineInvariantHook } from '../../../src/city/invariants/polylineInvariants.js';
import { PlanarGraph } from '../../../src/core/PlanarGraph.js';

/**
 * Build a minimal mock FeatureMap with a roadNetwork stub backed by
 * a real PlanarGraph. The map is 100x100 cells, cellSize=1, origin at (0,0).
 */
function makeMockMap(graph, roads = []) {
  return {
    width: 100,
    height: 100,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    roadNetwork: {
      graph,
      roads,
      count: undefined, // not used for these checks
    },
    hasLayer() { return false; },
    getLayer() { return null; },
  };
}

// ── duplicateEdges ──────────────────────────────────────────────────────────

describe('duplicateEdges invariant', () => {
  it('reports 0 for a graph with no duplicate edges', () => {
    const g = new PlanarGraph();
    const a = g.addNode(10, 10);
    const b = g.addNode(20, 10);
    const c = g.addNode(30, 10);
    g.addEdge(a, b);
    g.addEdge(b, c);

    const map = makeMockMap(g);
    const r = checkAllPolylineInvariants(map);
    expect(r.duplicateEdges).toBe(0);
  });

  it('detects one duplicate when the same node pair has two edges', () => {
    const g = new PlanarGraph();
    const a = g.addNode(10, 10);
    const b = g.addNode(20, 10);
    g.addEdge(a, b);
    g.addEdge(a, b); // duplicate

    const map = makeMockMap(g);
    const r = checkAllPolylineInvariants(map);
    expect(r.duplicateEdges).toBe(1);
  });

  it('detects duplicate even when edge direction is reversed', () => {
    const g = new PlanarGraph();
    const a = g.addNode(10, 10);
    const b = g.addNode(20, 10);
    g.addEdge(a, b);
    g.addEdge(b, a); // same pair, reversed

    const map = makeMockMap(g);
    const r = checkAllPolylineInvariants(map);
    expect(r.duplicateEdges).toBe(1);
  });

  it('counts multiple duplicates correctly (3 edges same pair = 2 duplicates)', () => {
    const g = new PlanarGraph();
    const a = g.addNode(10, 10);
    const b = g.addNode(20, 10);
    g.addEdge(a, b);
    g.addEdge(a, b);
    g.addEdge(b, a);

    const map = makeMockMap(g);
    const r = checkAllPolylineInvariants(map);
    expect(r.duplicateEdges).toBe(2);
  });
});

// ── danglingEdges ───────────────────────────────────────────────────────────

describe('danglingEdges invariant', () => {
  it('reports 0 for a fully interior graph with no degree-1 nodes', () => {
    // Triangle in the center of the map
    const g = new PlanarGraph();
    const a = g.addNode(40, 40);
    const b = g.addNode(60, 40);
    const c = g.addNode(50, 60);
    g.addEdge(a, b);
    g.addEdge(b, c);
    g.addEdge(c, a);

    const map = makeMockMap(g);
    const r = checkAllPolylineInvariants(map);
    expect(r.danglingEdges).toBe(0);
  });

  it('detects degree-1 node far from boundary as dangling', () => {
    const g = new PlanarGraph();
    const a = g.addNode(50, 50); // center — far from boundary
    const b = g.addNode(60, 50);
    g.addEdge(a, b);
    // Both a and b are degree-1, both far from boundary

    const map = makeMockMap(g);
    const r = checkAllPolylineInvariants(map);
    expect(r.danglingEdges).toBe(2);
  });

  it('does NOT flag degree-1 nodes that are near the map boundary', () => {
    // cellSize=1, boundaryMargin=2. Node at x=1 is within 2 cells of edge.
    const g = new PlanarGraph();
    const boundary = g.addNode(1, 50);  // near left edge
    const interior = g.addNode(10, 50);
    g.addEdge(boundary, interior);

    const map = makeMockMap(g);
    const r = checkAllPolylineInvariants(map);
    // boundary node is within 2 cells of left edge -> not dangling
    // interior node at (10, 50) is > 2 cells from all edges -> dangling
    expect(r.danglingEdges).toBe(1);
  });

  it('does NOT flag degree-1 nodes at all four boundary edges', () => {
    const g = new PlanarGraph();
    // Place degree-1 nodes near each boundary
    const left   = g.addNode(0, 50);
    const right  = g.addNode(99, 50);
    const top    = g.addNode(50, 0);
    const bottom = g.addNode(50, 99);
    const center = g.addNode(50, 50);
    g.addEdge(left, center);
    g.addEdge(right, center);
    g.addEdge(top, center);
    g.addEdge(bottom, center);

    const map = makeMockMap(g);
    const r = checkAllPolylineInvariants(map);
    // All four boundary nodes are within 2 cells of boundary -> not dangling
    // center has degree 4 -> not degree-1
    expect(r.danglingEdges).toBe(0);
  });
});

// ── makePolylineInvariantHook integration ───────────────────────────────────

describe('makePolylineInvariantHook reports new checks', () => {
  it('fires onViolation for duplicateEdges', () => {
    const g = new PlanarGraph();
    const a = g.addNode(10, 10);
    const b = g.addNode(20, 10);
    g.addEdge(a, b);
    g.addEdge(a, b);

    const map = makeMockMap(g);
    const violations = [];
    const hook = makePolylineInvariantHook(map, (step, name, detail) => {
      violations.push({ step, name, detail });
    });

    hook.onAfter('test-step');

    const dup = violations.find(v => v.name === 'duplicateEdges');
    expect(dup).toBeDefined();
    expect(dup.detail).toBe(1);
  });

  it('fires onViolation for danglingEdges', () => {
    const g = new PlanarGraph();
    const a = g.addNode(50, 50);
    const b = g.addNode(60, 50);
    g.addEdge(a, b);

    const map = makeMockMap(g);
    const violations = [];
    const hook = makePolylineInvariantHook(map, (step, name, detail) => {
      violations.push({ step, name, detail });
    });

    hook.onAfter('test-step');

    const dang = violations.find(v => v.name === 'danglingEdges');
    expect(dang).toBeDefined();
    expect(dang.detail).toBe(2);
  });

  it('does NOT fire for clean graphs', () => {
    const g = new PlanarGraph();
    const a = g.addNode(40, 40);
    const b = g.addNode(60, 40);
    const c = g.addNode(50, 60);
    g.addEdge(a, b);
    g.addEdge(b, c);
    g.addEdge(c, a);

    const map = makeMockMap(g);
    const violations = [];
    const hook = makePolylineInvariantHook(map, (step, name, detail) => {
      violations.push({ step, name, detail });
    });

    hook.onAfter('test-step');

    const dup = violations.find(v => v.name === 'duplicateEdges');
    const dang = violations.find(v => v.name === 'danglingEdges');
    expect(dup).toBeUndefined();
    expect(dang).toBeUndefined();
  });
});
