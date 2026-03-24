import { describe, it, expect } from 'vitest';
import { PlanarGraph } from '../../src/core/PlanarGraph.js';

describe('PlanarGraph', () => {
  it('adds nodes and retrieves them', () => {
    const g = new PlanarGraph();
    const id = g.addNode(10, 20, { type: 'junction' });
    const node = g.getNode(id);
    expect(node.x).toBe(10);
    expect(node.z).toBe(20);
    expect(node.attrs.type).toBe('junction');
  });

  it('adds edges between nodes', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    const eId = g.addEdge(a, b, { width: 8, hierarchy: 'arterial' });
    const edge = g.getEdge(eId);
    expect(edge.from).toBe(a);
    expect(edge.to).toBe(b);
    expect(edge.width).toBe(8);
    expect(edge.hierarchy).toBe('arterial');
  });

  it('throws when adding edge with invalid nodes', () => {
    const g = new PlanarGraph();
    expect(() => g.addEdge(0, 1)).toThrow();
  });

  it('computes degree correctly', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    const c = g.addNode(0, 10);
    g.addEdge(a, b);
    g.addEdge(a, c);
    expect(g.degree(a)).toBe(2);
    expect(g.degree(b)).toBe(1);
  });

  it('returns neighbors', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    const c = g.addNode(0, 10);
    g.addEdge(a, b);
    g.addEdge(a, c);
    const neighbors = g.neighbors(a);
    expect(neighbors).toContain(b);
    expect(neighbors).toContain(c);
    expect(neighbors.length).toBe(2);
  });

  it('edgePolyline includes endpoints', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 10);
    const mid = [{ x: 5, z: 3 }];
    const eId = g.addEdge(a, b, { points: mid });
    const poly = g.edgePolyline(eId);
    expect(poly).toEqual([
      { x: 0, z: 0 },
      { x: 5, z: 3 },
      { x: 10, z: 10 },
    ]);
  });

  it('finds dead ends', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    const c = g.addNode(20, 0);
    g.addEdge(a, b);
    g.addEdge(b, c);
    const deadEnds = g.deadEnds();
    expect(deadEnds).toContain(a);
    expect(deadEnds).toContain(c);
    expect(deadEnds).not.toContain(b);
  });

  it('finds nearest node', () => {
    const g = new PlanarGraph();
    g.addNode(0, 0);
    const bId = g.addNode(10, 0);
    g.addNode(20, 0);
    const result = g.nearestNode(9, 1);
    expect(result.id).toBe(bId);
  });

  it('isConnected detects connected graph', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    const c = g.addNode(20, 0);
    g.addEdge(a, b);
    g.addEdge(b, c);
    expect(g.isConnected()).toBe(true);
  });

  it('isConnected detects disconnected graph', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    g.addNode(20, 0); // isolated
    g.addEdge(a, b);
    expect(g.isConnected()).toBe(false);
  });

  it('splitEdge creates new node and two edges', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    const eId = g.addEdge(a, b);

    const newId = g.splitEdge(eId, 5, 0);
    expect(g.getNode(newId)).toBeDefined();
    expect(g.degree(newId)).toBe(2);
    expect(g.edges.has(eId)).toBe(false); // original edge removed
  });

  it('removeNode cleans up edges', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    g.addEdge(a, b);

    g.removeNode(b);
    expect(g.nodes.has(b)).toBe(false);
    expect(g.degree(a)).toBe(0);
    expect(g.edges.size).toBe(0);
  });

  it('empty graph returns no faces', () => {
    const g = new PlanarGraph();
    expect(g.faces()).toEqual([]);
  });

  it('isConnected on empty graph returns true', () => {
    const g = new PlanarGraph();
    expect(g.isConnected()).toBe(true);
  });

  it('facesWithEdges returns faces with edge IDs', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    const c = g.addNode(10, 10);
    const d = g.addNode(0, 10);

    const e1 = g.addEdge(a, b);
    const e2 = g.addEdge(b, c);
    const e3 = g.addEdge(c, d);
    const e4 = g.addEdge(d, a);

    const faces = g.facesWithEdges();
    expect(faces.length).toBeGreaterThan(0);

    // At least one face should have all 4 nodes and 4 edges
    const squareFace = faces.find(f => f.nodeIds.length === 4);
    expect(squareFace).toBeDefined();
    expect(squareFace.edgeIds.length).toBe(4);

    // All edge IDs should be valid
    const allEdgeIds = new Set([e1, e2, e3, e4]);
    for (const eid of squareFace.edgeIds) {
      expect(allEdgeIds.has(eid)).toBe(true);
    }
  });

  it('facesWithEdges backward compatible with faces', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(10, 0);
    const c = g.addNode(10, 10);
    const d = g.addNode(0, 10);

    g.addEdge(a, b);
    g.addEdge(b, c);
    g.addEdge(c, d);
    g.addEdge(d, a);

    const oldFaces = g.faces();
    const newFaces = g.facesWithEdges();

    // Same number of faces
    expect(newFaces.length).toBe(oldFaces.length);

    // nodeIds should match
    const oldNodeSets = oldFaces.map(f => [...f].sort().join(','));
    const newNodeSets = newFaces.map(f => [...f.nodeIds].sort().join(','));
    for (const ns of newNodeSets) {
      expect(oldNodeSets).toContain(ns);
    }
  });

  it('facesWithEdges on empty graph returns empty', () => {
    const g = new PlanarGraph();
    expect(g.facesWithEdges()).toEqual([]);
  });

  it('faces extracts all inner faces from a properly embedded graph', () => {
    const g = new PlanarGraph();

    // Center crossroads: 4 triangular faces
    //        1
    //       / \
    //      /   \
    //     /     \
    //    0---5---2
    //     \     /
    //      \   /
    //       \ /
    //        3
    const n0 = g.addNode(0, 150);
    const n1 = g.addNode(150, 0);
    const n2 = g.addNode(300, 150);
    const n3 = g.addNode(150, 300);
    const n5 = g.addNode(150, 150); // center

    g.addEdge(n0, n1);
    g.addEdge(n1, n2);
    g.addEdge(n2, n3);
    g.addEdge(n3, n0);
    g.addEdge(n0, n5);
    g.addEdge(n1, n5);
    g.addEdge(n2, n5);
    g.addEdge(n3, n5);

    const faces = g.faces();
    // 4 inner triangular faces + 1 outer face = 5
    expect(faces.length).toBe(5);

    // 4 simple triangular faces (3 nodes each)
    const simpleFaces = faces.filter(f => f.length === 3);
    expect(simpleFaces.length).toBe(4);
  });

  it('mergeNodes rewires edges to survivor and deduplicates', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(5, 0);
    const c = g.addNode(100, 0);
    g.addEdge(a, c, { hierarchy: 'arterial' });
    g.addEdge(b, c, { hierarchy: 'collector' });

    g.mergeNodes(b, a);

    expect(g.nodes.has(b)).toBe(false);
    expect(g.nodes.has(a)).toBe(true);
    // After merge, A→C existed twice (original + rewired B→C).
    // Deduplication removes the duplicate, leaving exactly 1 edge.
    expect(g.degree(a)).toBe(1);
    expect(g.degree(c)).toBe(1);
  });

  it('mergeNodes removes self-loops', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(5, 0);
    g.addEdge(a, b);

    g.mergeNodes(b, a);

    expect(g.nodes.has(b)).toBe(false);
    expect(g.edges.size).toBe(0);
  });

  it('compact merges adjacent nodes and deduplicates edges', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(8, 0);
    const c = g.addNode(100, 0);
    g.addEdge(a, c, { hierarchy: 'arterial' });
    g.addEdge(b, c, { hierarchy: 'collector' });

    g.compact(15);

    expect(g.nodes.size).toBe(2);
    expect(g.edges.size).toBe(1);
    const edge = [...g.edges.values()][0];
    expect(edge.hierarchy).toBe('arterial');
  });

  it('compact removes self-loops from merged adjacent pair', () => {
    const g = new PlanarGraph();
    const a = g.addNode(0, 0);
    const b = g.addNode(5, 0);
    const c = g.addNode(100, 0);
    g.addEdge(a, b);
    g.addEdge(a, c);

    g.compact(15);

    expect(g.nodes.size).toBe(2);
    expect(g.edges.size).toBe(1);
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

  it('detectSliverFaces finds thin triangles', () => {
    const g = new PlanarGraph();

    const n0 = g.addNode(0, 0);
    const n1 = g.addNode(200, 0);
    const n2 = g.addNode(100, 5);
    g.addEdge(n0, n1);
    g.addEdge(n1, n2);
    g.addEdge(n2, n0);

    const slivers = g.detectSliverFaces({ maxArea: 5000, maxCompactness: 0.2 });
    // Both inner and outer face are 3-node slivers in this trivial graph
    expect(slivers.length).toBe(2);
    expect(slivers[0].area).toBe(500);
    expect(slivers[0].compactness).toBeLessThan(0.05);
  });

  it('detectSliverFaces finds thin quadrilaterals', () => {
    const g = new PlanarGraph();

    // Two near-parallel roads forming a thin quad
    //  0 --------- 1
    //  |           |
    //  3 --------- 2    (only 10 units apart)
    const n0 = g.addNode(0, 0);
    const n1 = g.addNode(300, 0);
    const n2 = g.addNode(300, 10);
    const n3 = g.addNode(0, 10);
    g.addEdge(n0, n1);
    g.addEdge(n1, n2);
    g.addEdge(n2, n3);
    g.addEdge(n3, n0);

    const slivers = g.detectSliverFaces({ maxArea: 5000, maxCompactness: 0.2 });
    expect(slivers.length).toBeGreaterThanOrEqual(1);
    expect(slivers[0].edges).toBe(4);
    expect(slivers[0].area).toBe(3000);
  });

  it('detectSliverFaces ignores compact faces', () => {
    const g = new PlanarGraph();

    const n0 = g.addNode(0, 0);
    const n1 = g.addNode(200, 0);
    const n2 = g.addNode(100, 173);
    g.addEdge(n0, n1);
    g.addEdge(n1, n2);
    g.addEdge(n2, n0);

    const slivers = g.detectSliverFaces({ maxArea: 50000, maxCompactness: 0.12 });
    expect(slivers.length).toBe(0);
  });

  it('detectCrossingEdges finds intersecting edges', () => {
    const g = new PlanarGraph();

    // Two crossing edges: (0,0)-(100,100) and (100,0)-(0,100)
    const n0 = g.addNode(0, 0);
    const n1 = g.addNode(100, 100);
    const n2 = g.addNode(100, 0);
    const n3 = g.addNode(0, 100);
    g.addEdge(n0, n1);
    g.addEdge(n2, n3);

    const crossings = g.detectCrossingEdges();
    expect(crossings.length).toBe(1);
    expect(crossings[0].x).toBeCloseTo(50);
    expect(crossings[0].z).toBeCloseTo(50);
  });

  it('detectCrossingEdges ignores edges sharing a node', () => {
    const g = new PlanarGraph();

    const n0 = g.addNode(0, 0);
    const n1 = g.addNode(100, 0);
    const n2 = g.addNode(50, 50);
    g.addEdge(n0, n1);
    g.addEdge(n0, n2);

    const crossings = g.detectCrossingEdges();
    expect(crossings.length).toBe(0);
  });

  it('faces uses polyline direction for angle computation', () => {
    const g = new PlanarGraph();

    // Two edges from node 1 going in similar endpoint directions,
    // but polyline point on 1→2 makes the angles distinguishable
    //
    // 0 --- 1 -.   (1→2 curves via (230,100))
    // |     |   `.
    // |     4    2
    // |         /
    // 3 ------/
    const n0 = g.addNode(0, 0);
    const n1 = g.addNode(200, 0);
    const n2 = g.addNode(200, 200);
    const n3 = g.addNode(0, 200);
    const n4 = g.addNode(200, 100);

    g.addEdge(n0, n1);
    g.addEdge(n0, n3);
    g.addEdge(n3, n2);
    // Edge 1→2 curves RIGHT of n4 via polyline point
    g.addEdge(n1, n2, { points: [{ x: 230, z: 100 }] });
    // Edge 1→4 goes straight down (angle 0°)
    // Edge 1→2 first segment goes toward (230,100) (angle ~17°)
    // Without polyline fix, both would have angle 0° (to (200,200) and (200,100))
    g.addEdge(n1, n4);

    const faces = g.faces();
    // 1 enclosed face (the quad 0-1-2-3) + 1 outer face (non-simple, includes dead-end n4)
    expect(faces.length).toBe(2);
    const simpleFaces = faces.filter(f => f.length === new Set(f).size);
    expect(simpleFaces.length).toBe(1);
    expect(simpleFaces[0].length).toBe(4); // the quad
  });

});
