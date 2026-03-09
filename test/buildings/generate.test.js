import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { generateBuilding } from '../../src/buildings/generate.js';
import { getClimateStyle, buildRecipe, CLIMATES } from '../../src/buildings/styles.js';

function getChild(group, name) {
  return group.children.find(c => c.name === name);
}

function getBounds(geo) {
  const pos = geo.attributes.position.array;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]);   maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i+1]); maxY = Math.max(maxY, pos[i+1]);
    minZ = Math.min(minZ, pos[i+2]); maxZ = Math.max(maxZ, pos[i+2]);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function hasNoNaN(geo) {
  const pos = geo.attributes.position.array;
  for (let i = 0; i < pos.length; i++) {
    if (isNaN(pos[i])) return false;
  }
  return true;
}

describe('generateBuilding', () => {
  it('returns a Group with walls, roof, windows', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'small', 0, 42);
    const group = generateBuilding(style, recipe);

    expect(group).toBeInstanceOf(THREE.Group);
    expect(getChild(group, 'walls')).toBeDefined();
    expect(getChild(group, 'roof')).toBeDefined();
    expect(getChild(group, 'windows')).toBeDefined();
  });

  it('wall height matches floors * floorHeight', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'small', 0, 42);
    const group = generateBuilding(style, recipe);
    const { maxY } = getBounds(getChild(group, 'walls').geometry);
    expect(maxY).toBeCloseTo(recipe.floors * style.floorHeight, 1);
  });

  it('wall footprint matches recipe dimensions', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'small', 0, 42);
    const group = generateBuilding(style, recipe);
    const { minX, maxX, minZ, maxZ } = getBounds(getChild(group, 'walls').geometry);
    expect(maxX - minX).toBeCloseTo(recipe.mainWidth, 0);
    expect(maxZ - minZ).toBeCloseTo(recipe.mainDepth, 0);
  });

  it('flat roof stays near wall top', () => {
    const style = getClimateStyle('arid');
    const recipe = buildRecipe(style, 'small', 0, 42);
    const group = generateBuilding(style, recipe);
    const { maxY } = getBounds(getChild(group, 'roof').geometry);
    const wallTop = recipe.floors * style.floorHeight;
    expect(maxY).toBeLessThanOrEqual(wallTop + 0.5);
  });

  it('gable roof peak reflects pitch', () => {
    const style = getClimateStyle('cold');
    const recipe = buildRecipe(style, 'small', 0, 42);
    const group = generateBuilding(style, recipe);
    const { maxY } = getBounds(getChild(group, 'roof').geometry);
    const wallTop = recipe.floors * style.floorHeight;
    const span = Math.min(recipe.mainWidth, recipe.mainDepth);
    const expected = wallTop + (span / 2) * Math.tan(style.roofPitch * Math.PI / 180);
    expect(maxY).toBeCloseTo(expected, 0);
  });

  it('no NaN in any geometry', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'medium', 0.5, 42);
    const group = generateBuilding(style, recipe);
    for (const child of group.children) {
      expect(hasNoNaN(child.geometry)).toBe(true);
    }
  });

  it('all 54 climate × size × richness combos work', () => {
    for (const climate of CLIMATES) {
      const style = getClimateStyle(climate);
      for (const size of ['small', 'medium', 'large']) {
        for (const rich of [0, 0.5, 1]) {
          const recipe = buildRecipe(style, size, rich, 42);
          const group = generateBuilding(style, recipe);
          expect(group.children.length).toBeGreaterThan(0);
          for (const child of group.children) {
            expect(hasNoNaN(child.geometry)).toBe(true);
          }
        }
      }
    }
  });
});
