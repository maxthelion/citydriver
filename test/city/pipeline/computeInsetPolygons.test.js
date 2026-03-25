import { describe, it, expect } from 'vitest';
import { computeInsetPolygons } from '../../../src/city/pipeline/computeInsetPolygons.js';
import { PlanarGraph } from '../../../src/core/PlanarGraph.js';
import { computeSignedArea } from '../../../src/core/polygonInset.js';

/**
 * Build a minimal mock FeatureMap with a single zone inside a rectangle of roads.
 *
 *   n0 (0,0) ── e0 (road, w=10) ── n1 (200,0)
 *    |                                  |
 *   e3 (road, w=6)                     e1 (road, w=6)
 *    |                                  |
 *   n3 (0,100) ── e2 (road, w=10) ── n2 (200,100)
 *
 * Zone polygon sits just inside the rectangle.
 */
function makeMapWithRoadZone() {
  const graph = new PlanarGraph();
  const n0 = graph.addNode(0, 0);
  const n1 = graph.addNode(200, 0);
  const n2 = graph.addNode(200, 100);
  const n3 = graph.addNode(0, 100);

  const e0 = graph.addEdge(n0, n1, { width: 10, hierarchy: 'arterial' });
  const e1 = graph.addEdge(n1, n2, { width: 6, hierarchy: 'local' });
  const e2 = graph.addEdge(n3, n2, { width: 10, hierarchy: 'collector' });
  const e3 = graph.addEdge(n0, n3, { width: 6, hierarchy: 'local' });

  // Zone polygon: just inside the road rectangle (offset by ~3m)
  const polygon = [
    { x: 3, z: 3 },
    { x: 197, z: 3 },
    { x: 197, z: 97 },
    { x: 3, z: 97 },
  ];

  const zone = {
    id: 1,
    polygon,
    boundingEdgeIds: [e0, e1, e2, e3],
    boundingNodeIds: [n0, n1, n2, n3],
  };

  return {
    graph,
    cellSize: 5,
    developmentZones: [zone],
  };
}

/**
 * Build a map where one side is a road and another is water.
 *
 *   n0 (0,0) ── e0 (road, w=8) ── n1 (100,0)
 *    |                                |
 *   e2 (water)                       e1 (boundary)
 *    |                                |
 *   n3 (0,100) ────────────────── n2 (100,100)
 *                   (no edge — shared zone boundary)
 */
function makeMapWithMixedEdges() {
  const graph = new PlanarGraph();
  const n0 = graph.addNode(0, 0);
  const n1 = graph.addNode(100, 0);
  const n2 = graph.addNode(100, 100);
  const n3 = graph.addNode(0, 100);

  const e0 = graph.addEdge(n0, n1, { width: 8, hierarchy: 'collector' });
  const e1 = graph.addEdge(n1, n2, { width: 6, hierarchy: 'local', type: 'boundary' });
  const e2 = graph.addEdge(n0, n3, { width: 6, hierarchy: 'local', type: 'water' });

  // Zone polygon sits just inside
  const polygon = [
    { x: 3, z: 3 },
    { x: 97, z: 3 },
    { x: 97, z: 97 },
    { x: 3, z: 97 },
  ];

  const zone = {
    id: 1,
    polygon,
    boundingEdgeIds: [e0, e1, e2],
    boundingNodeIds: [n0, n1, n2, n3],
  };

  return {
    graph,
    cellSize: 5,
    developmentZones: [zone],
  };
}

