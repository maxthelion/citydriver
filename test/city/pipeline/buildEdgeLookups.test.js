import { describe, it, expect } from 'vitest';
import { PlanarGraph } from '../../../src/core/PlanarGraph.js';
import {
  buildEdgeLookups,
  zonesAlongEdge,
  parcelsAlongEdge,
  edgeSide,
} from '../../../src/city/pipeline/buildEdgeLookups.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal map-like object with a graph and the layer-bag API.
 * Default: a horizontal edge from (0,0) to (100,0).
 */
function makeMap(graphSetup) {
  const graph = new PlanarGraph();
  if (graphSetup) {
    graphSetup(graph);
  }

  return {
    width: 40,
    height: 40,
    cellSize: 5,
    originX: 0,
    originZ: 0,
    graph,
    roadNetwork: { graph },
    developmentZones: [],
    parcels: [],
    edgeZones: null,
    edgeParcels: null,
  };
}

/**
 * Create a zone object matching the structure produced by extractDevelopmentZones.
 */
function makeZone(id, centroidGx, centroidGz, boundingEdgeIds) {
  return {
    id,
    centroidGx,
    centroidGz,
    boundingEdgeIds,
    cells: [],
  };
}

/**
 * Create a parcel object with road-type edges at given segment midpoints.
 */
function makeParcel(id, zoneId, roadSegments) {
  return {
    id,
    zoneId,
    reservationType: 1,
    cells: [],
    polygon: [],
    edges: roadSegments.map(seg => ({
      segment: seg,
      type: 'road',
    })),
    area: 100,
    frontageLength: 50,
  };
}

// ── edgeSide ─────────────────────────────────────────────────────────────────

describe('edgeSide', () => {
  it('returns "left" for a point to the left of a horizontal edge', () => {
    const graph = new PlanarGraph();
    const n0 = graph.addNode(0, 0);
    const n1 = graph.addNode(100, 0);
    const eid = graph.addEdge(n0, n1);

    // Point above the edge (positive z is "down" in screen, but cross product
    // uses standard math). Edge goes (0,0)→(100,0), direction=(100,0).
    // Point at (50, -10): vector from start = (50,-10).
    // Cross = 100*(-10) - 0*50 = -1000 → right
    expect(edgeSide(graph, eid, 50, -10)).toBe('right');

    // Point at (50, 10): vector from start = (50,10).
    // Cross = 100*10 - 0*50 = 1000 → left
    expect(edgeSide(graph, eid, 50, 10)).toBe('left');
  });

  it('returns "left" for a point on the edge line (cross >= 0)', () => {
    const graph = new PlanarGraph();
    const n0 = graph.addNode(0, 0);
    const n1 = graph.addNode(100, 0);
    const eid = graph.addEdge(n0, n1);

    // Point on the edge itself
    expect(edgeSide(graph, eid, 50, 0)).toBe('left');
  });

  it('correctly determines side for a diagonal edge', () => {
    const graph = new PlanarGraph();
    const n0 = graph.addNode(0, 0);
    const n1 = graph.addNode(100, 100);
    const eid = graph.addEdge(n0, n1);

    // Edge direction = (100, 100). Point at (0, 50):
    // Vector from start = (0, 50)
    // Cross = 100*50 - 100*0 = 5000 → left
    expect(edgeSide(graph, eid, 0, 50)).toBe('left');

    // Point at (50, 0):
    // Vector from start = (50, 0)
    // Cross = 100*0 - 100*50 = -5000 → right
    expect(edgeSide(graph, eid, 50, 0)).toBe('right');
  });
});

// ── buildEdgeLookups: edge → zone ────────────────────────────────────────────

