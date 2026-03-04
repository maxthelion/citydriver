import { describe, it, expect, beforeAll } from 'vitest';
import { generateCity } from '../../src/generation/pipeline.js';
import { scoreCity } from '../../src/generation/scoreCity.js';
import { Heightmap } from '../../src/core/heightmap.js';

function makeCityContext(overrides = {}) {
  const gridSize = 32;
  const cellSize = 10;
  const regionHm = new Heightmap(gridSize, gridSize, cellSize);

  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      regionHm.set(gx, gz, 50 - gx * 0.2 - gz * 0.1);
    }
  }
  regionHm.freeze();

  return {
    center: { x: 155, z: 155 },
    settlement: { name: 'Test Town' },
    regionHeightmap: regionHm,
    cityBounds: { minX: 0, minZ: 0, maxX: 310, maxZ: 310 },
    seaLevel: 0,
    rivers: [],
    coastline: null,
    roadEntries: [
      { point: { x: 0, z: 155 }, hierarchy: 'primary', destination: 'North' },
      { point: { x: 310, z: 155 }, hierarchy: 'primary', destination: 'South' },
      { point: { x: 155, z: 0 }, hierarchy: 'secondary', destination: 'East' },
    ],
    economicRole: 'market',
    rank: 'town',
    ...overrides,
  };
}

describe('scoreCity', () => {
  let cityData;
  let report;

  // Generate once, reuse across tests
  beforeAll(async () => {
    const ctx = makeCityContext();
    cityData = await generateCity(ctx, { seed: 42, gridSize: 64, organicness: 0.5 });
    report = scoreCity(cityData);
  }, 30000);

  it('returns expected report structure', () => {
    expect(report).toHaveProperty('valid');
    expect(report).toHaveProperty('validity');
    expect(report).toHaveProperty('structural');
    expect(report).toHaveProperty('quality');
    expect(report).toHaveProperty('structuralScore');
    expect(report).toHaveProperty('qualityScore');
    expect(report).toHaveProperty('overallScore');
  });

  it('validity checks all present with pass/details', () => {
    for (const key of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6']) {
      expect(report.validity).toHaveProperty(key);
      expect(report.validity[key]).toHaveProperty('pass');
      expect(report.validity[key]).toHaveProperty('details');
      expect(typeof report.validity[key].pass).toBe('boolean');
      expect(typeof report.validity[key].details).toBe('string');
    }
  });

  it('all V checks pass on a generated city', () => {
    for (const [key, v] of Object.entries(report.validity)) {
      expect(v.pass, `${key} should pass: ${v.details}`).toBe(true);
    }
    expect(report.valid).toBe(true);
  });

  it('structural checks all present with score/threshold', () => {
    for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      expect(report.structural).toHaveProperty(key);
      expect(typeof report.structural[key].score).toBe('number');
      expect(typeof report.structural[key].threshold).toBe('number');
      expect(typeof report.structural[key].details).toBe('string');
    }
  });

  it('all S scores are above 0', () => {
    for (const [key, s] of Object.entries(report.structural)) {
      expect(s.score, `${key} score should be > 0`).toBeGreaterThan(0);
    }
  });

  it('all Q scores are in [0, 1]', () => {
    for (const [key, q] of Object.entries(report.quality)) {
      expect(q.score, `${key}`).toBeGreaterThanOrEqual(0);
      expect(q.score, `${key}`).toBeLessThanOrEqual(1);
    }
  });

  it('composite scores are in [0, 1]', () => {
    expect(report.structuralScore).toBeGreaterThanOrEqual(0);
    expect(report.structuralScore).toBeLessThanOrEqual(1);
    expect(report.qualityScore).toBeGreaterThanOrEqual(0);
    expect(report.qualityScore).toBeLessThanOrEqual(1);
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(1);
  });

  it('overall = structural*0.6 + quality*0.4', () => {
    const expected = report.structuralScore * 0.6 + report.qualityScore * 0.4;
    expect(report.overallScore).toBeCloseTo(expected, 10);
  });

  it('deterministic: same city produces same scores', () => {
    const report2 = scoreCity(cityData);
    expect(report2.structuralScore).toBe(report.structuralScore);
    expect(report2.qualityScore).toBe(report.qualityScore);
    expect(report2.overallScore).toBe(report.overallScore);
    expect(report2.valid).toBe(report.valid);
  });
});
