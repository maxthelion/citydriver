import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import { computeValleyDepthField, computeFloodplainField, applyTerrainFields } from '../../src/regional/carveValleys.js';

function makeElevation(width = 64, height = 64, cellSize = 50, fill = 100) {
  return new Grid2D(width, height, { cellSize, fill });
}

function makeResistance(width = 64, height = 64, cellSize = 50, fill = 0.5) {
  return new Grid2D(width, height, { cellSize, fill });
}

function makeRiverPath(fromX, fromZ, toX, toZ, acc = 5000, cellSize = 50) {
  const steps = 20;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: fromX * cellSize + (toX - fromX) * cellSize * t,
      z: fromZ * cellSize + (toZ - fromZ) * cellSize * t,
      accumulation: acc,
      width: Math.sqrt(acc) / 5 * 2,
    });
  }
  return [{ points }];
}

describe('computeValleyDepthField', () => {
  it('produces a depth field with values > 0 near river', () => {
    const elevation = makeElevation();
    const resistance = makeResistance();
    const paths = makeRiverPath(10, 32, 54, 32, 5000);

    const field = computeValleyDepthField(paths, elevation, resistance, 50);
    // On the river centreline
    expect(field.get(32, 32)).toBeGreaterThan(0);
    // Far from river
    expect(field.get(32, 0)).toBe(0);
  });

  it('hard rock produces narrower valleys', () => {
    const elevation = makeElevation();
    const hard = makeResistance(64, 64, 50, 0.9);
    const soft = makeResistance(64, 64, 50, 0.1);
    const paths = makeRiverPath(10, 32, 54, 32, 5000);

    const hardField = computeValleyDepthField(paths, elevation, hard, 50);
    const softField = computeValleyDepthField(paths, elevation, soft, 50);

    // Count cells with carving > 0
    let hardCells = 0, softCells = 0;
    for (let gz = 0; gz < 64; gz++)
      for (let gx = 0; gx < 64; gx++) {
        if (hardField.get(gx, gz) > 0) hardCells++;
        if (softField.get(gx, gz) > 0) softCells++;
      }

    expect(softCells).toBeGreaterThan(hardCells);
  });

  it('deeper carving with higher accumulation', () => {
    const elevation = makeElevation();
    const resistance = makeResistance();
    const smallPaths = makeRiverPath(10, 32, 54, 32, 500);
    const largePaths = makeRiverPath(10, 32, 54, 32, 10000);

    const smallField = computeValleyDepthField(smallPaths, elevation, resistance, 50);
    const largeField = computeValleyDepthField(largePaths, elevation, resistance, 50);

    expect(largeField.get(32, 32)).toBeGreaterThan(smallField.get(32, 32));
  });
});

describe('computeFloodplainField', () => {
  it('targets below sea level near coast for large rivers', () => {
    // Low elevation (3m) so terrain is within the floodplain guard window
    const elevation = makeElevation(64, 64, 50, 3);
    const resistance = makeResistance();
    const waterMask = new Grid2D(64, 64, { type: 'uint8', cellSize: 50 });

    // Mark bottom 2 rows as water (coast)
    for (let gx = 0; gx < 64; gx++) {
      for (let gz = 62; gz < 64; gz++) {
        waterMask.set(gx, gz, 1);
        elevation.set(gx, gz, -5);
      }
    }

    // River path running toward coast (south), large accumulation
    const paths = makeRiverPath(32, 30, 32, 61, 10000);

    const { floodplainTarget } = computeFloodplainField(
      paths, elevation, waterMask, resistance, 50, 0
    );

    // Near the coast, the target should be below sea level
    const targetNearCoast = floodplainTarget.get(32, 60);
    expect(targetNearCoast).toBeLessThan(0);
  });
});

describe('applyTerrainFields', () => {
  it('lowers elevation where valleyDepthField > 0', () => {
    const elevation = makeElevation(64, 64, 50, 100);
    const depthField = new Grid2D(64, 64, { cellSize: 50 });
    depthField.set(32, 32, 5); // 5m carve at centre
    const floodField = new Grid2D(64, 64, { cellSize: 50 });
    const floodTarget = new Grid2D(64, 64, { cellSize: 50 });

    applyTerrainFields(elevation, depthField, floodField, floodTarget, 0);
    expect(elevation.get(32, 32)).toBe(95);
    expect(elevation.get(0, 0)).toBe(100); // untouched
  });

  it('does not clamp elevation above -0.5m for deep water', () => {
    // Elevation already at -10m (from coastal falloff in generateTerrain)
    const elevation = makeElevation(64, 64, 50, -10);
    const depthField = new Grid2D(64, 64, { cellSize: 50 });
    const floodField = new Grid2D(64, 64, { cellSize: 50 });
    const floodTarget = new Grid2D(64, 64, { cellSize: 50 });

    applyTerrainFields(elevation, depthField, floodField, floodTarget, 0);
    // Should preserve the -10m elevation, not clamp to -0.5m
    expect(elevation.get(32, 32)).toBeLessThan(-5);
  });
});