describe('computeInsetPolygons', () => {
  it('computes inset polygon for a zone bounded by roads', () => {
    const map = makeMapWithRoadZone();
    computeInsetPolygons(map);

    const zone = map.developmentZones[0];
    expect(zone.insetPolygon).toBeDefined();
    expect(zone.insetPolygon.length).toBe(4);

    // The inset polygon should be smaller than the original
    const origArea = Math.abs(computeSignedArea(zone.polygon));
    const insetArea = Math.abs(computeSignedArea(zone.insetPolygon));
    expect(insetArea).toBeLessThan(origArea);
    expect(insetArea).toBeGreaterThan(0);
  });

  it('applies different inset distances for road vs water vs boundary edges', () => {
    const map = makeMapWithMixedEdges();
    computeInsetPolygons(map);

    const zone = map.developmentZones[0];
    expect(zone.insetPolygon).toBeDefined();
    expect(zone.insetPolygon.length).toBe(4);

    // The inset polygon should be valid and smaller
    const origArea = Math.abs(computeSignedArea(zone.polygon));
    const insetArea = Math.abs(computeSignedArea(zone.insetPolygon));
    expect(insetArea).toBeLessThan(origArea);
    expect(insetArea).toBeGreaterThan(0);
  });

  it('handles zone with no bounding edges gracefully', () => {
    const map = {
      graph: new PlanarGraph(),
      cellSize: 5,
      developmentZones: [{
        id: 1,
        polygon: [
          { x: 0, z: 0 },
          { x: 100, z: 0 },
          { x: 100, z: 100 },
          { x: 0, z: 100 },
        ],
        boundingEdgeIds: [],
        boundingNodeIds: [],
      }],
    };

    computeInsetPolygons(map);

    const zone = map.developmentZones[0];
    // With no bounding edges, all distances are 0, so inset polygon = original
    expect(zone.insetPolygon.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(zone.insetPolygon[i].x).toBeCloseTo(zone.polygon[i].x, 6);
      expect(zone.insetPolygon[i].z).toBeCloseTo(zone.polygon[i].z, 6);
    }
  });

  it('handles zone with degenerate polygon', () => {
    const map = {
      graph: new PlanarGraph(),
      cellSize: 5,
      developmentZones: [{
        id: 1,
        polygon: [{ x: 0, z: 0 }],
        boundingEdgeIds: [],
      }],
    };

    computeInsetPolygons(map);

    const zone = map.developmentZones[0];
    expect(zone.insetPolygon).toEqual([]);
  });

  it('handles empty zones array', () => {
    const map = {
      graph: new PlanarGraph(),
      cellSize: 5,
      developmentZones: [],
    };

    // Should not throw
    computeInsetPolygons(map);
  });

  it('handles null/undefined zones', () => {
    const map = {
      graph: new PlanarGraph(),
      cellSize: 5,
      developmentZones: null,
    };

    // Should not throw
    computeInsetPolygons(map);
  });

  it('handles map with no graph', () => {
    const map = {
      graph: null,
      cellSize: 5,
      developmentZones: [{
        id: 1,
        polygon: [
          { x: 0, z: 0 },
          { x: 100, z: 0 },
          { x: 100, z: 100 },
          { x: 0, z: 100 },
        ],
        boundingEdgeIds: [1, 2],
      }],
    };

    computeInsetPolygons(map);

    const zone = map.developmentZones[0];
    // No graph → all distances 0 → inset = original
    expect(zone.insetPolygon.length).toBe(4);
  });

  it('road inset includes half-width + sidewalk buffer', () => {
    // Single zone with a single matching road edge on one side
    const graph = new PlanarGraph();
    const n0 = graph.addNode(0, 0);
    const n1 = graph.addNode(100, 0);

    const roadWidth = 12;
    const e0 = graph.addEdge(n0, n1, { width: roadWidth, hierarchy: 'arterial' });

    // Zone polygon: bottom edge is near the road
    // Other three edges have no matching graph edge → distance = 0
    const polygon = [
      { x: 5, z: 2 },
      { x: 95, z: 2 },
      { x: 95, z: 80 },
      { x: 5, z: 80 },
    ];

    const map = {
      graph,
      cellSize: 5,
      developmentZones: [{
        id: 1,
        polygon,
        boundingEdgeIds: [e0],
      }],
    };

    computeInsetPolygons(map);

    const zone = map.developmentZones[0];
    expect(zone.insetPolygon.length).toBe(4);

    // The bottom edge (edge 0, between polygon[0] and polygon[1]) should be
    // inset by roadWidth/2 + 2 = 8m from the road side.
    // Top and sides have no matching edge → inset = 0.
    // So bottom vertices should have z ≈ 2 + 8 = 10,
    // while top vertices remain at z ≈ 80.
    const bottomVerts = zone.insetPolygon.filter(p => p.z < 50);
    const topVerts = zone.insetPolygon.filter(p => p.z >= 50);

    expect(bottomVerts.length).toBe(2);
    expect(topVerts.length).toBe(2);

    // Bottom edge shifted inward (upward in z) by roadWidth/2 + 2 = 8
    for (const v of bottomVerts) {
      expect(v.z).toBeCloseTo(2 + roadWidth / 2 + 2, 0);
    }
    // Top edge unchanged (inset = 0)
    for (const v of topVerts) {
      expect(v.z).toBeCloseTo(80, 0);
    }
  });
});
