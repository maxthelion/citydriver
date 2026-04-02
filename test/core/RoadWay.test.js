import { beforeEach, describe, expect, it } from 'vitest';
import { RoadWay, _resetRoadWayIds } from '../../src/core/RoadWay.js';
import { RoadNode, _resetRoadNodeIds } from '../../src/core/RoadNode.js';

function makeNode(x, z) {
  return new RoadNode(x, z);
}

function makeWay(polyline, options = {}) {
  return RoadWay.fromPolyline(polyline, options, makeNode);
}

beforeEach(() => {
  _resetRoadWayIds();
  _resetRoadNodeIds();
});

describe('RoadWay', () => {
  it('assigns incrementing ids', () => {
    const a = makeWay([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const b = makeWay([{ x: 0, z: 0 }, { x: 2, z: 0 }]);
    expect(a.id).toBe(0);
    expect(b.id).toBe(1);
  });

  it('exposes start, end, and polyline from nodes', () => {
    const way = makeWay([{ x: 1, z: 2 }, { x: 5, z: 6 }, { x: 9, z: 10 }]);
    expect(way.start).toEqual({ x: 1, z: 2 });
    expect(way.end).toEqual({ x: 9, z: 10 });
    expect(way.polyline).toEqual([{ x: 1, z: 2 }, { x: 5, z: 6 }, { x: 9, z: 10 }]);
  });

  it('applies default metadata', () => {
    const way = makeWay([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(way.width).toBe(6);
    expect(way.hierarchy).toBe('local');
    expect(way.importance).toBe(0.45);
    expect(way.source).toBeUndefined();
  });

  it('accepts custom metadata', () => {
    const way = makeWay([{ x: 0, z: 0 }, { x: 10, z: 0 }], {
      width: 12,
      hierarchy: 'arterial',
      importance: 0.9,
      source: 'test',
    });
    expect(way.width).toBe(12);
    expect(way.hierarchy).toBe('arterial');
    expect(way.importance).toBe(0.9);
    expect(way.source).toBe('test');
  });

  it('stores bridge data defensively', () => {
    const way = makeWay([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const bankA = { x: 2, z: -1 };
    const bankB = { x: 5, z: 1 };
    way.addBridge(bankA, bankB, 0.2, 0.5);

    bankA.x = 99;
    expect(way.bridges[0]).toEqual({
      bankA: { x: 2, z: -1 },
      bankB: { x: 5, z: 1 },
      entryT: 0.2,
      exitT: 0.5,
    });
  });

  it('can resolve bridges into a derived polyline', () => {
    const way = makeWay([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    way.addBridge({ x: 3, z: -2 }, { x: 5, z: 2 }, 0.3, 0.5);

    const resolved = way.resolvedPolyline();
    expect(resolved.some(p => p.x === 3 && p.z === -2)).toBe(true);
    expect(resolved.some(p => p.x === 5 && p.z === 2)).toBe(true);
    expect(resolved[0]).toEqual({ x: 0, z: 0 });
    expect(resolved[resolved.length - 1]).toEqual({ x: 10, z: 0 });
  });

  it('can replace its node sequence', () => {
    const way = makeWay([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    way.replaceNodes([makeNode(0, 0), makeNode(10, 10)]);
    expect(way.end).toEqual({ x: 10, z: 10 });
  });

  it('round-trips through JSON', () => {
    const way = makeWay([{ x: 0, z: 0 }, { x: 10, z: 5 }], {
      width: 8,
      hierarchy: 'arterial',
      importance: 0.7,
      source: 'test',
    });
    way.addBridge({ x: 3, z: -1 }, { x: 4, z: 1 }, 0.2, 0.4);

    const copy = RoadWay.fromJSON(way.toJSON());

    expect(copy.id).toBe(way.id);
    expect(copy.polyline).toEqual(way.polyline);
    expect(copy.width).toBe(8);
    expect(copy.hierarchy).toBe('arterial');
    expect(copy.importance).toBe(0.7);
    expect(copy.source).toBe('test');
    expect(copy.bridges).toHaveLength(1);
  });
});
