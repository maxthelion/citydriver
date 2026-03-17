import { describe, it, expect } from 'vitest';
import { inheritRailways } from '../../src/core/inheritRailways.js';

describe('inheritRailways', () => {
  const bounds = { minX: 100, minZ: 100, maxX: 500, maxZ: 500 };

  it('clips railway polylines to city bounds', () => {
    const railways = [{
      polyline: [
        { x: 50, z: 300 },
        { x: 200, z: 300 },
        { x: 400, z: 300 },
        { x: 600, z: 300 },
      ],
      hierarchy: 'trunk',
      phase: 1,
    }];

    const result = inheritRailways(railways, bounds);
    expect(result.length).toBe(1);
    expect(result[0].polyline[0].x).toBeGreaterThanOrEqual(95);
    expect(result[0].polyline[result[0].polyline.length - 1].x).toBeLessThanOrEqual(505);
  });

  it('discards railways entirely outside bounds', () => {
    const railways = [{
      polyline: [{ x: 600, z: 600 }, { x: 700, z: 700 }],
      hierarchy: 'branch',
      phase: 3,
    }];
    const result = inheritRailways(railways, bounds);
    expect(result.length).toBe(0);
  });

  it('preserves hierarchy metadata', () => {
    const railways = [{
      polyline: [{ x: 200, z: 200 }, { x: 400, z: 400 }],
      hierarchy: 'trunk',
      phase: 1,
    }];
    const result = inheritRailways(railways, bounds);
    expect(result[0].hierarchy).toBe('trunk');
    expect(result[0].phase).toBe(1);
  });

  it('returns empty for no railways', () => {
    expect(inheritRailways([], bounds)).toEqual([]);
    expect(inheritRailways(null, bounds)).toEqual([]);
  });
});
