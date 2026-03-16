import { describe, it, expect } from 'vitest';
import { layerSlug, layerIndexFromSlug, LAYERS } from '../../src/rendering/debugLayers.js';

describe('layerSlug', () => {
  it('converts simple names', () => {
    expect(layerSlug('Land Value')).toBe('land-value');
    expect(layerSlug('Composite')).toBe('composite');
  });

  it('strips parentheses', () => {
    expect(layerSlug('Path Cost (growth)')).toBe('path-cost-growth');
    expect(layerSlug('Path Cost (nucleus)')).toBe('path-cost-nucleus');
  });

  it('strips colons', () => {
    expect(layerSlug('Coverage: Water')).toBe('coverage-water');
    expect(layerSlug('Coverage: Road')).toBe('coverage-road');
    expect(layerSlug('Coverage: Land Cover')).toBe('coverage-land-cover');
  });

  it('handles multi-word names', () => {
    expect(layerSlug('Development Pressure')).toBe('development-pressure');
    expect(layerSlug('Terrain Suitability')).toBe('terrain-suitability');
  });
});

describe('layerIndexFromSlug', () => {
  it('returns index for valid slug', () => {
    expect(layerIndexFromSlug('composite')).toBe(0);
    expect(layerIndexFromSlug('land-value')).toBe(LAYERS.findIndex(l => l.name === 'Land Value'));
  });

  it('returns -1 for unknown slug', () => {
    expect(layerIndexFromSlug('nonexistent')).toBe(-1);
  });
});
