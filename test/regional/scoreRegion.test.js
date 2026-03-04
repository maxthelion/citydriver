import { describe, it, expect } from 'vitest';
import { generateRegion } from '../../src/regional/region.js';
import { scoreRegion } from '../../src/regional/scoreRegion.js';

// ---------------------------------------------------------------------------
// Shared region generated once with a fixed seed and small grid for speed.
// ---------------------------------------------------------------------------

const SEED = 42;
const GRID_SIZE = 64;

function makeRegion(overrides = {}) {
  return generateRegion({
    seed: SEED,
    gridSize: GRID_SIZE,
    cellSize: 200,
    mountainousness: 0.4,
    roughness: 0.5,
    coastEdges: ['south'],
    seaLevelPercentile: 0.35,
    maxCities: 3,
    maxTowns: 5,
    maxVillages: 10,
    minCitySpacing: 12,
    minTownSpacing: 6,
    minVillageSpacing: 4,
    streamThreshold: 20,
    riverThreshold: 80,
    majorRiverThreshold: 300,
    geology: false,
    ...overrides,
  });
}

let _cached = null;
function getCachedRegion() {
  if (!_cached) _cached = makeRegion();
  return _cached;
}

// ---------------------------------------------------------------------------
// Structure — scoreRegion returns the right shape regardless of pass/fail
// ---------------------------------------------------------------------------

