import { describe, it, expect, beforeEach } from 'vitest';
import { Road, _resetRoadIds } from '../../src/core/Road.js';

beforeEach(() => {
  _resetRoadIds();
});

describe('Road — auto-incrementing ID', () => {
  it('starts at 0 after reset', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(r.id).toBe(0);
  });

  it('increments for each new Road', () => {
    const r0 = new Road([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const r1 = new Road([{ x: 0, z: 0 }, { x: 2, z: 0 }]);
    const r2 = new Road([{ x: 0, z: 0 }, { x: 3, z: 0 }]);
    expect(r0.id).toBe(0);
    expect(r1.id).toBe(1);
    expect(r2.id).toBe(2);
  });
});

describe('Road — defensive copy of polyline', () => {
  it('does not reflect mutations to the original input array', () => {
    const pts = [{ x: 0, z: 0 }, { x: 10, z: 0 }];
    const r = new Road(pts);
    pts.push({ x: 20, z: 0 });
    expect(r.polyline).toHaveLength(2);
  });

  it('does not reflect mutations to point objects in the original input', () => {
    const pts = [{ x: 0, z: 0 }, { x: 10, z: 0 }];
    const r = new Road(pts);
    pts[0].x = 999;
    expect(r.polyline[0].x).toBe(0);
  });

  it('polyline getter returns the same internal array (not a copy)', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const poly1 = r.polyline;
    const poly2 = r.polyline;
    expect(poly1).toBe(poly2);
  });
});

describe('Road — start/end getters', () => {
  it('start returns the first point', () => {
    const r = new Road([{ x: 1, z: 2 }, { x: 5, z: 6 }, { x: 9, z: 10 }]);
    expect(r.start).toEqual({ x: 1, z: 2 });
  });

  it('end returns the last point', () => {
    const r = new Road([{ x: 1, z: 2 }, { x: 5, z: 6 }, { x: 9, z: 10 }]);
    expect(r.end).toEqual({ x: 9, z: 10 });
  });
});

describe('Road — default options', () => {
  it('has default width of 6', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(r.width).toBe(6);
  });

  it('has default hierarchy of "local"', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(r.hierarchy).toBe('local');
  });

  it('has default importance of 0.45', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(r.importance).toBe(0.45);
  });

  it('has default source of undefined', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(r.source).toBeUndefined();
  });
});

describe('Road — custom options', () => {
  it('accepts custom width, hierarchy, importance, source', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }], {
      width: 12,
      hierarchy: 'arterial',
      importance: 0.9,
      source: 'test-source',
    });
    expect(r.width).toBe(12);
    expect(r.hierarchy).toBe('arterial');
    expect(r.importance).toBe(0.9);
    expect(r.source).toBe('test-source');
  });
});

describe('Road — bridges', () => {
  it('has no bridges initially', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    expect(r.bridges).toEqual([]);
  });

  it('addBridge stores parametric bridge data', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    r.addBridge({ x: 2, z: -1 }, { x: 2, z: 1 }, 0.2, 0.4);
    expect(r.bridges).toHaveLength(1);
    expect(r.bridges[0].entryT).toBe(0.2);
    expect(r.bridges[0].exitT).toBe(0.4);
    expect(r.bridges[0].bankA).toEqual({ x: 2, z: -1 });
    expect(r.bridges[0].bankB).toEqual({ x: 2, z: 1 });
  });

  it('addBridge stores defensive copies of bankA and bankB', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const bankA = { x: 2, z: -1 };
    const bankB = { x: 2, z: 1 };
    r.addBridge(bankA, bankB, 0.2, 0.4);
    bankA.x = 999;
    bankB.z = 999;
    expect(r.bridges[0].bankA.x).toBe(2);
    expect(r.bridges[0].bankB.z).toBe(1);
  });

  it('bridges getter returns a snapshot, not a live reference', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const b1 = r.bridges;
    const b2 = r.bridges;
    expect(b1).not.toBe(b2);
  });

  it('mutating the bridges snapshot does not affect the road', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    r.addBridge({ x: 2, z: -1 }, { x: 2, z: 1 }, 0.2, 0.4);
    const snap = r.bridges;
    snap.push({ fake: true });
    expect(r.bridges).toHaveLength(1);
  });
});

