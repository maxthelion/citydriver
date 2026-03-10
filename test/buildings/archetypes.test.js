import { describe, it, expect } from 'vitest';
import { sample, hashPosition, victorianTerrace, generateRow } from '../../src/buildings/archetypes.js';
import { SeededRandom } from '../../src/core/rng.js';
import * as THREE from 'three';

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

describe('generateRow', () => {
  it('returns a THREE.Group with the correct number of houses', () => {
    const group = generateRow(victorianTerrace, 5, 42);
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBe(5);
  });

  it('is deterministic — same seed produces same output', () => {
    const a = generateRow(victorianTerrace, 4, 123);
    const b = generateRow(victorianTerrace, 4, 123);
    expect(a.children.length).toBe(b.children.length);
    for (let i = 0; i < a.children.length; i++) {
      expect(a.children[i].position.x).toBeCloseTo(b.children[i].position.x, 5);
    }
  });

  it('first house has left-side windows (no left party wall)', () => {
    const group = generateRow(victorianTerrace, 4, 42);
    const firstHouse = group.children[0];
    let winGroup = null;
    firstHouse.traverse(c => { if (c.name === 'windows') winGroup = c; });
    expect(winGroup).toBeDefined();
    // Should have at least one window on the left wall (x near -0.01)
    const leftWindows = winGroup.children.filter(w => Math.abs(w.position.x - (-0.01)) < 0.1);
    expect(leftWindows.length).toBeGreaterThan(0);
  });

  it('last house has right-side windows (no right party wall)', () => {
    const group = generateRow(victorianTerrace, 4, 42);
    const lastHouse = group.children[3];
    let winGroup = null;
    lastHouse.traverse(c => { if (c.name === 'windows') winGroup = c; });
    expect(winGroup).toBeDefined();
    // Right wall windows have x > 3 (min plotWidth is 4.5, so house width + 0.01 > 4)
    const rightWindows = winGroup.children.filter(w => w.position.x > 3);
    expect(rightWindows.length).toBeGreaterThan(0);
  });

  it('middle house has fewer windows than end house (both party walls)', () => {
    const group = generateRow(victorianTerrace, 5, 42);
    const endHouse = group.children[0];
    const midHouse = group.children[2];
    let endWins = null, midWins = null;
    endHouse.traverse(c => { if (c.name === 'windows') endWins = c; });
    midHouse.traverse(c => { if (c.name === 'windows') midWins = c; });
    expect(midWins.children.length).toBeLessThan(endWins.children.length);
  });

  it('houses are positioned with increasing X offset', () => {
    const group = generateRow(victorianTerrace, 4, 42);
    for (let i = 1; i < group.children.length; i++) {
      expect(group.children[i].position.x).toBeGreaterThan(group.children[i - 1].position.x);
    }
  });
});
