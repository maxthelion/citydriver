import { describe, it, expect } from 'vitest';
import { LayerStack } from '../../src/core/LayerStack.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('LayerStack', () => {
  it('stores and retrieves grids', () => {
    const ls = new LayerStack();
    const g = new Grid2D(4, 4);
    ls.setGrid('elevation', g);
    expect(ls.getGrid('elevation')).toBe(g);
  });

  it('returns undefined for missing grids', () => {
    const ls = new LayerStack();
    expect(ls.getGrid('nope')).toBeUndefined();
  });

  it('hasGrid checks existence', () => {
    const ls = new LayerStack();
    expect(ls.hasGrid('elev')).toBe(false);
    ls.setGrid('elev', new Grid2D(2, 2));
    expect(ls.hasGrid('elev')).toBe(true);
  });

  it('stores and retrieves arbitrary data', () => {
    const ls = new LayerStack();
    ls.setData('settlements', [{ x: 1, z: 2 }]);
    expect(ls.getData('settlements')).toEqual([{ x: 1, z: 2 }]);
  });

  it('hasData checks existence', () => {
    const ls = new LayerStack();
    expect(ls.hasData('foo')).toBe(false);
    ls.setData('foo', 42);
    expect(ls.hasData('foo')).toBe(true);
  });

  it('lists grid keys', () => {
    const ls = new LayerStack();
    ls.setGrid('a', new Grid2D(2, 2));
    ls.setGrid('b', new Grid2D(2, 2));
    expect(ls.gridKeys()).toEqual(['a', 'b']);
  });

  it('lists data keys', () => {
    const ls = new LayerStack();
    ls.setData('x', 1);
    ls.setData('y', 2);
    expect(ls.dataKeys()).toEqual(['x', 'y']);
  });

  it('keys returns both grid and data keys', () => {
    const ls = new LayerStack();
    ls.setGrid('elev', new Grid2D(2, 2));
    ls.setData('stuff', []);
    expect(ls.keys()).toEqual(['elev', 'stuff']);
  });

  it('merge combines two LayerStacks', () => {
    const a = new LayerStack();
    a.setGrid('elev', new Grid2D(2, 2));
    a.setData('x', 1);

    const b = new LayerStack();
    b.setGrid('slope', new Grid2D(2, 2));
    b.setData('y', 2);

    a.merge(b);
    expect(a.hasGrid('elev')).toBe(true);
    expect(a.hasGrid('slope')).toBe(true);
    expect(a.getData('y')).toBe(2);
  });
});
