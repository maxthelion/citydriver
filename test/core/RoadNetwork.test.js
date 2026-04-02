import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoadNetwork } from '../../src/core/RoadNetwork.js';
import { RoadWay, _resetRoadWayIds } from '../../src/core/RoadWay.js';
import { _resetRoadNodeIds } from '../../src/core/RoadNode.js';

const W = 20;
const H = 20;
const CS = 10;
const OX = 0;
const OZ = 0;

function makeNetwork() {
  return new RoadNetwork(W, H, CS, OX, OZ);
}

beforeEach(() => {
  _resetRoadWayIds();
  _resetRoadNodeIds();
});

describe('RoadNetwork add()', () => {
  it('returns a RoadWay and increments wayCount', () => {
    const net = makeNetwork();
    const way = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
    expect(way).toBeInstanceOf(RoadWay);
    expect(net.wayCount).toBe(1);
  });

  it('stamps roadGrid and derives a simple graph edge', () => {
    const net = makeNetwork();
    net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    expect(net.roadGrid.get(0, 0)).toBe(1);
    expect(net.graph.nodes.size).toBe(2);
    expect(net.graph.edges.size).toBe(1);
  });

  it('reuses a nearby endpoint node across ways', () => {
    const net = makeNetwork();
    const a = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    const b = net.add([{ x: 52, z: 0 }, { x: 100, z: 0 }]);

    expect(net.nodes.length).toBe(3);
    expect(a.nodes[a.nodes.length - 1].id).toBe(b.nodes[0].id);
  });

  it('preserves the roadGrid object identity while rebuilding derived state', () => {
    const net = makeNetwork();
    const roadGrid = net.roadGrid;

    net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);

    expect(net.roadGrid).toBe(roadGrid);
    expect(roadGrid.get(0, 0)).toBe(1);
  });
});

describe('RoadNetwork remove()', () => {
  it('removes a way and rebuilds derived state', () => {
    const net = makeNetwork();
    const way = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    net.remove(way.id);

    expect(net.wayCount).toBe(0);
    expect(net.graph.nodes.size).toBe(0);
    expect(net.graph.edges.size).toBe(0);
    expect(net.roadGrid.get(0, 0)).toBe(0);
  });

  it('preserves shared coverage when removing one overlapping way', () => {
    const net = makeNetwork();
    const a = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);
    net.add([{ x: 0, z: 0 }, { x: 0, z: 50 }]);

    net.remove(a.id);
    expect(net.roadGrid.get(0, 0)).toBe(1);
  });
});

describe('RoadNetwork tentative()', () => {
  it('skips derived rebuild when a tentative mutation rolls back completely', () => {
    const net = makeNetwork();
    net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);

    const spy = vi.spyOn(net, 'rebuildDerived');
    const beforeWayCount = net.wayCount;
    const beforeNodeCount = net.nodes.length;

    net.tentative(({ discardDerivedRefresh }) => {
      const way = net.add([{ x: 0, z: 20 }, { x: 50, z: 20 }]);
      net.remove(way.id);
      discardDerivedRefresh();
    });

    expect(spy).not.toHaveBeenCalled();
    expect(net.wayCount).toBe(beforeWayCount);
    expect(net.nodes.length).toBe(beforeNodeCount);
  });
});

describe('RoadNetwork addFromCells()', () => {
  it('converts cells to world points', () => {
    const net = makeNetwork();
    const way = net.addFromCells([{ gx: 2, gz: 3 }, { gx: 7, gz: 3 }]);

    expect(way.start).toEqual({ x: 20, z: 30 });
    expect(way.end).toEqual({ x: 70, z: 30 });
  });

  it('returns null for fewer than two cells', () => {
    const net = makeNetwork();
    expect(net.addFromCells([{ gx: 0, gz: 0 }])).toBeNull();
  });
});

describe('RoadNetwork addBridge()', () => {
  it('records the bridge on the way and stamps bridgeGrid', () => {
    const net = makeNetwork();
    const way = net.add([{ x: 0, z: 0 }, { x: 100, z: 0 }]);

    net.addBridge(way.id, { x: 30, z: 0 }, { x: 50, z: 0 }, 0.3, 0.5);

    expect(net.getWay(way.id).bridges).toHaveLength(1);
    expect(net.bridgeGrid.get(4, 0)).toBe(1);
  });
});

describe('RoadNetwork replaceWayPolyline()', () => {
  it('replaces geometry and clears stale roadGrid stamps', () => {
    const net = makeNetwork();
    const way = net.add([{ x: 0, z: 0 }, { x: 50, z: 0 }]);

    expect(net.roadGrid.get(3, 0)).toBe(1);

    net.replaceWayPolyline(way.id, [{ x: 0, z: 10 }, { x: 0, z: 100 }]);

    expect(net.getWay(way.id).end).toEqual({ x: 0, z: 100 });
    expect(net.roadGrid.get(3, 0)).toBe(0);
    expect(net.roadGrid.get(0, 5)).toBe(1);
  });
});

describe('RoadNetwork connectWaysAtPoint()', () => {
  it('inserts a shared node on both ways and rebuilds graph topology', () => {
    const net = makeNetwork();
    const horizontal = net.add([{ x: 0, z: 50 }, { x: 100, z: 50 }]);
    const vertical = net.add([{ x: 50, z: 0 }, { x: 50, z: 100 }]);

    const nodeId = net.connectWaysAtPoint(horizontal.id, vertical.id, 50, 50);

    expect(nodeId).not.toBeNull();
    expect(net.graph.nodes.size).toBe(5);
    expect(net.graph.edges.size).toBe(4);
    expect(net.graph.degree(nodeId)).toBe(4);

    const horizontalNodeIds = net.getWay(horizontal.id).nodes.map(node => node.id);
    const verticalNodeIds = net.getWay(vertical.id).nodes.map(node => node.id);
    expect(horizontalNodeIds).toContain(nodeId);
    expect(verticalNodeIds).toContain(nodeId);
  });
});

describe('RoadNetwork mergeNodes()', () => {
  it('rewrites way references onto a kept shared node and rebuilds topology', () => {
    const net = makeNetwork();
    const spine = net.add([{ x: 0, z: 50 }, { x: 100, z: 50 }]);
    const branch = net.add([{ x: 45, z: 0 }, { x: 45, z: 52 }]);

    const splitNodeId = net.ensureNodeOnWay(spine.id, 50, 50);
    const branchEndId = branch.nodes[branch.nodes.length - 1].id;

    expect(splitNodeId).not.toBe(branchEndId);

    const mergedId = net.mergeNodes(splitNodeId, branchEndId);

    expect(mergedId).toBe(splitNodeId);
    expect(net.getWay(branch.id).nodes[net.getWay(branch.id).nodes.length - 1].id).toBe(splitNodeId);
    expect(net.graph.degree(splitNodeId)).toBe(3);
    expect(net.nodes.some(node => node.id === branchEndId)).toBe(false);
  });
});
