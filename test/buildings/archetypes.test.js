import { describe, it, expect } from 'vitest';
import { sample, hashPosition, victorianTerrace } from '../../src/buildings/archetypes.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('sample', () => {
  it('returns scalar values unchanged', () => {
    const rng = new SeededRandom(42);
    expect(sample(rng, 5)).toBe(5);
    expect(sample(rng, 'hello')).toBe('hello');
  });

  it('samples from [min, max] range', () => {
    const rng = new SeededRandom(42);
    const val = sample(rng, [2, 5]);
    expect(val).toBeGreaterThanOrEqual(2);
    expect(val).toBeLessThan(5);
  });
});

describe('hashPosition', () => {
  it('returns an integer', () => {
    const h = hashPosition(42, 10.5, 0);
    expect(Number.isInteger(h)).toBe(true);
  });

  it('different positions produce different hashes', () => {
    const a = hashPosition(42, 0, 0);
    const b = hashPosition(42, 5, 0);
    const c = hashPosition(42, 0, 5);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('same inputs produce same hash', () => {
    expect(hashPosition(42, 10, 20)).toBe(hashPosition(42, 10, 20));
  });
});

describe('victorianTerrace', () => {
  it('has required archetype fields', () => {
    expect(victorianTerrace.typology).toBe('terraced');
    expect(victorianTerrace.partyWalls).toEqual(['left', 'right']);
    expect(victorianTerrace.floors).toEqual([2, 3]);
    expect(victorianTerrace.roofDirection).toBe('sides');
    expect(victorianTerrace.door).toBe('left');
    expect(victorianTerrace.bay).toBeDefined();
    expect(victorianTerrace.sills).toBeDefined();
  });
});