describe('buildEdgeLookups — edgeZones', () => {
  it('two zones sharing an edge get assigned to left and right', () => {
    const map = makeMap(g => {
      // Horizontal edge from (0, 50) to (100, 50)
      const n0 = g.addNode(0, 50);
      const n1 = g.addNode(100, 50);
      g.addEdge(n0, n1); // edgeId = 0
    });

    // Zone A above the edge (centroid at grid (10, 5) → world (50, 25))
    // Zone B below the edge (centroid at grid (10, 15) → world (50, 75))
    map.developmentZones = [
      makeZone(1, 10, 5, [0]),  // centroid world: (50, 25) — above edge at z=50
      makeZone(2, 10, 15, [0]), // centroid world: (50, 75) — below edge at z=50
    ];

    buildEdgeLookups(map);

    const entry = map.edgeZones.get(0);
    expect(entry).toBeDefined();

    // Edge goes from (0,50) to (100,50), direction = (100,0).
    // Zone 1 centroid (50,25): cross = 100*25 - 0*50 > 0 → wrong, let me recalculate:
    // Vector from (0,50) to (50,25): (50, -25). Cross = 100*(-25) - 0*50 = -2500 → right
    // Vector from (0,50) to (50,75): (50, 25). Cross = 100*25 - 0*50 = 2500 → left
    expect(entry.right).toBe(1); // zone 1 is to the right (above, z < 50)
    expect(entry.left).toBe(2);  // zone 2 is to the left (below, z > 50)
  });

  it('zone with 3 bounding edges gets referenced by all three', () => {
    const map = makeMap(g => {
      // Triangle of edges
      const n0 = g.addNode(0, 0);
      const n1 = g.addNode(100, 0);
      const n2 = g.addNode(50, 100);
      g.addEdge(n0, n1); // edge 0
      g.addEdge(n1, n2); // edge 1
      g.addEdge(n2, n0); // edge 2
    });

    // Zone inside the triangle, centroid at grid (10, 6) → world (50, 30)
    map.developmentZones = [
      makeZone(1, 10, 6, [0, 1, 2]),
    ];

    buildEdgeLookups(map);

    // All three edges should reference zone 1
    expect(map.edgeZones.has(0)).toBe(true);
    expect(map.edgeZones.has(1)).toBe(true);
    expect(map.edgeZones.has(2)).toBe(true);

    // Check that zone 1 appears on some side of each edge
    for (const edgeId of [0, 1, 2]) {
      const entry = map.edgeZones.get(edgeId);
      const hasZone = entry.left === 1 || entry.right === 1;
      expect(hasZone).toBe(true);
    }
  });

  it('returns { left: null, right: null } for an edge with no zones', () => {
    const map = makeMap(g => {
      const n0 = g.addNode(0, 0);
      const n1 = g.addNode(100, 0);
      g.addEdge(n0, n1);
    });

    buildEdgeLookups(map);

    expect(zonesAlongEdge(map, 0)).toEqual({ left: null, right: null });
  });

  it('handles zones with no boundingEdgeIds gracefully', () => {
    const map = makeMap(g => {
      const n0 = g.addNode(0, 0);
      const n1 = g.addNode(100, 0);
      g.addEdge(n0, n1);
    });

    map.developmentZones = [{
      id: 1,
      centroidGx: 10,
      centroidGz: 10,
      boundingEdgeIds: [],
      cells: [],
    }];

    buildEdgeLookups(map);

    expect(map.edgeZones.size).toBe(0);
  });
});

// ── buildEdgeLookups: edge → parcel ──────────────────────────────────────────

