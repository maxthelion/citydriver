import { describe, it, expect } from 'vitest';
import { inheritRivers } from '../../src/core/inheritRivers.js';

function makeRiverTree() {
  return [
    {
      points: [
        { x: 0, z: 500, accumulation: 100, width: 10 },
        { x: 200, z: 500, accumulation: 120, width: 12 },
        { x: 400, z: 500, accumulation: 140, width: 14 },
        { x: 600, z: 500, accumulation: 160, width: 16 },
        { x: 800, z: 500, accumulation: 180, width: 18 },
      ],
      children: [
        {
          points: [
            { x: 400, z: 300, accumulation: 50, width: 6 },
            { x: 400, z: 400, accumulation: 60, width: 7 },
            { x: 400, z: 500, accumulation: 70, width: 8 },
          ],
          children: [],
        },
      ],
    },
  ];
}

describe('inheritRivers', () => {
  const bounds = { minX: 100, minZ: 100, maxX: 700, maxZ: 700 };

  it('clips rivers to boundary with interpolated entry point', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    expect(rivers.length).toBeGreaterThanOrEqual(1);
    // Main river should start near x=100 (boundary), not x=200 (first interior point)
    const main = rivers.find(r => r.polyline.length > 3);
    expect(main).toBeDefined();
    // Allow some margin for Chaikin smoothing
    expect(main.polyline[0].x).toBeLessThanOrEqual(150);
  });

  it('clips rivers at trailing boundary too', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    const main = rivers.find(r => r.polyline.length > 3);
    expect(main).toBeDefined();
    const last = main.polyline[main.polyline.length - 1];
    // Should end near x=700 boundary, not x=600 (last interior point)
    expect(last.x).toBeGreaterThanOrEqual(650);
  });

  it('assigns systemId from tree root', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    const ids = rivers.map(r => r.systemId);
    // All rivers from same root should share systemId = 0
    expect(ids.every(id => id === 0)).toBe(true);
  });

  it('different roots get different systemIds', () => {
    const tree = [
      ...makeRiverTree(),
      {
        points: [
          { x: 100, z: 200, accumulation: 80, width: 8 },
          { x: 300, z: 200, accumulation: 90, width: 9 },
          { x: 500, z: 200, accumulation: 100, width: 10 },
        ],
        children: [],
      },
    ];
    const rivers = inheritRivers(tree, bounds);
    const ids = new Set(rivers.map(r => r.systemId));
    expect(ids.size).toBe(2);
  });

  it('interpolates accumulation at boundary crossing', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    const main = rivers.find(r => r.polyline.length > 3);
    // First point should have interpolated accumulation (between 100 and 120 for the crossing near x=100)
    expect(main.polyline[0].accumulation).toBeGreaterThanOrEqual(100);
    expect(main.polyline[0].accumulation).toBeLessThanOrEqual(130);
  });

  it('handles tributary within bounds', () => {
    const rivers = inheritRivers(makeRiverTree(), bounds);
    // Should get at least 2 rivers (main + tributary)
    expect(rivers.length).toBeGreaterThanOrEqual(2);
    // Tributary has points at x=400, z=300-500, all within bounds
    const trib = rivers.find(r =>
      r.polyline.some(p => Math.abs(p.x - 400) < 50 && p.z < 450)
    );
    expect(trib).toBeDefined();
    expect(trib.systemId).toBe(0); // same system as main
  });
});
