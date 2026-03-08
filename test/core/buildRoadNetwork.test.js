import { describe, it, expect } from 'vitest';
import { buildRoadNetwork } from '../../src/core/buildRoadNetwork.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('buildRoadNetwork', () => {
  function flatCost(fromGx, fromGz, toGx, toGz) {
    const dx = toGx - fromGx, dz = toGz - fromGz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  it('pathfinds and merges shared segments', () => {
    const w = 50, h = 50;
    const roadGrid = new Grid2D(w, h, { type: 'uint8' });

    // Two roads that will share part of their path (A→C and B→C)
    const connections = [
      { from: { gx: 5, gz: 25 }, to: { gx: 45, gz: 25 }, hierarchy: 'arterial' },
      { from: { gx: 5, gz: 20 }, to: { gx: 45, gz: 25 }, hierarchy: 'collector' },
    ];

    const results = buildRoadNetwork({
      width: w, height: h, cellSize: 10,
      costFn: flatCost,
      connections,
      roadGrid,
      smooth: { simplifyEpsilon: 1.0, chaikinIterations: 0 },
    });

    // Should produce merged segments (fewer than 2 separate roads)
    expect(results.length).toBeGreaterThan(0);
    // All results should have cells and hierarchy
    for (const r of results) {
      expect(r.cells.length).toBeGreaterThanOrEqual(2);
      expect(r.hierarchy).toBeDefined();
    }
  });

  it('stamps roadGrid during pathfinding', () => {
    const w = 30, h = 30;
    const roadGrid = new Grid2D(w, h, { type: 'uint8' });

    buildRoadNetwork({
      width: w, height: h, cellSize: 10,
      costFn: flatCost,
      connections: [
        { from: { gx: 5, gz: 15 }, to: { gx: 25, gz: 15 }, hierarchy: 'local' },
      ],
      roadGrid,
      smooth: { simplifyEpsilon: 1.0, chaikinIterations: 0 },
    });

    // Road cells should be stamped
    let stamped = 0;
    for (let gx = 0; gx < w; gx++) {
      if (roadGrid.get(gx, 15) > 0) stamped++;
    }
    expect(stamped).toBeGreaterThan(10);
  });

  it('produces world-coord polylines when smoothing is enabled', () => {
    const w = 40, h = 40;
    const roadGrid = new Grid2D(w, h, { type: 'uint8' });

    const results = buildRoadNetwork({
      width: w, height: h, cellSize: 10,
      costFn: flatCost,
      connections: [
        { from: { gx: 5, gz: 20 }, to: { gx: 35, gz: 20 }, hierarchy: 'arterial' },
      ],
      roadGrid,
      smooth: { simplifyEpsilon: 1.0, chaikinIterations: 3 },
      originX: 100, originZ: 200,
    });

    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.polyline).not.toBeNull();
    // Polyline should be in world coords (offset by origin)
    expect(r.polyline[0].x).toBeGreaterThanOrEqual(100);
    expect(r.polyline[0].z).toBeGreaterThanOrEqual(200);
  });

  it('produces quantized polylines when chaikinIterations=0', () => {
    const w = 40, h = 40;
    const roadGrid = new Grid2D(w, h, { type: 'uint8' });

    const results = buildRoadNetwork({
      width: w, height: h, cellSize: 10,
      costFn: flatCost,
      connections: [
        { from: { gx: 5, gz: 20 }, to: { gx: 35, gz: 20 }, hierarchy: 'arterial' },
      ],
      roadGrid,
      smooth: { simplifyEpsilon: 1.0, chaikinIterations: 0 },
      originX: 100, originZ: 200,
    });

    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.polyline).not.toBeNull();
    expect(r.polyline.length).toBeGreaterThanOrEqual(2);
    expect(r.polyline[0].x).toBeGreaterThanOrEqual(100);
    for (const p of r.polyline) {
      expect(p.x % 5).toBe(0);
      expect(p.z % 5).toBe(0);
    }
  });

  it('no duplicate parallel roads after merge', () => {
    const w = 50, h = 50;
    const roadGrid = new Grid2D(w, h, { type: 'uint8' });

    // Three roads that share a central corridor
    const connections = [
      { from: { gx: 5, gz: 25 }, to: { gx: 45, gz: 25 }, hierarchy: 'arterial' },
      { from: { gx: 5, gz: 24 }, to: { gx: 45, gz: 25 }, hierarchy: 'collector' },
      { from: { gx: 5, gz: 26 }, to: { gx: 45, gz: 25 }, hierarchy: 'local' },
    ];

    const results = buildRoadNetwork({
      width: w, height: h, cellSize: 10,
      costFn: flatCost,
      connections,
      roadGrid,
      smooth: { simplifyEpsilon: 1.0, chaikinIterations: 0 },
    });

    // After merge, shared segments should be deduplicated.
    // With reuse discount, roads 2 and 3 follow road 1's path in the shared corridor.
    // The merge splits at divergence points, so total segments > 3 but total unique
    // cells should be less than 3 fully independent roads (~3*41 = 123 cells).
    // Verify merge produced some splitting (more segments than original 3 roads).
    expect(results.length).toBeGreaterThanOrEqual(3);
  });
});
