import { describe, it, expect } from 'vitest';
import {
  sample, hashPosition, victorianTerrace, parisianHaussmann,
  germanTownhouse, suburbanDetached, lowRiseApartments, generateRow,
} from '../../src/buildings/archetypes.js';
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
    expect(victorianTerrace.shared.floors).toEqual([2, 3]);
    expect(victorianTerrace.shared.roofDirection).toBe('sides');
    expect(victorianTerrace.shared.door).toBe('left');
    expect(victorianTerrace.shared.bay).toBeDefined();
    expect(victorianTerrace.shared.sills).toBeDefined();
    expect(victorianTerrace.perHouse.plotWidth).toEqual([4.5, 6]);
    expect(victorianTerrace.perHouse.wallColor).toBeDefined();
  });
});

describe('parisianHaussmann', () => {
  it('has required archetype fields', () => {
    expect(parisianHaussmann.typology).toBe('terraced');
    expect(parisianHaussmann.partyWalls).toEqual(['left', 'right']);
    expect(parisianHaussmann.shared.floors).toEqual([5, 6]);
    expect(parisianHaussmann.shared.roofDirection).toBe('mansard');
    expect(parisianHaussmann.shared.balcony).toBeDefined();
    expect(parisianHaussmann.shared.dormers).toBeDefined();
    expect(parisianHaussmann.shared.balcony.style).toBe('full');
  });
});

describe('germanTownhouse', () => {
  it('has required archetype fields', () => {
    expect(germanTownhouse.typology).toBe('terraced');
    expect(germanTownhouse.shared.floors).toEqual([3, 4]);
    expect(germanTownhouse.shared.roofDirection).toBe('sides');
    expect(germanTownhouse.shared.dormers).toBeDefined();
    expect(germanTownhouse.shared.porch).toBeDefined();
    expect(germanTownhouse.shared.porch.roofStyle).toBe('gable');
  });
});

describe('suburbanDetached', () => {
  it('has required archetype fields', () => {
    expect(suburbanDetached.typology).toBe('detached');
    expect(suburbanDetached.partyWalls).toEqual([]);
    expect(suburbanDetached.shared.floors).toBe(2);
    expect(suburbanDetached.shared.roofDirection).toBe('all');
    expect(suburbanDetached.shared.porch).toBeDefined();
    expect(suburbanDetached.shared.extension).toBeDefined();
    expect(suburbanDetached.perHouse.sideGap).toEqual([1, 2]);
  });
});

