import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RoadNetwork } from '../../src/core/RoadNetwork.js';
import { Road, _resetRoadIds } from '../../src/core/Road.js';

// Small 20x20 grid with cellSize=10 for tests
const W = 20;
const H = 20;
const CS = 10;
const OX = 0;
const OZ = 0;

function makeNetwork() {
  return new RoadNetwork(W, H, CS, OX, OZ);
}

// A simple horizontal road from (0,0) to (100,0)
const POLY_HORIZONTAL = [{ x: 0, z: 0 }, { x: 100, z: 0 }];

// A simple vertical road from (0,0) to (0,100)
const POLY_VERTICAL = [{ x: 0, z: 0 }, { x: 0, z: 100 }];

beforeEach(() => {
  _resetRoadIds();
});

// ────────────────────────────────────────────────────────────────────────────
// add()
// ────────────────────────────────────────────────────────────────────────────

describe('add() — returns a Road with an id; increments roadCount', () => {
  it('returns a Road instance', () => {
    const net = makeNetwork();
    const road = net.add(POLY_HORIZONTAL);
    expect(road).toBeInstanceOf(Road);
  });

  it('returned road has a numeric id', () => {
    const net = makeNetwork();
    const road = net.add(POLY_HORIZONTAL);
    expect(typeof road.id).toBe('number');
  });

  it('roadCount starts at 0', () => {
    const net = makeNetwork();
    expect(net.roadCount).toBe(0);
  });

  it('increments roadCount after add()', () => {
    const net = makeNetwork();
    net.add(POLY_HORIZONTAL);
    expect(net.roadCount).toBe(1);
    net.add(POLY_VERTICAL);
    expect(net.roadCount).toBe(2);
  });
});

describe('add() — stamps roadGrid cells along polyline', () => {
  it('stamps at least one cell on the roadGrid', () => {
    const net = makeNetwork();
    net.add(POLY_HORIZONTAL);
    let stamped = 0;
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        if (net.roadGrid.get(gx, gz) > 0) stamped++;
      }
    }
    expect(stamped).toBeGreaterThan(0);
  });

  it('stamps the center cell for a short horizontal road', () => {
    const net = makeNetwork();
    // Road from (50,50) to (90,50) — center at gx=7 gz=5 roughly
    net.add([{ x: 50, z: 50 }, { x: 90, z: 50 }]);
    // Cell (5,5) is at world (50,50)
    expect(net.roadGrid.get(5, 5)).toBe(1);
  });

  it('leaves unstamped cells at 0', () => {
    const net = makeNetwork();
    // Road along x-axis only, should leave top-right corner clear
    net.add([{ x: 0, z: 0 }, { x: 30, z: 0 }]);
    // Cell (19, 19) is far from the road
    expect(net.roadGrid.get(19, 19)).toBe(0);
  });
});

describe('add() — adds edge to graph (1 edge, 2 nodes)', () => {
  it('adds exactly 2 nodes to the graph for a simple two-point road', () => {
    const net = makeNetwork();
    net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    expect(net.graph.nodes.size).toBe(2);
  });

  it('adds exactly 1 edge to the graph for a simple two-point road', () => {
    const net = makeNetwork();
    net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    expect(net.graph.edges.size).toBe(1);
  });

  it('two non-overlapping roads produce 4 nodes and 2 edges', () => {
    const net = makeNetwork();
    net.add([{ x: 0, z: 0 }, { x: 40, z: 0 }]);
    net.add([{ x: 0, z: 50 }, { x: 40, z: 50 }]);
    expect(net.graph.nodes.size).toBe(4);
    expect(net.graph.edges.size).toBe(2);
  });
});

