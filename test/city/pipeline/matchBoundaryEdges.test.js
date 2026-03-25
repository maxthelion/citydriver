import { describe, it, expect } from 'vitest';
import { matchBoundaryToGraphEdges } from '../../../src/city/pipeline/matchBoundaryEdges.js';
import { PlanarGraph } from '../../../src/core/PlanarGraph.js';

/**
 * Build a simple graph: a rectangle with 4 nodes and 4 edges.
 *
 *   n0 (0,0) ── e0 ── n1 (100,0)
 *    |                    |
 *   e3                   e1
 *    |                    |
 *   n3 (0,100) ── e2 ── n2 (100,100)
 */
function makeRectGraph() {
  const g = new PlanarGraph();
  const n0 = g.addNode(0, 0);
  const n1 = g.addNode(100, 0);
  const n2 = g.addNode(100, 100);
  const n3 = g.addNode(0, 100);

  const e0 = g.addEdge(n0, n1, { width: 6, hierarchy: 'local' }); // top
  const e1 = g.addEdge(n1, n2, { width: 6, hierarchy: 'local' }); // right
  const e2 = g.addEdge(n3, n2, { width: 6, hierarchy: 'local' }); // bottom
  const e3 = g.addEdge(n0, n3, { width: 6, hierarchy: 'local' }); // left

  return { graph: g, nodes: [n0, n1, n2, n3], edges: [e0, e1, e2, e3] };
}

describe('matchBoundaryToGraphEdges', () => {
  it('matches a polygon that closely follows graph edges', () => {
    const { graph, edges } = makeRectGraph();

    // A polygon that sits just inside the rectangle (offset by 5 units)
    const polygon = [
      { x: 5, z: 5 },
      { x: 95, z: 5 },
      { x: 95, z: 95 },
      { x: 5, z: 95 },
    ];

    const result = matchBoundaryToGraphEdges(polygon, graph, 15);

    // All 4 edges should match — the polygon boundary is within tolerance
    expect(result.edgeIds.length).toBe(4);
    for (const eid of edges) {
      expect(result.edgeIds).toContain(eid);
    }
  });

  it('does not match edges beyond tolerance', () => {
    const { graph } = makeRectGraph();

    // A polygon far from the graph edges (centered at 50,50, radius ~10)
    const polygon = [
      { x: 40, z: 40 },
      { x: 60, z: 40 },
      { x: 60, z: 60 },
      { x: 40, z: 60 },
    ];

    // Tolerance of 5 — the closest edge is 40 units away
    const result = matchBoundaryToGraphEdges(polygon, graph, 5);
    expect(result.edgeIds.length).toBe(0);
    expect(result.nodeIds.length).toBe(0);
  });

  it('matches only nearby edges (partial match)', () => {
    const { graph, edges } = makeRectGraph();

    // A polygon near the top edge only
    const polygon = [
      { x: 20, z: 2 },
      { x: 80, z: 2 },
      { x: 80, z: 8 },
      { x: 20, z: 8 },
    ];

    // Tolerance of 10 — only the top edge (e0) should match
    const result = matchBoundaryToGraphEdges(polygon, graph, 10);
    expect(result.edgeIds).toContain(edges[0]); // top edge
    // Bottom edge (e2) should NOT match (it's at z=100)
    expect(result.edgeIds).not.toContain(edges[2]);
  });

  it('returns empty arrays for degenerate polygon', () => {
    const { graph } = makeRectGraph();

    expect(matchBoundaryToGraphEdges([], graph, 15)).toEqual({ edgeIds: [], nodeIds: [] });
    expect(matchBoundaryToGraphEdges(null, graph, 15)).toEqual({ edgeIds: [], nodeIds: [] });
    expect(matchBoundaryToGraphEdges([{ x: 0, z: 0 }], graph, 15)).toEqual({ edgeIds: [], nodeIds: [] });
  });

  it('collects node IDs from matched edges', () => {
    const { graph, nodes, edges } = makeRectGraph();

    // Polygon near the top edge
    const polygon = [
      { x: 20, z: 2 },
      { x: 80, z: 2 },
      { x: 80, z: 8 },
      { x: 20, z: 8 },
    ];

    const result = matchBoundaryToGraphEdges(polygon, graph, 10);
    // The top edge connects n0 and n1
    expect(result.nodeIds).toContain(nodes[0]);
    expect(result.nodeIds).toContain(nodes[1]);
  });

  it('matches edges with intermediate polyline points', () => {
    const g = new PlanarGraph();
    const n0 = g.addNode(0, 0);
    const n1 = g.addNode(100, 0);

    // Edge with a curve that dips to z=-20 at the midpoint
    const e0 = g.addEdge(n0, n1, {
      points: [{ x: 30, z: -20 }, { x: 70, z: -20 }],
      width: 6,
      hierarchy: 'local',
    });

    // Polygon near the curved part of the edge
    const polygon = [
      { x: 30, z: -18 },
      { x: 70, z: -18 },
      { x: 70, z: -22 },
      { x: 30, z: -22 },
    ];

    const result = matchBoundaryToGraphEdges(polygon, g, 10);
    expect(result.edgeIds).toContain(e0);
  });

  it('handles graph with no edges', () => {
    const g = new PlanarGraph();
    g.addNode(0, 0);

    const polygon = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
    ];

    const result = matchBoundaryToGraphEdges(polygon, g, 15);
    expect(result.edgeIds).toEqual([]);
    expect(result.nodeIds).toEqual([]);
  });
});
