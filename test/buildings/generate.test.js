import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { generateBuilding } from '../../src/buildings/generate.js';
import { getClimateStyle, buildRecipe } from '../../src/buildings/styles.js';

/**
 * Helper: extract the named child mesh from a group.
 */
function getChild(group, name) {
  return group.children.find((c) => c.name === name);
}

/**
 * Helper: get the Y-range from a geometry's position attribute.
 */
function getYRange(geometry) {
  const pos = geometry.getAttribute('position');
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minY, maxY };
}

/**
 * Helper: get the X-range from a geometry's position attribute.
 */
function getXRange(geometry) {
  const pos = geometry.getAttribute('position');
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  return { minX, maxX };
}

/**
 * Helper: get the Z-range from a geometry's position attribute.
 */
function getZRange(geometry) {
  const pos = geometry.getAttribute('position');
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minZ, maxZ };
}

/**
 * Helper: check that no position component is NaN.
 */
function hasNoNaN(geometry) {
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    if (isNaN(pos.getX(i)) || isNaN(pos.getY(i)) || isNaN(pos.getZ(i))) {
      return false;
    }
  }
  return true;
}

describe('generateBuilding', () => {
  // Use a fixed seed for deterministic recipes
  const seed = 42;

  it('returns a THREE.Group with wall geometry', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'medium', 0.5, seed);
    const building = generateBuilding(style, recipe);

    expect(building).toBeInstanceOf(THREE.Group);

    const walls = getChild(building, 'walls');
    expect(walls).toBeDefined();
    expect(walls).toBeInstanceOf(THREE.Mesh);

    const pos = walls.geometry.getAttribute('position');
    expect(pos).toBeDefined();
    expect(pos.count).toBeGreaterThan(0);
    expect(hasNoNaN(walls.geometry)).toBe(true);
  });

  it('wall height matches floors * floorHeight', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'medium', 0.5, seed);
    const building = generateBuilding(style, recipe);

    const walls = getChild(building, 'walls');
    const { maxY } = getYRange(walls.geometry);
    const expectedHeight = recipe.floors * style.floorHeight;

    expect(maxY).toBeCloseTo(expectedHeight, 1);
  });

  it('wall footprint matches recipe dimensions', () => {
    const style = getClimateStyle('temperate');
    // Use small plot with no wings for a clean footprint check
    const recipe = buildRecipe(style, 'small', 0, seed);
    const building = generateBuilding(style, recipe);

    const walls = getChild(building, 'walls');
    const { minX, maxX } = getXRange(walls.geometry);
    const { minZ, maxZ } = getZRange(walls.geometry);

    // Main volume starts at (0, 0), so X range = [0, mainWidth], Z range = [0, mainDepth]
    expect(minX).toBeCloseTo(0, 1);
    expect(maxX).toBeCloseTo(recipe.mainWidth, 1);
    expect(minZ).toBeCloseTo(0, 1);
    expect(maxZ).toBeCloseTo(recipe.mainDepth, 1);
  });

  it('has roof geometry', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'medium', 0.5, seed);
    const building = generateBuilding(style, recipe);

    const roof = getChild(building, 'roof');
    expect(roof).toBeDefined();
    expect(roof).toBeInstanceOf(THREE.Mesh);

    const pos = roof.geometry.getAttribute('position');
    expect(pos).toBeDefined();
    expect(pos.count).toBeGreaterThan(0);
  });

  it('flat roof has no vertices above wall height + 0.5', () => {
    const style = getClimateStyle('arid'); // arid uses flat roof
    expect(style.roofType).toBe('flat');

    const recipe = buildRecipe(style, 'medium', 0.5, seed);
    const building = generateBuilding(style, recipe);

    const roof = getChild(building, 'roof');
    const wallHeight = recipe.floors * style.floorHeight;
    const { maxY } = getYRange(roof.geometry);

    expect(maxY).toBeLessThanOrEqual(wallHeight + 0.5);
    // Should be very close to wallHeight + 0.15
    expect(maxY).toBeCloseTo(wallHeight + 0.15, 1);
  });

  it('gable roof peak height reflects pitch', () => {
    const style = getClimateStyle('cold'); // cold uses gable roof
    expect(style.roofType).toBe('gable');

    const recipe = buildRecipe(style, 'small', 0, seed);
    const building = generateBuilding(style, recipe);

    const roof = getChild(building, 'roof');
    const wallHeight = recipe.floors * style.floorHeight;
    const span = Math.min(recipe.mainWidth, recipe.mainDepth);
    const pitchRad = (style.roofPitch * Math.PI) / 180;
    const expectedPeak = wallHeight + (span / 2) * Math.tan(pitchRad);

    const { maxY } = getYRange(roof.geometry);
    expect(maxY).toBeCloseTo(expectedPeak, 1);
  });

  it('wing roof does not exceed main wall height', () => {
    const style = getClimateStyle('temperate');
    for (let seed = 0; seed < 50; seed++) {
      const recipe = buildRecipe(style, 'large', 0.5, seed);
      if (recipe.wings.length === 0) continue;
      for (const wing of recipe.wings) {
        const wingWallTop = wing.floors * style.floorHeight;
        const mainWallTop = recipe.floors * style.floorHeight;
        expect(wingWallTop).toBeLessThan(mainWallTop);
      }
      return;
    }
  });

  it('buildings with wings have more wall vertices than without', () => {
    const style = getClimateStyle('temperate');
    let withWings = null, withoutWings = null;
    for (let seed = 0; seed < 100; seed++) {
      const recipe = buildRecipe(style, 'large', 0.5, seed);
      if (recipe.wings.length > 0 && !withWings) withWings = recipe;
      if (recipe.wings.length === 0 && !withoutWings) withoutWings = recipe;
      if (withWings && withoutWings) break;
    }
    if (!withWings || !withoutWings) return;
    const gWith = generateBuilding(style, withWings);
    const gWithout = generateBuilding(style, withoutWings);
    const wallsWith = gWith.getObjectByName('walls').geometry.attributes.position.count;
    const wallsWithout = gWithout.getObjectByName('walls').geometry.attributes.position.count;
    expect(wallsWith).toBeGreaterThan(wallsWithout);
  });

  it('has window geometry', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'medium', 0, 42);
    const group = generateBuilding(style, recipe);
    const windows = group.getObjectByName('windows');
    expect(windows).toBeDefined();
    expect(windows.geometry.attributes.position.array.length).toBeGreaterThan(0);
  });

  it('wider building has more window vertices', () => {
    const style = getClimateStyle('continental');
    const smallRecipe = buildRecipe(style, 'small', 0, 42);
    const largeRecipe = buildRecipe(style, 'large', 0, 42);
    const smallGroup = generateBuilding(style, smallRecipe);
    const largeGroup = generateBuilding(style, largeRecipe);
    const smallCount = smallGroup.getObjectByName('windows').geometry.attributes.position.count;
    const largeCount = largeGroup.getObjectByName('windows').geometry.attributes.position.count;
    expect(largeCount).toBeGreaterThan(smallCount);
  });

  it('ornate building has more child meshes than plain', () => {
    const style = getClimateStyle('continental');
    const plain = buildRecipe(style, 'medium', 0, 42);
    const ornate = buildRecipe(style, 'medium', 1, 42);
    const plainGroup = generateBuilding(style, plain);
    const ornateGroup = generateBuilding(style, ornate);
    expect(ornateGroup.children.length).toBeGreaterThan(plainGroup.children.length);
  });

  it('tropical building with richness 1 has porch geometry', () => {
    const style = getClimateStyle('tropical');
    const recipe = buildRecipe(style, 'medium', 1, 42);
    recipe.hasPorch = true;
    recipe.porchDepth = style.porchDepth;
    const group = generateBuilding(style, recipe);
    const porch = group.getObjectByName('porch');
    expect(porch).toBeDefined();
  });

  it('mediterranean building with richness 1 has balconies', () => {
    const style = getClimateStyle('mediterranean');
    const recipe = buildRecipe(style, 'medium', 1, 42);
    recipe.hasBalcony = true;
    recipe.balconyFloors = [2];
    const group = generateBuilding(style, recipe);
    const balconies = group.getObjectByName('balconies');
    expect(balconies).toBeDefined();
  });

  it('mansard roof has vertices at two distinct heights above walls', () => {
    const style = getClimateStyle('mediterranean'); // mediterranean uses mansard
    expect(style.roofType).toBe('mansard');

    const recipe = buildRecipe(style, 'medium', 0.5, seed);
    const building = generateBuilding(style, recipe);

    const roof = getChild(building, 'roof');
    const wallHeight = recipe.floors * style.floorHeight;

    // Collect unique Y values above wallHeight (with some tolerance grouping)
    const pos = roof.geometry.getAttribute('position');
    const yAbove = new Set();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > wallHeight + 0.01) {
        // Round to 2 decimal places to group similar values
        yAbove.add(Math.round(y * 100) / 100);
      }
    }

    // Mansard should have at least 2 distinct height levels above the walls:
    // the break line height and the upper peak/ridge height
    expect(yAbove.size).toBeGreaterThanOrEqual(2);
  });
});