describe('lowRiseApartments', () => {
  it('has required archetype fields', () => {
    expect(lowRiseApartments.typology).toBe('terraced');
    expect(lowRiseApartments.shared.floors).toEqual([4, 5]);
    expect(lowRiseApartments.shared.roofPitch).toBe(0);
    expect(lowRiseApartments.shared.balcony).toBeDefined();
    expect(lowRiseApartments.shared.balcony.style).toBe('full');
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

  it('houses on flat terrain are raised by groundHeight', () => {
    const group = generateRow(victorianTerrace, 1, 42);
    // Ground height range is [0.3, 0.5], so Y should be in that range
    expect(group.children[0].position.y).toBeGreaterThanOrEqual(0.3);
    expect(group.children[0].position.y).toBeLessThanOrEqual(0.5);
  });

  it('accepts a heightFn and positions houses at terrain height', () => {
    const heightFn = (x, _z) => x * 0.1; // 10% uphill slope
    const group = generateRow(victorianTerrace, 3, 42, heightFn);
    // Each house should have Y > 0 (except possibly first at x=0)
    const lastHouse = group.children[2];
    expect(lastHouse.position.y).toBeGreaterThan(0);
  });

  it('houses on a slope have increasing Y positions', () => {
    const heightFn = (x, _z) => x * 0.05;
    const group = generateRow(victorianTerrace, 4, 42, heightFn);
    for (let i = 1; i < group.children.length; i++) {
      expect(group.children[i].position.y).toBeGreaterThan(group.children[i - 1].position.y);
    }
  });

  it('flat heightFn produces same result as no heightFn', () => {
    const flat = generateRow(victorianTerrace, 3, 42, () => 0);
    const none = generateRow(victorianTerrace, 3, 42);
    for (let i = 0; i < 3; i++) {
      expect(flat.children[i].position.y).toBeCloseTo(none.children[i].position.y, 3);
    }
  });

  it('adds rear foundation wall when terrain drops behind house', () => {
    // Cross-slope: terrain rises with z, so back of house is higher — no rear wall needed
    // Negative cross-slope: terrain falls with z, back is lower — rear wall needed
    const heightFn = (_x, z) => -z * 0.1; // terrain drops toward back
    const group = generateRow(victorianTerrace, 2, 42, heightFn);
    const house = group.children[0];
    let hasRearFoundation = false;
    house.traverse(c => { if (c.name === 'rearFoundation') hasRearFoundation = true; });
    expect(hasRearFoundation).toBe(true);
  });

  it('generates Haussmann row with balconies and dormers', () => {
    const group = generateRow(parisianHaussmann, 3, 42);
    expect(group.children.length).toBe(3);
    const house = group.children[1];
    let hasBalcony = false;
    let hasDormer = false;
    house.traverse(c => {
      if (c.name && c.name.startsWith('balcony_')) hasBalcony = true;
      if (c.name && c.name.startsWith('dormer')) hasDormer = true;
    });
    expect(hasBalcony).toBe(true);
    expect(hasDormer).toBe(true);
  });

  it('generates German townhouse row with porch and dormers', () => {
    const group = generateRow(germanTownhouse, 3, 42);
    expect(group.children.length).toBe(3);
    const house = group.children[1];
    let hasPorch = false;
    let hasDormer = false;
    house.traverse(c => {
      if (c.name === 'porch') hasPorch = true;
      if (c.name && c.name.startsWith('dormer')) hasDormer = true;
    });
    expect(hasPorch).toBe(true);
    expect(hasDormer).toBe(true);
  });

  it('generates suburban detached with gaps between houses', () => {
    const group = generateRow(suburbanDetached, 3, 42);
    expect(group.children.length).toBe(3);
    const h0 = group.children[0];
    const h1 = group.children[1];
    // Find actual house box width by inspecting geometry
    let houseWidth = 0;
    h0.traverse(c => {
      if (c.name === 'walls' && c.geometry) {
        c.geometry.computeBoundingBox();
        houseWidth = c.geometry.boundingBox.max.x - c.geometry.boundingBox.min.x;
      }
    });
    const plotSpacing = h1.position.x - h0.position.x;
    expect(houseWidth).toBeLessThan(plotSpacing);
  });

  it('generates suburban detached with porch and extension', () => {
    const group = generateRow(suburbanDetached, 2, 42);
    const house = group.children[0];
    let hasPorch = false;
    let hasExtension = false;
    house.traverse(c => {
      if (c.name === 'porch') hasPorch = true;
      if (c.name === 'extension') hasExtension = true;
    });
    expect(hasPorch).toBe(true);
    expect(hasExtension).toBe(true);
  });

  it('generates apartment row with balconies on every floor', () => {
    const group = generateRow(lowRiseApartments, 3, 42);
    const house = group.children[1];
    let balconyCount = 0;
    house.traverse(c => {
      if (c.name && c.name.startsWith('balcony_')) balconyCount++;
    });
    // Apartments have 4-5 floors, balconies on floors 1 through floors-1
    expect(balconyCount).toBeGreaterThanOrEqual(3);
  });

  it('generates apartment row with flat roof', () => {
    const group = generateRow(lowRiseApartments, 2, 42);
    const house = group.children[0];
    let hasRoof = false;
    house.traverse(c => {
      if (c.name === 'roof') hasRoof = true;
    });
    expect(hasRoof).toBe(true);
  });
});
