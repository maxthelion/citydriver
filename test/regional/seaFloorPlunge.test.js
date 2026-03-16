import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { applySeaFloorPlunge } from '../../src/regional/seaFloorPlunge.js';

function makeGrid(width, height, cellSize, fill) {
  return new Grid2D(width, height, { cellSize, fill });
}

describe('applySeaFloorPlunge', () => {
  it('pushes water-mask cells below sea level', () => {
    const elevation = makeGrid(20, 20, 50, 5); // all at 5m
    const waterMask = new Grid2D(20, 20, { type: 'uint8', cellSize: 50 });
    const resistance = makeGrid(20, 20, 50, 0.5);

    // Mark right half as water
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 10; gx < 20; gx++) {
        waterMask.set(gx, gz, 1);
      }
    }

    applySeaFloorPlunge(elevation, waterMask, resistance, 50, 0);

    // Water cells at the boundary should be well below sea level
    expect(elevation.get(10, 10)).toBeLessThan(-2);
    // Water cells further out should be even deeper
    expect(elevation.get(15, 10)).toBeLessThan(elevation.get(10, 10));
    // Land cells should be untouched
    expect(elevation.get(5, 10)).toBe(5);
  });

  it('hard rock produces steeper drop-off than soft rock', () => {
    const elevHard = makeGrid(20, 20, 50, 5);
    const elevSoft = makeGrid(20, 20, 50, 5);
    const waterMask = new Grid2D(20, 20, { type: 'uint8', cellSize: 50 });
    const hard = makeGrid(20, 20, 50, 0.9);
    const soft = makeGrid(20, 20, 50, 0.1);

    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 10; gx < 20; gx++) {
        waterMask.set(gx, gz, 1);
      }
    }

    applySeaFloorPlunge(elevHard, waterMask, hard, 50, 0);
    applySeaFloorPlunge(elevSoft, waterMask, soft, 50, 0);

    // Hard rock should be deeper at same distance from shore
    expect(elevHard.get(15, 10)).toBeLessThan(elevSoft.get(15, 10));
  });

  it('does not modify land cells', () => {
    const elevation = makeGrid(20, 20, 50, 50);
    const waterMask = new Grid2D(20, 20, { type: 'uint8', cellSize: 50 });
    const resistance = makeGrid(20, 20, 50, 0.5);

    waterMask.set(15, 10, 1);

    applySeaFloorPlunge(elevation, waterMask, resistance, 50, 0);

    expect(elevation.get(5, 10)).toBe(50);
    expect(elevation.get(10, 10)).toBe(50);
  });
});