describe('buildEdgeLookups — edgeParcels', () => {
  it('parcel with road edge matches to nearby graph edge', () => {
    const map = makeMap(g => {
      // Horizontal road edge at z=50
      const n0 = g.addNode(0, 50);
      const n1 = g.addNode(100, 50);
      g.addEdge(n0, n1); // edgeId = 0
    });

    // Parcel with a road segment near the graph edge (just below it)
    map.parcels = [
      makeParcel(1, 1, [
        [{ x: 30, z: 52 }, { x: 35, z: 52 }],
      ]),
    ];

    buildEdgeLookups(map);

    const parcels = parcelsAlongEdge(map, 0);
    expect(parcels).toContain(1);
  });

  it('parcels on different sides of an edge both get referenced', () => {
    const map = makeMap(g => {
      // Horizontal road edge at z=50
      const n0 = g.addNode(0, 50);
      const n1 = g.addNode(100, 50);
      g.addEdge(n0, n1); // edgeId = 0
    });

    // Parcel above the road
    const parcelAbove = makeParcel(1, 1, [
      [{ x: 40, z: 48 }, { x: 45, z: 48 }],
    ]);
    // Parcel below the road
    const parcelBelow = makeParcel(2, 2, [
      [{ x: 40, z: 52 }, { x: 45, z: 52 }],
    ]);

    map.parcels = [parcelAbove, parcelBelow];

    buildEdgeLookups(map);

    const parcels = parcelsAlongEdge(map, 0);
    expect(parcels).toContain(1);
    expect(parcels).toContain(2);
    expect(parcels).toHaveLength(2);
  });

  it('parcel with no road edges produces no edge→parcel entries', () => {
    const map = makeMap(g => {
      const n0 = g.addNode(0, 0);
      const n1 = g.addNode(100, 0);
      g.addEdge(n0, n1);
    });

    // Parcel with only zone-edge type boundaries
    map.parcels = [{
      id: 1,
      zoneId: 1,
      reservationType: 1,
      cells: [],
      polygon: [],
      edges: [
        { segment: [{ x: 10, z: 2 }, { x: 15, z: 2 }], type: 'zone-edge' },
      ],
      area: 100,
      frontageLength: 0,
    }];

    buildEdgeLookups(map);

    expect(map.edgeParcels.size).toBe(0);
    expect(parcelsAlongEdge(map, 0)).toEqual([]);
  });

  it('road segment too far from any graph edge is not matched', () => {
    const map = makeMap(g => {
      // Edge at z=50
      const n0 = g.addNode(0, 50);
      const n1 = g.addNode(100, 50);
      g.addEdge(n0, n1);
    });

    // Parcel road edge very far from the graph edge (tolerance = cellSize*3 = 15)
    map.parcels = [
      makeParcel(1, 1, [
        [{ x: 50, z: 200 }, { x: 55, z: 200 }],
      ]),
    ];

    buildEdgeLookups(map);

    expect(parcelsAlongEdge(map, 0)).toEqual([]);
  });
});

// ── Convenience functions ────────────────────────────────────────────────────

describe('zonesAlongEdge', () => {
  it('returns default when edgeZones is not set', () => {
    expect(zonesAlongEdge({}, 0)).toEqual({ left: null, right: null });
    expect(zonesAlongEdge({ edgeZones: null }, 0)).toEqual({ left: null, right: null });
  });
});

describe('parcelsAlongEdge', () => {
  it('returns empty array when edgeParcels is not set', () => {
    expect(parcelsAlongEdge({}, 0)).toEqual([]);
    expect(parcelsAlongEdge({ edgeParcels: null }, 0)).toEqual([]);
  });
});

// ── RoadNetwork convenience methods ──────────────────────────────────────────

describe('RoadNetwork zonesAlongRoad / parcelsAlongRoad', () => {
  it('delegates to map.edgeZones and map.edgeParcels', async () => {
    const { RoadNetwork } = await import('../../../src/core/RoadNetwork.js');
    const rn = new RoadNetwork(20, 20, 5);

    const map = {
      edgeZones: new Map([[0, { left: 1, right: 2 }]]),
      edgeParcels: new Map([[0, [10, 20]]]),
    };

    expect(rn.zonesAlongRoad(map, 0)).toEqual({ left: 1, right: 2 });
    expect(rn.parcelsAlongRoad(map, 0)).toEqual([10, 20]);
  });

  it('returns defaults when map has no lookups', async () => {
    const { RoadNetwork } = await import('../../../src/core/RoadNetwork.js');
    const rn = new RoadNetwork(20, 20, 5);

    expect(rn.zonesAlongRoad({}, 0)).toEqual({ left: null, right: null });
    expect(rn.parcelsAlongRoad({}, 0)).toEqual([]);
    expect(rn.zonesAlongRoad(null, 0)).toEqual({ left: null, right: null });
    expect(rn.parcelsAlongRoad(null, 0)).toEqual([]);
  });
});
