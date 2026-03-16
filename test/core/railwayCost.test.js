import { describe, it, expect } from 'vitest';
import { railwayCostFunction } from '../../src/core/railwayCost.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('railwayCostFunction', () => {
  function flatGrid(w, h, elevation, cellSize = 50) {
    const grid = new Grid2D(w, h, { cellSize });
    grid.forEach((gx, gz) => grid.set(gx, gz, elevation));
    return grid;
  }

  it('returns low cost on flat terrain', () => {
    const elev = flatGrid(20, 20, 50);
    const cost = railwayCostFunction(elev, {});
    const c = cost(10, 10, 11, 10);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(5);
  });

  it('penalises steep slopes heavily', () => {
    const elev = flatGrid(20, 20, 50);
    elev.set(11, 10, 60);
    const cost = railwayCostFunction(elev, { slopePenalty: 150 });
    const flat = cost(9, 10, 10, 10);
    const steep = cost(10, 10, 11, 10);
    expect(steep).toBeGreaterThan(flat * 5);
  });

  it('returns Infinity for below-sea-level cells', () => {
    const elev = flatGrid(20, 20, 50);
    elev.set(11, 10, -5);
    const cost = railwayCostFunction(elev, { seaLevel: 0 });
    expect(cost(10, 10, 11, 10)).toBe(Infinity);
  });

  it('adds water crossing penalty', () => {
    const elev = flatGrid(20, 20, 50);
    const water = new Grid2D(20, 20, { type: 'uint8' });
    water.set(11, 10, 1);
    const cost = railwayCostFunction(elev, { waterGrid: water, waterPenalty: 200 });
    const dry = cost(9, 10, 10, 10);
    const wet = cost(10, 10, 11, 10);
    expect(wet).toBeGreaterThan(dry + 100);
  });

  it('gives valley bonus discount', () => {
    const elev = flatGrid(20, 20, 50);
    const valley = new Grid2D(20, 20);
    valley.set(11, 10, 1.0);
    const costNoValley = railwayCostFunction(elev, {});
    const costWithValley = railwayCostFunction(elev, { valleyGrid: valley, valleyBonus: 0.3 });
    const cBase = costNoValley(10, 10, 11, 10);
    const cValley = costWithValley(10, 10, 11, 10);
    expect(cValley).toBeLessThan(cBase);
  });
});
