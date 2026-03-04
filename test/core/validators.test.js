import { describe, it, expect } from 'vitest';
import { runValidators, computeScores, formatResults } from '../../src/validators/framework.js';
import { LayerStack } from '../../src/core/LayerStack.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('Validator Framework', () => {
  function makeLayers() {
    const ls = new LayerStack();
    ls.setGrid('elevation', new Grid2D(4, 4, { fill: 10 }));
    return ls;
  }

  it('runs tier 1 checks (boolean)', () => {
    const checks = [
      { name: 'test_valid', tier: 1, fn: () => true },
    ];
    const result = runValidators(makeLayers(), checks);
    expect(result.valid).toBe(true);
    expect(result.results[0].value).toBe(true);
  });

  it('detects tier 1 failures', () => {
    const checks = [
      { name: 'test_fail', tier: 1, fn: () => false },
    ];
    const result = runValidators(makeLayers(), checks);
    expect(result.valid).toBe(false);
    expect(result.overall).toBe(0);
  });

  it('scores tier 2 checks', () => {
    const checks = [
      { name: 'struct1', tier: 2, fn: () => 0.8 },
      { name: 'struct2', tier: 2, fn: () => 0.6 },
    ];
    const result = runValidators(makeLayers(), checks);
    expect(result.structural).toBeCloseTo(0.7);
  });

  it('scores tier 3 checks', () => {
    const checks = [
      { name: 'qual1', tier: 3, fn: () => 0.9 },
    ];
    const result = runValidators(makeLayers(), checks);
    expect(result.quality).toBeCloseTo(0.9);
  });

  it('computes overall score correctly', () => {
    const checks = [
      { name: 'v', tier: 1, fn: () => true },
      { name: 's', tier: 2, fn: () => 0.8 },
      { name: 'q', tier: 3, fn: () => 0.5 },
    ];
    const result = runValidators(makeLayers(), checks);
    // overall = 0.8 * 0.6 + 0.5 * 0.4 = 0.48 + 0.2 = 0.68
    expect(result.overall).toBeCloseTo(0.68);
  });

  it('overall is 0 when tier 1 fails', () => {
    const checks = [
      { name: 'v', tier: 1, fn: () => false },
      { name: 's', tier: 2, fn: () => 1.0 },
      { name: 'q', tier: 3, fn: () => 1.0 },
    ];
    const result = runValidators(makeLayers(), checks);
    expect(result.overall).toBe(0);
  });

  it('handles crashing validators gracefully', () => {
    const checks = [
      { name: 'crash', tier: 1, fn: () => { throw new Error('boom'); } },
    ];
    const result = runValidators(makeLayers(), checks);
    expect(result.valid).toBe(false);
    expect(result.results[0].error).toBe('boom');
  });

  it('formatResults produces readable output', () => {
    const checks = [
      { name: 'v', tier: 1, fn: () => true },
      { name: 's', tier: 2, fn: () => 0.85 },
    ];
    const result = runValidators(makeLayers(), checks);
    const text = formatResults(result);
    expect(text).toContain('PASS');
    expect(text).toContain('85.0%');
  });

  it('defaults to 1.0 when no tier 2/3 checks exist', () => {
    const checks = [
      { name: 'v', tier: 1, fn: () => true },
    ];
    const result = runValidators(makeLayers(), checks);
    expect(result.structural).toBe(1);
    expect(result.quality).toBe(1);
    expect(result.overall).toBe(1);
  });
});