describe('add() — snaps graph nodes within cellSize * 3', () => {
  it('reuses a node when a new road starts within snapDist of existing node', () => {
    const net = makeNetwork();
    // First road ends at (50,0)
    net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    // Second road starts at (52,0) — within cellSize*3=30 of (50,0)
    net.add([{ x: 52, z: 0 }, { x: 100, z: 0 }]);
    // Should share a node — so only 3 unique nodes total
    expect(net.graph.nodes.size).toBe(3);
  });

  it('does NOT snap when the road start is beyond snapDist', () => {
    const net = makeNetwork();
    // First road ends at (50,0)
    net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    // Second road starts at (90,0) — well beyond cellSize*3=30 from (50,0)
    net.add([{ x: 90, z: 0 }, { x: 150, z: 0 }]);
    // No snapping — should have 4 distinct nodes
    expect(net.graph.nodes.size).toBe(4);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// roads accessor + getRoad()
// ────────────────────────────────────────────────────────────────────────────

describe('roads accessor returns all roads', () => {
  it('returns empty array when no roads added', () => {
    const net = makeNetwork();
    expect(net.roads).toEqual([]);
  });

  it('returns all added roads', () => {
    const net = makeNetwork();
    const r1 = net.add(POLY_HORIZONTAL);
    const r2 = net.add(POLY_VERTICAL);
    const roads = net.roads;
    expect(roads).toHaveLength(2);
    expect(roads.map(r => r.id)).toContain(r1.id);
    expect(roads.map(r => r.id)).toContain(r2.id);
  });

  it('roads accessor returns a Road[] (instances of Road)', () => {
    const net = makeNetwork();
    net.add(POLY_HORIZONTAL);
    expect(net.roads[0]).toBeInstanceOf(Road);
  });
});

describe('getRoad(id) retrieves by id', () => {
  it('returns the correct Road for a valid id', () => {
    const net = makeNetwork();
    const road = net.add(POLY_HORIZONTAL);
    expect(net.getRoad(road.id)).toBe(road);
  });

  it('returns undefined for an unknown id', () => {
    const net = makeNetwork();
    expect(net.getRoad(9999)).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// remove()
// ────────────────────────────────────────────────────────────────────────────

describe('remove() — removes road from collection', () => {
  it('reduces roadCount by 1', () => {
    const net = makeNetwork();
    const road = net.add(POLY_HORIZONTAL);
    net.remove(road.id);
    expect(net.roadCount).toBe(0);
  });

  it('road is no longer in roads array after remove', () => {
    const net = makeNetwork();
    const road = net.add(POLY_HORIZONTAL);
    net.remove(road.id);
    expect(net.roads.find(r => r.id === road.id)).toBeUndefined();
  });

  it('getRoad returns undefined after remove', () => {
    const net = makeNetwork();
    const road = net.add(POLY_HORIZONTAL);
    net.remove(road.id);
    expect(net.getRoad(road.id)).toBeUndefined();
  });
});

describe('remove() — clears roadGrid when ref count reaches 0', () => {
  it('previously stamped cells become 0 after sole road is removed', () => {
    const net = makeNetwork();
    // Road at z=0 — cells along gx=0..5 gz=0 should be stamped
    const road = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    // Verify stamped
    expect(net.roadGrid.get(0, 0)).toBe(1);
    net.remove(road.id);
    // Now should be cleared
    expect(net.roadGrid.get(0, 0)).toBe(0);
  });
});

describe('remove() — preserves roadGrid for shared cells (two overlapping roads, remove one)', () => {
  it('shared cells remain stamped after one road removed', () => {
    const net = makeNetwork();
    // Both roads pass through (0,0)
    const r1 = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    const r2 = net.add([{ x: 0, z: 0 }, { x: 0, z: 50 }]);
    expect(net.roadGrid.get(0, 0)).toBe(1);
    net.remove(r1.id);
    // r2 still covers (0,0) so cell should remain stamped
    expect(net.roadGrid.get(0, 0)).toBe(1);
  });
});

describe('remove() — removes graph edge', () => {
  it('graph has 0 edges after adding and removing one road', () => {
    const net = makeNetwork();
    const road = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    net.remove(road.id);
    expect(net.graph.edges.size).toBe(0);
  });

  it('orphaned nodes are cleaned up after remove', () => {
    const net = makeNetwork();
    const road = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    net.remove(road.id);
    expect(net.graph.nodes.size).toBe(0);
  });
});

describe('remove() — is no-op for unknown id', () => {
  it('does not throw for unknown id', () => {
    const net = makeNetwork();
    expect(() => net.remove(9999)).not.toThrow();
  });

  it('roadCount unchanged after no-op remove', () => {
    const net = makeNetwork();
    net.add(POLY_HORIZONTAL);
    net.remove(9999);
    expect(net.roadCount).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// addFromCells()
// ────────────────────────────────────────────────────────────────────────────

describe('addFromCells() — converts cells to world polyline, adds road', () => {
  it('returns a Road', () => {
    const net = makeNetwork();
    const road = net.addFromCells([{ gx: 0, gz: 0 }, { gx: 5, gz: 0 }]);
    expect(road).toBeInstanceOf(Road);
  });

  it('converts grid coords to world coords correctly', () => {
    const net = makeNetwork();
    const road = net.addFromCells([{ gx: 2, gz: 3 }, { gx: 7, gz: 3 }]);
    // World: x = OX + gx * CS = 0 + 2*10 = 20, z = 0 + 3*10 = 30
    expect(road.start).toEqual({ x: 20, z: 30 });
    expect(road.end).toEqual({ x: 70, z: 30 });
  });
});

describe('addFromCells() — returns null for < 2 cells', () => {
  it('returns null for empty cells array', () => {
    const net = makeNetwork();
    expect(net.addFromCells([])).toBeNull();
  });

  it('returns null for single cell', () => {
    const net = makeNetwork();
    expect(net.addFromCells([{ gx: 0, gz: 0 }])).toBeNull();
  });
});

describe('addFromCells() — stamps grid and adds graph edge', () => {
  it('stamps roadGrid after addFromCells', () => {
    const net = makeNetwork();
    net.addFromCells([{ gx: 0, gz: 0 }, { gx: 5, gz: 0 }]);
    expect(net.roadGrid.get(0, 0)).toBe(1);
  });

  it('adds a graph edge after addFromCells', () => {
    const net = makeNetwork();
    net.addFromCells([{ gx: 0, gz: 0 }, { gx: 5, gz: 0 }]);
    expect(net.graph.edges.size).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// addBridge()
// ────────────────────────────────────────────────────────────────────────────

describe('addBridge() — records bridge on road', () => {
  it('bridge is stored on the road', () => {
    const net = makeNetwork();
    const road = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    net.addBridge(road.id, { x: 30, z: -5 }, { x: 50, z: 5 }, 0.3, 0.5);
    expect(road.bridges).toHaveLength(1);
    expect(road.bridges[0].entryT).toBe(0.3);
    expect(road.bridges[0].exitT).toBe(0.5);
  });

  it('stamps bridgeGrid between bankA and bankB', () => {
    const net = makeNetwork();
    const road = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    // bankA at (30,0), bankB at (50,0) — bridge along x-axis
    net.addBridge(road.id, { x: 30, z: 0 }, { x: 50, z: 0 }, 0.3, 0.5);
    // Cell at gx=4 gz=0 (x=40,z=0) should be stamped in bridgeGrid
    expect(net.bridgeGrid.get(4, 0)).toBe(1);
  });
});

describe('addBridge() — is no-op for unknown roadId', () => {
  it('does not throw for unknown roadId', () => {
    const net = makeNetwork();
    expect(() => net.addBridge(9999, { x: 0, z: 0 }, { x: 10, z: 0 }, 0, 1)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updatePolyline()
// ────────────────────────────────────────────────────────────────────────────

describe('updatePolyline() — changes road polyline and re-stamps grid', () => {
  it("road's polyline is updated", () => {
    const net = makeNetwork();
    const road = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    const newPoly = [{ x: 0, z: 0 }, { x: 50, z: 50 }];
    net.updatePolyline(road.id, newPoly);
    expect(road.end).toEqual({ x: 50, z: 50 });
  });

  it('old cells are cleared and new cells are stamped', () => {
    const net = makeNetwork();
    // Road along z=0 axis
    const road = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    // gx=3 gz=0 should be stamped by horizontal road
    expect(net.roadGrid.get(3, 0)).toBe(1);
    // Update to a vertical road that doesn't cover z=0 beyond origin
    net.updatePolyline(road.id, [{ x: 0, z: 10 }, { x: 0, z: 100 }]);
    // gx=3 gz=0 should now be cleared (no other road covers it)
    expect(net.roadGrid.get(3, 0)).toBe(0);
    // gx=0 gz=5 should now be stamped (z=50 world = gz=5)
    expect(net.roadGrid.get(0, 5)).toBe(1);
  });

  it('graph edge reflects updated endpoints', () => {
    const net = makeNetwork();
    const road = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    net.updatePolyline(road.id, [{ x: 10, z: 10 }, { x: 80, z: 80 }]);
    expect(net.graph.edges.size).toBe(1);
  });
});
