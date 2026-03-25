/**
 * Level 2 pipeline postcondition tests.
 *
 * These test structural properties that should hold for any seed after
 * specific pipeline steps. They run to zones-refine only (not full growth)
 * to keep execution time reasonable (~5s per seed).
 *
 * See wiki/pages/pipeline-step-postconditions.md for the spec.
 * See wiki/pages/pipeline-property-testing.md for the testing strategy.
 */

import { describe, it, expect } from 'vitest';
import { generateRegion } from '../../../src/regional/pipeline.js';
import { setupCity } from '../../../src/city/setup.js';
import { SeededRandom } from '../../../src/core/rng.js';
import { ARCHETYPES } from '../../../src/city/archetypes.js';
import { LandFirstDevelopment } from '../../../src/city/strategies/landFirstDevelopment.js';

// Deterministic seeds — broad enough to catch geometry-dependent bugs
const SEEDS = [42, 99, 884469, 979728, 12345, 306752];

function runToZonesRefine(seed) {
  const rng = new SeededRandom(seed);
  const layers = generateRegion({
    width: 128, height: 128, cellSize: 200, seaLevel: 0,
  }, rng);
  const settlement = layers.getData('settlements')?.[0];
  if (!settlement) return null;

  const map = setupCity(layers, settlement, new SeededRandom(seed).fork('city'));
  const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });

  const snapshots = {};
  let reachedRefine = false;

  strategy.runner.addHook({
    onAfter(stepId) {
      if (stepId === 'skeleton') {
        snapshots.skeleton = {
          roadCount: map.roads?.length || 0,
          graphNodes: map.graph?.nodes?.size || 0,
          graphEdges: map.graph?.edges?.size || 0,
        };
      }
      if (stepId === 'zones') {
        const zones = map.developmentZones || [];
        snapshots.zones = {
          count: zones.length,
          totalCells: zones.reduce((s, z) => s + z.cells.length, 0),
          emptyCellZones: zones.filter(z => z.cells.length === 0).length,
        };
      }
      if (stepId === 'zone-boundary') {
        // Count duplicates
        const seen = new Set();
        let dupes = 0;
        for (const [, e] of map.graph.edges) {
          const key = Math.min(e.from, e.to) + '-' + Math.max(e.from, e.to);
          if (seen.has(key)) dupes++;
          else seen.add(key);
        }
        // Count interior dead ends
        const cs = map.cellSize;
        const margin = cs * 2;
        const mapW = map.width * cs, mapH = map.height * cs;
        const ox = map.originX, oz = map.originZ;
        let interiorDeadEnds = 0;
        for (const [id, node] of map.graph.nodes) {
          if (map.graph.degree(id) !== 1) continue;
          const lx = node.x - ox, lz = node.z - oz;
          if (lx > margin && lz > margin && lx < mapW - margin && lz < mapH - margin) {
            interiorDeadEnds++;
          }
        }
        snapshots.zoneBoundary = { dupes, interiorDeadEnds };
      }
      if (stepId === 'zones-refine') {
        const zones = map.developmentZones || [];
        // Road length stats
        const roadLengths = (map.roads || []).map(r => {
          const pts = r.polyline || r.points || [];
          let len = 0;
          for (let i = 1; i < pts.length; i++) {
            len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
          }
          return len;
        });
        snapshots.refine = {
          count: zones.length,
          totalCells: zones.reduce((s, z) => s + z.cells.length, 0),
          emptyCellZones: zones.filter(z => z.cells.length === 0).length,
          noEdgeRefs: zones.filter(z => !z.boundingEdgeIds || z.boundingEdgeIds.length === 0).length,
          maxBoundaryVertices: Math.max(0, ...zones.map(z => z.boundary?.length || 0)),
          stubRoads: roadLengths.filter(l => l < 15).length,
          degenerateRoads: roadLengths.filter(l => l < 3).length,
        };
        reachedRefine = true;
      }
    },
  });

  while (strategy.tick() && !reachedRefine) {}
  return { map, snapshots };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const seed of SEEDS) {
  describe(`postconditions (seed ${seed})`, { timeout: 60000 }, () => {
    let result;

    it('pipeline reaches zones-refine', () => {
      result = runToZonesRefine(seed);
      expect(result).not.toBeNull();
      expect(result.snapshots.refine).toBeDefined();
    });

    // ── Skeleton ──

    it('skeleton produces roads', () => {
      if (!result) return;
      expect(result.snapshots.skeleton.roadCount).toBeGreaterThan(0);
    });

    // ── Zones (initial) ──

    it('initial zone extraction produces zones', () => {
      if (!result) return;
      expect(result.snapshots.zones.count).toBeGreaterThan(0);
    });

    it('initial zones have cells', () => {
      if (!result) return;
      expect(result.snapshots.zones.emptyCellZones).toBe(0);
    });

    // ── Zone boundary ──

    it('no duplicate edges after zone-boundary', () => {
      if (!result) return;
      expect(result.snapshots.zoneBoundary.dupes).toBe(0);
    });

    // NOTE: interior dead ends are currently systemic (100+ per seed).
    // This test documents the current state and will be tightened as
    // subdivideLargeZones is fixed.
    it('interior dead ends are within bounds', () => {
      if (!result) return;
      // Currently ~100-140 per seed. Target: < 10.
      // For now, just assert it's not getting worse.
      expect(result.snapshots.zoneBoundary.interiorDeadEnds).toBeLessThan(200);
    });

    // ── Zones refine ──

    it('zones-refine produces more zones than initial', () => {
      if (!result) return;
      expect(result.snapshots.refine.count).toBeGreaterThanOrEqual(result.snapshots.zones.count);
    });

    it('zones-refine zones all have cells', () => {
      if (!result) return;
      expect(result.snapshots.refine.emptyCellZones).toBe(0);
    });

    it('zone boundary polygons have reasonable vertex counts', () => {
      if (!result) return;
      // Douglas-Peucker simplification should keep polygons manageable.
      // >500 vertices suggests the simplification isn't working.
      expect(result.snapshots.refine.maxBoundaryVertices).toBeLessThan(500);
    });

    it('no degenerate roads (< 3m)', () => {
      if (!result) return;
      expect(result.snapshots.refine.degenerateRoads).toBe(0);
    });

    it('few stub roads (< 15m)', () => {
      if (!result) return;
      // Currently 1-4 per seed. Target: 0.
      expect(result.snapshots.refine.stubRoads).toBeLessThan(10);
    });

    // NOTE: zones without edge refs are currently 7-21 per seed.
    // This test documents the current state. Target: 0.
    it('most zones have bounding edge references', () => {
      if (!result) return;
      const noRefs = result.snapshots.refine.noEdgeRefs;
      const total = result.snapshots.refine.count;
      // At least 80% of zones should have edge refs
      expect(noRefs / total).toBeLessThan(0.2);
    });

    it('zone coverage is substantial', () => {
      if (!result) return;
      // Total zone cells should be a meaningful fraction of the map
      const mapCells = result.map.width * result.map.height;
      const waterMask = result.map.getLayer('waterMask');
      let waterCells = 0;
      if (waterMask) {
        for (let gz = 0; gz < result.map.height; gz++)
          for (let gx = 0; gx < result.map.width; gx++)
            if (waterMask.get(gx, gz) > 0) waterCells++;
      }
      const landCells = mapCells - waterCells;
      const coverage = result.snapshots.refine.totalCells / landCells;
      expect(coverage).toBeGreaterThan(0.1);
    });
  });
}
