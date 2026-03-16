import { describe, it, expect } from 'vitest';
import { generateRailways } from '../../src/regional/generateRailways.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('generateRailways', () => {
  const W = 64, H = 64, CS = 50;

  function makeElevation() {
    const elev = new Grid2D(W, H, { cellSize: CS });
    elev.forEach((gx, gz) => elev.set(gx, gz, 50));
    return elev;
  }

  function makeWaterMask() {
    return new Grid2D(W, H, { type: 'uint8' });
  }

  const settlements = [
    { gx: 32, gz: 32, tier: 1 },
    { gx: 16, gz: 16, tier: 2 },
    { gx: 48, gz: 48, tier: 3 },
  ];

  const offMapCities = [
    { gx: 32, gz: 0, edge: 'north', importance: 1, role: 'capital' },
    { gx: 63, gz: 32, edge: 'east', importance: 2, role: 'industrial' },
  ];

  it('generates railway lines', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      settlements, offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    expect(result.railways.length).toBeGreaterThan(0);
    expect(result.railGrid).toBeDefined();
  });

  it('main line connects tier-1 to capital', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      settlements, offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    const trunk = result.railways.filter(r => r.hierarchy === 'trunk');
    expect(trunk.length).toBe(1);
  });

  it('stamps railGrid cells', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      settlements, offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    let count = 0;
    result.railGrid.forEach((gx, gz, v) => { if (v > 0) count++; });
    expect(count).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const make = () => generateRailways(
      { width: W, height: H, cellSize: CS },
      settlements, offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    const a = make();
    const b = make();
    expect(a.railways.length).toBe(b.railways.length);
  });

  it('returns empty for no settlements', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      [], offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    expect(result.railways.length).toBe(0);
  });

  it('handles settlements with no tier-1', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      [{ gx: 32, gz: 32, tier: 3 }, { gx: 16, gz: 16, tier: 3 }],
      offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    expect(result.railways.length).toBeGreaterThan(0);
  });
});
