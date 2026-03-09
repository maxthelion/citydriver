import { describe, it, expect } from 'vitest';
import { CLIMATES, getClimateStyle, buildRecipe } from '../../src/buildings/styles.js';

describe('CLIMATES', () => {
  it('contains all 6 climate keys', () => {
    expect(CLIMATES).toEqual([
      'cold',
      'temperate',
      'continental',
      'mediterranean',
      'tropical',
      'arid',
    ]);
  });
});

describe('getClimateStyle', () => {
  const REQUIRED_FIELDS = [
    'floorHeight',
    'floorCountRange',
    'roofType',
    'roofPitch',
    'roofOverhang',
    'windowWidth',
    'windowHeight',
    'windowSpacing',
    'windowHeightDecay',
    'hasPorch',
    'porchDepth',
    'hasBalcony',
    'balconyFloors',
    'hasDormers',
    'wingProbability',
    'wallColor',
    'roofColor',
    'trimColor',
    'windowColor',
  ];

  it('returns a valid style with all required fields for each climate', () => {
    for (const climate of CLIMATES) {
      const style = getClimateStyle(climate);
      for (const field of REQUIRED_FIELDS) {
        expect(style, `${climate} missing ${field}`).toHaveProperty(field);
      }

      // Validate value ranges
      expect(style.floorHeight).toBeGreaterThanOrEqual(2.8);
      expect(style.floorHeight).toBeLessThanOrEqual(4.0);
      expect(style.floorCountRange).toHaveLength(2);
      expect(style.floorCountRange[0]).toBeLessThanOrEqual(style.floorCountRange[1]);

      expect(['gable', 'hip', 'flat', 'mansard']).toContain(style.roofType);
      expect(style.roofPitch).toBeGreaterThanOrEqual(0);
      expect(style.roofPitch).toBeLessThanOrEqual(60);
      expect(style.roofOverhang).toBeGreaterThanOrEqual(0);
      expect(style.roofOverhang).toBeLessThanOrEqual(0.5);

      expect(style.windowHeightDecay).toBeGreaterThanOrEqual(0);
      expect(style.windowHeightDecay).toBeLessThanOrEqual(0.1);

      expect(style.wingProbability).toBeGreaterThanOrEqual(0);
      expect(style.wingProbability).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildRecipe', () => {
  const RECIPE_FIELDS = [
    'mainWidth',
    'mainDepth',
    'floors',
    'wings',
    'richness',
    'hasArched',
    'hasQuoins',
    'hasSills',
    'hasCornice',
    'hasPorch',
    'porchDepth',
    'hasBalcony',
    'balconyFloors',
    'hasDormers',
    'dormerCount',
    'chimneyCount',
    'wallColor',
    'roofColor',
    'trimColor',
    'windowColor',
  ];

  it('returns valid recipe for each plot size and richness', () => {
    const plotSizes = ['small', 'medium', 'large'];
    const richnessLevels = [0, 0.5, 1];

    for (const climate of CLIMATES) {
      const style = getClimateStyle(climate);
      for (const plotSize of plotSizes) {
        for (const richness of richnessLevels) {
          const recipe = buildRecipe(style, plotSize, richness, 42);

          for (const field of RECIPE_FIELDS) {
            expect(recipe, `${climate}/${plotSize}/${richness} missing ${field}`).toHaveProperty(
              field
            );
          }

          expect(recipe.mainWidth).toBeGreaterThan(0);
          expect(recipe.mainDepth).toBeGreaterThan(0);
          expect(recipe.floors).toBeGreaterThanOrEqual(style.floorCountRange[0]);
          expect(recipe.floors).toBeLessThanOrEqual(style.floorCountRange[1]);
          expect(recipe.richness).toBe(richness);
          expect(Array.isArray(recipe.wings)).toBe(true);
          expect(Array.isArray(recipe.balconyFloors)).toBe(true);
        }
      }
    }
  });

  it('small plots never have wings; large plots sometimes do across 20 seeds', () => {
    const style = getClimateStyle('temperate');

    // Small plots: never have wings
    for (let seed = 0; seed < 20; seed++) {
      const recipe = buildRecipe(style, 'small', 0.5, seed);
      expect(recipe.wings, `small plot seed ${seed} should have 0 wings`).toHaveLength(0);
    }

    // Large plots: at least one seed should produce wings
    let anyWings = false;
    for (let seed = 0; seed < 20; seed++) {
      const recipe = buildRecipe(style, 'large', 0.5, seed);
      if (recipe.wings.length > 0) {
        anyWings = true;
        // Validate wing structure
        for (const wing of recipe.wings) {
          expect(wing).toHaveProperty('side');
          expect(wing).toHaveProperty('width');
          expect(wing).toHaveProperty('depth');
          expect(wing).toHaveProperty('floors');
          expect(wing.width).toBeGreaterThan(0);
          expect(wing.depth).toBeGreaterThan(0);
          expect(wing.floors).toBeGreaterThanOrEqual(1);
        }
      }
    }
    expect(anyWings, 'at least one large plot in 20 seeds should have wings').toBe(true);
  });

  it('different seeds produce different recipes', () => {
    const style = getClimateStyle('continental');
    const recipe1 = buildRecipe(style, 'medium', 0.5, 100);
    const recipe2 = buildRecipe(style, 'medium', 0.5, 200);

    // At least one dimension or color should differ
    const differs =
      recipe1.mainWidth !== recipe2.mainWidth ||
      recipe1.mainDepth !== recipe2.mainDepth ||
      recipe1.floors !== recipe2.floors ||
      recipe1.wallColor !== recipe2.wallColor;

    expect(differs, 'different seeds should produce different recipes').toBe(true);
  });
});
