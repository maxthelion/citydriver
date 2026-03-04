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
});
