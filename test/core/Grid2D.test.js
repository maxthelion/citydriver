import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('Grid2D', () => {
  it('creates a grid with correct dimensions', () => {
    const g = new Grid2D(10, 8);
    expect(g.width).toBe(10);
    expect(g.height).toBe(8);
    expect(g.data.length).toBe(80);
  });

  it('supports different typed array types', () => {
    const g = new Grid2D(4, 4, { type: 'uint8' });
    expect(g.data).toBeInstanceOf(Uint8Array);

    const g2 = new Grid2D(4, 4, { type: 'int32' });
    expect(g2.data).toBeInstanceOf(Int32Array);
  });

  it('fills with initial value', () => {
    const g = new Grid2D(3, 3, { fill: 5 });
    expect(g.get(0, 0)).toBe(5);
    expect(g.get(2, 2)).toBe(5);
  });

  it('get/set values', () => {
    const g = new Grid2D(4, 4);
    g.set(2, 3, 42);
    expect(g.get(2, 3)).toBe(42);
    expect(g.get(0, 0)).toBe(0);
  });

  it('returns 0 for out-of-bounds get', () => {
    const g = new Grid2D(4, 4, { fill: 10 });
    expect(g.get(-1, 0)).toBe(0);
    expect(g.get(4, 0)).toBe(0);
    expect(g.get(0, -1)).toBe(0);
    expect(g.get(0, 4)).toBe(0);
  });

  it('ignores out-of-bounds set', () => {
    const g = new Grid2D(4, 4);
    g.set(-1, 0, 5); // should not throw
    g.set(4, 0, 5);
  });

  it('worldToGrid and gridToWorld round-trip', () => {
    const g = new Grid2D(10, 10, { cellSize: 5, originX: 100, originZ: 200 });

    const world = g.gridToWorld(3, 4);
    expect(world.x).toBe(115);
    expect(world.z).toBe(220);

    const grid = g.worldToGrid(115, 220);
    expect(grid.gx).toBeCloseTo(3);
    expect(grid.gz).toBeCloseTo(4);
  });

  it('bilinear interpolation (sample)', () => {
    const g = new Grid2D(3, 3);
    g.set(0, 0, 0);
    g.set(1, 0, 10);
    g.set(0, 1, 10);
    g.set(1, 1, 20);

    // Center of the four corners
    expect(g.sample(0.5, 0.5)).toBeCloseTo(10);
    // At grid point
    expect(g.sample(0, 0)).toBeCloseTo(0);
    expect(g.sample(1, 0)).toBeCloseTo(10);
  });

  it('sampleWorld uses cellSize and origin', () => {
    const g = new Grid2D(3, 3, { cellSize: 10, originX: 0, originZ: 0 });
    g.set(0, 0, 100);
    g.set(1, 0, 200);
    g.set(0, 1, 200);
    g.set(1, 1, 300);

    expect(g.sampleWorld(5, 5)).toBeCloseTo(200);
  });

  it('forEach iterates all cells', () => {
    const g = new Grid2D(3, 2, { fill: 1 });
    let count = 0;
    g.forEach(() => count++);
    expect(count).toBe(6);
  });

  it('map creates a transformed copy', () => {
    const g = new Grid2D(3, 3, { fill: 5 });
    const doubled = g.map(v => v * 2);
    expect(doubled.get(0, 0)).toBe(10);
    expect(g.get(0, 0)).toBe(5); // original unchanged
  });

  it('clone creates an independent copy', () => {
    const g = new Grid2D(3, 3, { fill: 7 });
    const c = g.clone();
    c.set(0, 0, 99);
    expect(g.get(0, 0)).toBe(7);
    expect(c.get(0, 0)).toBe(99);
  });

  it('freeze prevents further writes', () => {
    const g = new Grid2D(3, 3);
    g.freeze();
    expect(() => g.set(0, 0, 1)).toThrow('frozen');
    expect(() => g.fill(1)).toThrow('frozen');
  });

  it('bounds returns min/max', () => {
    const g = new Grid2D(3, 3);
    g.set(0, 0, -5);
    g.set(1, 1, 15);
    const b = g.bounds();
    expect(b.min).toBe(-5);
    expect(b.max).toBe(15);
  });

  it('fill sets all cells', () => {
    const g = new Grid2D(3, 3);
    g.fill(42);
    expect(g.get(0, 0)).toBe(42);
    expect(g.get(2, 2)).toBe(42);
  });

  it('clone creates an independent deep copy', () => {
    const g = new Grid2D(10, 10, { type: 'float32', cellSize: 5, originX: 100, originZ: 200 });
    g.set(3, 4, 42);
    const c = g.clone();

    expect(c.width).toBe(10);
    expect(c.height).toBe(10);
    expect(c.cellSize).toBe(5);
    expect(c.originX).toBe(100);
    expect(c.originZ).toBe(200);
    expect(c.get(3, 4)).toBe(42);

    // Mutation independence
    c.set(3, 4, 99);
    expect(g.get(3, 4)).toBe(42);
    expect(c.get(3, 4)).toBe(99);
  });
});

describe('composition utilities', () => {
  it('combine merges two grids cell-by-cell', () => {
    const a = new Grid2D(3, 3, { fill: 0.5 });
    const b = new Grid2D(3, 3, { fill: 0.3 });
    const result = Grid2D.combine(a, b, (va, vb) => va + vb);
    expect(result.get(1, 1)).toBeCloseTo(0.8);
    expect(result.width).toBe(3);
  });

  it('threshold converts to binary', () => {
    const g = new Grid2D(3, 3);
    g.set(0, 0, 0.1);
    g.set(1, 0, 0.5);
    g.set(2, 0, 0.9);
    const result = Grid2D.threshold(g, 0.5);
    expect(result.get(0, 0)).toBe(0);
    expect(result.get(1, 0)).toBe(1.0);
    expect(result.get(2, 0)).toBe(1.0);
  });
});

describe('stampPolyline', () => {
  it('stamps cells along a polyline within radius', () => {
    const grid = new Grid2D(20, 20, { type: 'uint8', cellSize: 10 });
    const polyline = [{ x: 0, z: 100 }, { x: 200, z: 100 }];
    Grid2D.stampPolyline(grid, polyline, 5, 1);

    // Cell at (10, 10) is at world (100, 100) — on the line
    expect(grid.get(10, 10)).toBe(1);
    // Cell at (10, 0) is at world (100, 0) — far from line
    expect(grid.get(10, 0)).toBe(0);
  });

  it('does not stamp out-of-bounds cells', () => {
    const grid = new Grid2D(10, 10, { type: 'uint8', cellSize: 10 });
    const polyline = [{ x: -50, z: 50 }, { x: 150, z: 50 }];
    Grid2D.stampPolyline(grid, polyline, 5, 1);
    expect(grid.get(5, 5)).toBe(1);
  });
});
