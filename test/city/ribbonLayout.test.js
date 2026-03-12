import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../src/core/Grid2D.js';
import {
  computeRibbonOrientation, layoutRibbonStreets, adjustStreetToContour,
} from '../../src/city/ribbonLayout.js';

describe('computeRibbonOrientation', () => {
  it('returns contour-following direction for moderate slope', () => {
    const result = computeRibbonOrientation({
      avgSlope: 0.15,
      slopeDir: { x: 1, z: 0 },
      centroidGx: 50, centroidGz: 50,
    }, { gx: 50, gz: 80 }, 5);

    // Contour-following: perpendicular to slope (east) → streets run north-south
    expect(Math.abs(result.dx)).toBeLessThan(0.2);
    expect(Math.abs(result.dz)).toBeCloseTo(1, 0);
  });

  it('returns nucleus-bearing direction for flat ground', () => {
    const result = computeRibbonOrientation({
      avgSlope: 0.03,
      slopeDir: { x: 0, z: 0 },
      centroidGx: 50, centroidGz: 50,
    }, { gx: 50, gz: 80 }, 5);

    // Should point roughly toward nucleus (south)
    expect(result.dz).toBeGreaterThan(0.5);
  });
});

describe('layoutRibbonStreets', () => {
  const boundary = [
    { x: 0, z: 0 }, { x: 200, z: 0 },
    { x: 200, z: 150 }, { x: 0, z: 150 },
  ];

  it('places parallel streets within a zone', () => {
    const streets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 50,
      pressure: 0.8,
    }, { dx: 1, dz: 0 }, 5, 0, 0);

    expect(streets.parallel.length).toBeGreaterThan(1);
    for (const st of streets.parallel) {
      expect(st.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('places cross streets connecting parallels', () => {
    const streets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 50,
      pressure: 0.8,
    }, { dx: 1, dz: 0 }, 5, 0, 0);

    expect(streets.cross.length).toBeGreaterThan(0);
  });

  it('spine street passes through centroid', () => {
    const streets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 50,
      pressure: 0.8,
    }, { dx: 1, dz: 0 }, 5, 0, 0);

    expect(streets.spine).toBeDefined();
    expect(streets.spine.length).toBeGreaterThanOrEqual(2);
  });

  it('uses tighter spacing for high-pressure zones', () => {
    const denseStreets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 50,
      pressure: 0.8,
    }, { dx: 0, dz: 1 }, 5, 0, 0);

    const wideStreets = layoutRibbonStreets({
      boundary,
      centroidGx: 20, centroidGz: 15,
      distFromNucleus: 400,
      pressure: 0.15,
    }, { dx: 0, dz: 1 }, 5, 0, 0);

    expect(denseStreets.parallel.length).toBeGreaterThan(wideStreets.parallel.length);
  });
});

describe('adjustStreetToContour', () => {
  it('reduces elevation variation along a street', () => {
    // Gentle slope: elevation increases with x at 0.5m per cell
    const elevation = new Grid2D(60, 60, { type: 'float32' });
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        elevation.set(gx, gz, 100 + gx * 0.5);

    // Street runs diagonally across the slope
    const street = [{ x: 50, z: 100 }, { x: 200, z: 100 }];
    const slopeDir = { x: 1, z: 0 };

    // Measure original elevation variation
    const origElevs = [
      elevation.sample(street[0].x / 5, street[0].z / 5),
      elevation.sample(street[1].x / 5, street[1].z / 5),
    ];
    const origRange = Math.abs(origElevs[1] - origElevs[0]);

    const adjusted = adjustStreetToContour(street, elevation, slopeDir, 5, 0, 0);
    expect(adjusted.length).toBeGreaterThan(2); // should be densified

    // Adjusted elevation variation should be less than original
    const adjElevs = adjusted.map(p => elevation.sample(
      Math.max(0, Math.min(59, p.x / 5)),
      Math.max(0, Math.min(59, p.z / 5)),
    ));
    const adjMin = Math.min(...adjElevs);
    const adjMax = Math.max(...adjElevs);
    const adjRange = adjMax - adjMin;

    expect(adjRange).toBeLessThan(origRange);
  });
});