describe('Road — resolvedPolyline', () => {
  it('returns base polyline when no bridges', () => {
    const pts = [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 10, z: 0 }];
    const r = new Road(pts);
    expect(r.resolvedPolyline()).toEqual(pts);
  });

  it('with one bridge, bank points appear in the result', () => {
    // Road goes from (0,0) to (10,0) — total length 10
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    // bridge from t=0.3 to t=0.5 (i.e., x=3 to x=5)
    r.addBridge({ x: 3, z: -2 }, { x: 5, z: 2 }, 0.3, 0.5);
    const resolved = r.resolvedPolyline();
    // Should contain at least the base start, entry point, bankA, bankB, exit point, base end
    expect(resolved.length).toBeGreaterThan(2);
    // bankA and bankB points should appear in result
    const hasBankA = resolved.some(p => p.x === 3 && p.z === -2);
    const hasBankB = resolved.some(p => p.x === 5 && p.z === 2);
    expect(hasBankA).toBe(true);
    expect(hasBankB).toBe(true);
  });

  it('with one bridge, result starts with road start and ends with road end', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    r.addBridge({ x: 3, z: -1 }, { x: 3, z: 1 }, 0.3, 0.4);
    const resolved = r.resolvedPolyline();
    expect(resolved[0]).toEqual({ x: 0, z: 0 });
    expect(resolved[resolved.length - 1]).toEqual({ x: 10, z: 0 });
  });
});

describe('Road — _replacePolyline', () => {
  it('replaces the internal polyline', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    r._replacePolyline([{ x: 0, z: 0 }, { x: 5, z: 5 }, { x: 10, z: 10 }]);
    expect(r.polyline).toHaveLength(3);
    expect(r.end).toEqual({ x: 10, z: 10 });
  });

  it('makes a defensive copy of the replacement polyline', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const newPoly = [{ x: 0, z: 0 }, { x: 20, z: 0 }];
    r._replacePolyline(newPoly);
    newPoly.push({ x: 30, z: 0 });
    expect(r.polyline).toHaveLength(2);
  });
});

describe('Road — toJSON / fromJSON', () => {
  it('round-trips a Road with no bridges', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 5 }], {
      width: 8,
      hierarchy: 'arterial',
      importance: 0.7,
      source: 'test',
    });
    const json = r.toJSON();
    const r2 = Road.fromJSON(json);
    expect(r2.id).toBe(r.id);
    expect(r2.polyline).toEqual(r.polyline);
    expect(r2.width).toBe(8);
    expect(r2.hierarchy).toBe('arterial');
    expect(r2.importance).toBe(0.7);
    expect(r2.source).toBe('test');
    expect(r2.bridges).toEqual([]);
  });

  it('round-trips a Road with bridges', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    r.addBridge({ x: 3, z: -1 }, { x: 5, z: 1 }, 0.3, 0.5);
    const json = r.toJSON();
    const r2 = Road.fromJSON(json);
    expect(r2.bridges).toHaveLength(1);
    expect(r2.bridges[0].entryT).toBe(0.3);
    expect(r2.bridges[0].exitT).toBe(0.5);
    expect(r2.bridges[0].bankA).toEqual({ x: 3, z: -1 });
    expect(r2.bridges[0].bankB).toEqual({ x: 5, z: 1 });
  });

  it('toJSON produces a plain serializable object', () => {
    const r = new Road([{ x: 0, z: 0 }, { x: 10, z: 0 }]);
    const json = r.toJSON();
    expect(() => JSON.stringify(json)).not.toThrow();
    expect(typeof json).toBe('object');
  });
});
