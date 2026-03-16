import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { computeFloodZone, computeTerrainSuitability } from '../../src/core/terrainSuitability.js';

describe('computeTerrainSuitability', () => {
  it('returns high value for flat interior cells', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });

    const { suitability } = computeTerrainSuitability(elevation, slope, waterMask);
    expect(suitability.get(25, 25)).toBeGreaterThan(0.5);
  });

  it('returns 0 for edge cells', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });

    const { suitability } = computeTerrainSuitability(elevation, slope, waterMask);
    expect(suitability.get(0, 0)).toBe(0);
  });

  it('returns 0 for water cells', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    waterMask.set(25, 25, 1);

    const { suitability } = computeTerrainSuitability(elevation, slope, waterMask);
    expect(suitability.get(25, 25)).toBe(0);
  });

  it('returns low value for steep cells', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.6 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });

    const { suitability } = computeTerrainSuitability(elevation, slope, waterMask);
    expect(suitability.get(25, 25)).toBeLessThan(0.2);
  });

  it('does not mutate input grids', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    const origSlope = slope.get(25, 25);

    computeTerrainSuitability(elevation, slope, waterMask);
    expect(slope.get(25, 25)).toBe(origSlope);
  });

  it('returns waterDist grid', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 100 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    waterMask.set(25, 25, 1);

    const { waterDist } = computeTerrainSuitability(elevation, slope, waterMask);
    expect(waterDist.get(25, 25)).toBe(0);
    expect(waterDist.get(26, 25)).toBe(1);
  });

  it('returns 0 for cells in flood zone', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 2.5 });
    const slope = new Grid2D(50, 50, { cellSize: 10, fill: 0.02 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    waterMask.set(20, 25, 1);

    const floodZone = computeFloodZone(elevation, waterMask, 0);
    const { suitability } = computeTerrainSuitability(elevation, slope, waterMask, 0, floodZone);
    // Cell in flood zone should be unbuildable
    expect(suitability.get(23, 25)).toBe(0);
  });
});

describe('computeFloodZone', () => {
  it('marks low-lying land near water as flood zone', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 2.5 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    waterMask.set(20, 25, 1);

    const floodZone = computeFloodZone(elevation, waterMask, 0);
    // 3 cells from water at 2.5m (< 3.0m threshold) = flood zone
    expect(floodZone.get(23, 25)).toBe(1);
  });

  it('does not mark high land near water', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 10 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    waterMask.set(20, 25, 1);

    const floodZone = computeFloodZone(elevation, waterMask, 0);
    // 10m elevation > 3.0m threshold = not flood zone
    expect(floodZone.get(23, 25)).toBe(0);
  });

  it('does not mark low land far from water', () => {
    const elevation = new Grid2D(50, 50, { cellSize: 10, fill: 2.5 });
    const waterMask = new Grid2D(50, 50, { type: 'uint8', cellSize: 10 });
    waterMask.set(20, 25, 1);

    const floodZone = computeFloodZone(elevation, waterMask, 0);
    // 15 cells from water = beyond flood distance
    expect(floodZone.get(35, 25)).toBe(0);
  });
});