describe('scoreRegion structure', () => {
  it('returns the expected top-level keys', () => {
    const result = scoreRegion(getCachedRegion());
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('validity');
    expect(result).toHaveProperty('structural');
    expect(result).toHaveProperty('quality');
    expect(result).toHaveProperty('structuralScore');
    expect(result).toHaveProperty('qualityScore');
    expect(result).toHaveProperty('overallScore');
  });

  it('validity checks return { pass, details }', () => {
    const { validity } = scoreRegion(getCachedRegion());
    for (const [, v] of Object.entries(validity)) {
      expect(typeof v.pass).toBe('boolean');
      expect(typeof v.details).toBe('string');
    }
  });

  it('structural checks return { score, threshold, details }', () => {
    const { structural } = scoreRegion(getCachedRegion());
    for (const [, s] of Object.entries(structural)) {
      expect(typeof s.score).toBe('number');
      expect(typeof s.threshold).toBe('number');
      expect(typeof s.details).toBe('string');
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it('quality checks return { score, details }', () => {
    const { quality } = scoreRegion(getCachedRegion());
    for (const [, q] of Object.entries(quality)) {
      expect(typeof q.score).toBe('number');
      expect(typeof q.details).toBe('string');
      expect(q.score).toBeGreaterThanOrEqual(0);
      expect(q.score).toBeLessThanOrEqual(1);
    }
  });

  it('contains the expected check IDs', () => {
    const result = scoreRegion(getCachedRegion());
    expect(Object.keys(result.validity).sort()).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V9']);
    expect(Object.keys(result.structural).sort()).toEqual(['S1', 'S3', 'S4', 'S8', 'S9']);
    expect(Object.keys(result.quality).sort()).toEqual(['Q10', 'Q2', 'Q5', 'Q8', 'Q9']);
  });

  it('composite scores are in [0, 1]', () => {
    const result = scoreRegion(getCachedRegion());
    expect(result.structuralScore).toBeGreaterThanOrEqual(0);
    expect(result.structuralScore).toBeLessThanOrEqual(1);
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    expect(result.qualityScore).toBeLessThanOrEqual(1);
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(1);
  });

  it('overall = structural * 0.6 + quality * 0.4', () => {
    const result = scoreRegion(getCachedRegion());
    const expected = result.structuralScore * 0.6 + result.qualityScore * 0.4;
    expect(result.overallScore).toBeCloseTo(expected, 10);
  });

  it('deterministic: same seed produces same scores', () => {
    const a = scoreRegion(makeRegion());
    const b = scoreRegion(makeRegion());
    expect(a.overallScore).toBe(b.overallScore);
    expect(a.valid).toBe(b.valid);
  });
});

// ---------------------------------------------------------------------------
// Validity — checks that currently pass
// ---------------------------------------------------------------------------

describe('scoreRegion validity (passing)', () => {
  it('V1: roads stay on land', () => {
    const { validity } = scoreRegion(getCachedRegion());
    expect(validity.V1.pass).toBe(true);
  });

  it('V2: settlements on land with reasonable slope', () => {
    const { validity } = scoreRegion(getCachedRegion());
    expect(validity.V2.pass).toBe(true);
  });

  it('V3: all settlements reachable via road network', () => {
    const { validity } = scoreRegion(getCachedRegion());
    expect(validity.V3.pass).toBe(true);
  });

  it('V4: rivers flow downhill', () => {
    const { validity } = scoreRegion(getCachedRegion());
    expect(validity.V4.pass).toBe(true);
  });

  it('V5: root streams terminate at water or map edge', () => {
    const { validity } = scoreRegion(getCachedRegion());
    expect(validity.V5.pass).toBe(true);
  });

  it('V6: same-rank settlement spacing respected', () => {
    const { validity } = scoreRegion(getCachedRegion());
    expect(validity.V6.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validity — previously failing, now fixed
// ---------------------------------------------------------------------------

describe('scoreRegion validity (fixed)', () => {
  it('V9: river sources at plausible locations', () => {
    const { validity } = scoreRegion(getCachedRegion());
    expect(validity.V9.pass).toBe(true);
  });

  it('V3: seed 7777 — all settlements reachable', () => {
    const region = makeRegion({ seed: 7777 });
    const { validity } = scoreRegion(region);
    expect(validity.V3.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural — checks that currently meet thresholds
// ---------------------------------------------------------------------------

describe('scoreRegion structural (passing)', () => {
  it('S1: road gradients within limits', () => {
    const { structural } = scoreRegion(getCachedRegion());
    expect(structural.S1.score).toBeGreaterThanOrEqual(structural.S1.threshold);
  });

  it('S3: road hierarchy coherence', () => {
    const { structural } = scoreRegion(getCachedRegion());
    expect(structural.S3.score).toBeGreaterThanOrEqual(structural.S3.threshold);
  });

  it('S4: settlement geography quality', () => {
    const { structural } = scoreRegion(getCachedRegion());
    expect(structural.S4.score).toBeGreaterThanOrEqual(structural.S4.threshold);
  });

  it('S8: major roads avoid highlands', () => {
    const { structural } = scoreRegion(getCachedRegion());
    expect(structural.S8.score).toBeGreaterThanOrEqual(structural.S8.threshold);
  });
});

// ---------------------------------------------------------------------------
// Structural — previously failing, now fixed (except S8 seed 1)
// ---------------------------------------------------------------------------

describe('scoreRegion structural (fixed)', () => {
  it('S9: river sinuosity meets threshold', () => {
    const { structural } = scoreRegion(getCachedRegion());
    expect(structural.S9.score).toBeGreaterThanOrEqual(structural.S9.threshold);
  });
});

describe('scoreRegion structural (known failures)', () => {
  it.fails('S8: seed 1 has major roads through highlands', () => {
    const region = makeRegion({ seed: 1 });
    const { structural } = scoreRegion(region);
    expect(structural.S8.score).toBeGreaterThanOrEqual(structural.S8.threshold);
  });
});

// ---------------------------------------------------------------------------
// Quality — verify scores are reasonable (not threshold-gated)
// ---------------------------------------------------------------------------

describe('scoreRegion quality', () => {
  it('Q2: road hierarchy ratios produce a score', () => {
    const { quality } = scoreRegion(getCachedRegion());
    expect(quality.Q2.score).toBeGreaterThan(0.3);
  });

  it('Q5: road directness is reasonable', () => {
    const { quality } = scoreRegion(getCachedRegion());
    expect(quality.Q5.score).toBeGreaterThan(0.5);
  });

  it('Q8: settlement clustering has off-corridor settlements', () => {
    const { quality } = scoreRegion(getCachedRegion());
    expect(quality.Q8.score).toBeGreaterThan(0.7);
  });

  it('Q9: terrain transitions are natural', () => {
    const { quality } = scoreRegion(getCachedRegion());
    expect(quality.Q9.score).toBeGreaterThan(0.9);
  });

  it('Q10: settlements near water', () => {
    const { quality } = scoreRegion(getCachedRegion());
    expect(quality.Q10.score).toBeGreaterThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// Composite — overall scores reflect known issues
// ---------------------------------------------------------------------------

describe('scoreRegion composite', () => {
  it('valid is true after fixes', () => {
    const result = scoreRegion(getCachedRegion());
    expect(result.valid).toBe(true);
  });

  it('structural score is above 0.90', () => {
    const result = scoreRegion(getCachedRegion());
    expect(result.structuralScore).toBeGreaterThanOrEqual(0.90);
  });

  it('quality score is above 0.90', () => {
    const result = scoreRegion(getCachedRegion());
    expect(result.qualityScore).toBeGreaterThanOrEqual(0.90);
  });

  it('overall score above 0.70', () => {
    const result = scoreRegion(getCachedRegion());
    expect(result.overallScore).toBeGreaterThanOrEqual(0.70);
  });
});
