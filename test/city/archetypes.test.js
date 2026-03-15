import { describe, it, expect } from 'vitest';
import { ARCHETYPES, getArchetype } from '../../src/city/archetypes.js';

describe('ARCHETYPES', () => {
  it('contains all 5 archetypes', () => {
    expect(Object.keys(ARCHETYPES)).toHaveLength(5);
    expect(ARCHETYPES.marketTown).toBeDefined();
    expect(ARCHETYPES.portCity).toBeDefined();
    expect(ARCHETYPES.gridTown).toBeDefined();
    expect(ARCHETYPES.industrialTown).toBeDefined();
    expect(ARCHETYPES.civicCentre).toBeDefined();
  });

  it('each archetype has required fields', () => {
    for (const [id, arch] of Object.entries(ARCHETYPES)) {
      expect(arch.id).toBe(id);
      expect(arch.name).toBeTruthy();
      expect(arch.shares).toBeDefined();
      expect(arch.shares.commercial).toBeGreaterThan(0);
      expect(arch.shares.industrial).toBeGreaterThanOrEqual(0);
      expect(arch.shares.civic).toBeGreaterThan(0);
      expect(arch.shares.openSpace).toBeGreaterThan(0);
      expect(arch.reservationOrder).toHaveLength(4);
      expect(arch.placement).toBeDefined();
      expect(arch.growthMode).toBeDefined();
    }
  });

  it('shares sum to less than 1 (remainder is residential)', () => {
    for (const arch of Object.values(ARCHETYPES)) {
      const total = arch.shares.commercial + arch.shares.industrial
        + arch.shares.civic + arch.shares.openSpace;
      expect(total).toBeLessThan(1);
      expect(total).toBeGreaterThan(0.1);
    }
  });
});

describe('getArchetype', () => {
  it('returns archetype by id', () => {
    expect(getArchetype('marketTown').name).toBe('Organic Market Town');
  });

  it('returns null for unknown id', () => {
    expect(getArchetype('nonexistent')).toBeNull();
  });
});
