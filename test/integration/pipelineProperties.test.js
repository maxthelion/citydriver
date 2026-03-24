/**
 * Level 2 pipeline property tests.
 *
 * Generates 20 random seeds from a deterministic RNG (master seed 12345),
 * runs the city pipeline to completion ONCE per seed, capturing snapshots
 * at key checkpoints via hooks. Then asserts structural properties that
 * should hold for any valid seed.
 *
 * Some tests are EXPECTED TO FAIL — they expose the zone extraction
 * regression where graph-face extraction produces too few zones for
 * certain seeds.
 *
 * Seeds are generated deterministically so failures are reproducible.
 * Each seed takes 10-30 seconds for the full pipeline.
 *
 * Memory management: each seed runs its pipeline inside a single test
 * function so the map can be GC'd before the next seed starts. We do NOT
 * use the shared fixtures cache (which would hold all 20 regions in memory).
 *
 * Spec: specs/v5/next-steps.md § Step 2 (Level 2)
 */

import { describe, it, expect } from 'vitest';
import { generateRegion } from '../../src/regional/pipeline.js';
import { setupCity } from '../../src/city/setup.js';
import { SeededRandom } from '../../src/core/rng.js';
import { ARCHETYPES } from '../../src/city/archetypes.js';
import { LandFirstDevelopment } from '../../src/city/strategies/landFirstDevelopment.js';

const ARCHETYPE = ARCHETYPES.marketTown;

// ── Deterministic seed generation ─────────────────────────────────────────

/** Generate N random seeds using a deterministic RNG. */
function generateSeeds(masterSeed, count) {
  const rng = new SeededRandom(masterSeed);
  const seeds = [];
  for (let i = 0; i < count; i++) {
    seeds.push(rng.int(1, 999999));
  }
  return seeds;
}

const SEEDS = generateSeeds(12345, 20);

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Count non-water, non-road cells in the map.
 */
function countAvailableCells(map) {
  const { width, height } = map;
  const waterMask = map.waterMask;
  const roadGrid = map.roadGrid;
  let count = 0;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const isWater = waterMask && waterMask.get(gx, gz) > 0;
      const isRoad = roadGrid && roadGrid.get(gx, gz) > 0;
      if (!isWater && !isRoad) count++;
    }
  }
  return count;
}

/**
 * Count connected components in the road graph using BFS.
 */
function countGraphComponents(graph) {
  if (!graph || graph.nodes.size === 0) return 0;

  const visited = new Set();
  let components = 0;

  for (const [nodeId] of graph.nodes) {
    if (visited.has(nodeId)) continue;
    components++;

    const queue = [nodeId];
    visited.add(nodeId);
    while (queue.length > 0) {
      const current = queue.shift();
      for (const neighborId of graph.neighbors(current)) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      }
    }
  }

  return components;
}

/**
 * Count duplicate edges (same pair of nodes connected more than once).
 */
function findDuplicateEdgeCount(graph) {
  if (!graph) return 0;
  const seen = new Set();
  let count = 0;

  for (const [, edge] of graph.edges) {
    const a = Math.min(edge.from, edge.to);
    const b = Math.max(edge.from, edge.to);
    const key = `${a}-${b}`;
    if (seen.has(key)) {
      count++;
    } else {
      seen.add(key);
    }
  }

  return count;
}

// ── Tests ─────────────────────────────────────────────────────────────────
//
// Each seed runs the full pipeline inside a single it() so the map and
// region can be GC'd before the next seed starts. This avoids OOM from
// holding all 20 maps in memory simultaneously.
//
// All property checks for a seed are collected into a failures array and
// reported together at the end.

describe('pipeline property tests (20 seeds)', { timeout: 300000 }, () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      // ── Region generation (no cache — fresh each time for GC) ─────
      const rng = new SeededRandom(seed);
      const layers = generateRegion({
        width: 128,
        height: 128,
        cellSize: 200,
        seaLevel: 0,
      }, rng);
      const settlements = layers.getData('settlements');
      const settlement = settlements && settlements.length > 0 ? settlements[0] : null;

      if (!settlement) return; // no settlement — skip, not a failure

      // ── City setup ────────────────────────────────────────────────
      const cityRng = new SeededRandom(seed);
      const map = setupCity(layers, settlement, cityRng.fork('city'));

      // ── Snapshot collectors ───────────────────────────────────────
      const snapshots = {};
      const stepsRun = [];

      const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPE });

      strategy.runner.addHook({
        onAfter(stepId) {
          stepsRun.push(stepId);

          if (stepId === 'skeleton') {
            snapshots.afterSkeleton = {
              roadCount: map.roads.length,
              nucleiCount: map.nuclei ? map.nuclei.length : 0,
              components: countGraphComponents(map.graph),
            };
          }

          if (stepId === 'zones') {
            const zones = map.developmentZones || [];
            snapshots.afterZones = {
              zoneCount: zones.length,
              totalCells: zones.reduce((s, z) => s + z.cells.length, 0),
              emptyCellZones: zones.filter(z => z.cells.length === 0).length,
              availableCells: countAvailableCells(map),
            };
          }

          if (stepId === 'zone-boundary') {
            snapshots.afterZoneBoundary = {
              duplicateEdgeCount: findDuplicateEdgeCount(map.graph),
            };
          }

          if (stepId === 'zones-refine') {
            const zones = map.developmentZones || [];
            snapshots.afterZonesRefine = {
              zoneCount: zones.length,
              totalCells: zones.reduce((s, z) => s + z.cells.length, 0),
            };
            snapshots.zonesRefineRan = true;
          }
        },
      });

      // ── Run pipeline to completion ────────────────────────────────
      let pipelineError = null;
      try {
        while (strategy.tick()) {}
      } catch (e) {
        pipelineError = e;
      }

      snapshots.final = {
        roadCount: map.roads.length,
        zoneCount: (map.developmentZones || []).length,
      };

      // ── Assertions ────────────────────────────────────────────────
      const failures = [];

      // Pipeline completes without throwing
      if (pipelineError) {
        failures.push(`pipeline threw: ${pipelineError.message}`);
      }

      // After 'skeleton': road network has >= 1 road
      const skSnap = snapshots.afterSkeleton;
      if (skSnap) {
        if (skSnap.roadCount < 1) {
          failures.push(`road count = ${skSnap.roadCount} after skeleton (need >= 1)`);
        }
        // Graph is connected (or has at most as many components as nuclei)
        if (skSnap.components > skSnap.nucleiCount) {
          failures.push(
            `${skSnap.components} graph components > ${skSnap.nucleiCount} nuclei after skeleton`
          );
        }
      }

      // After 'zones': zone count > 0
      const zSnap = snapshots.afterZones;
      if (zSnap) {
        if (zSnap.zoneCount === 0) {
          failures.push('zone count = 0 after zones step');
        }
        // Every zone has cells.length > 0
        if (zSnap.emptyCellZones > 0) {
          failures.push(`${zSnap.emptyCellZones} zones have 0 cells after zones step`);
        }
        // Total zone cells > 10% of non-water, non-road cells
        if (zSnap.availableCells > 0) {
          const ratio = zSnap.totalCells / zSnap.availableCells;
          if (ratio <= 0.10) {
            failures.push(
              `zone coverage: ${zSnap.totalCells} / ${zSnap.availableCells} = ` +
              `${(ratio * 100).toFixed(1)}% (need > 10%)`
            );
          }
        }
      }

      // After 'zone-boundary': no duplicate edges
      const zbSnap = snapshots.afterZoneBoundary;
      if (zbSnap && zbSnap.duplicateEdgeCount > 0) {
        failures.push(
          `${zbSnap.duplicateEdgeCount} duplicate edge(s) in graph after zone-boundary`
        );
      }

      // After 'zones-refine' (if it ran): doesn't collapse zones
      if (snapshots.zonesRefineRan && zSnap && snapshots.afterZonesRefine) {
        const before = zSnap;
        const after = snapshots.afterZonesRefine;

        const minZoneCount = Math.floor(before.zoneCount * 0.5);
        if (after.zoneCount < minZoneCount) {
          failures.push(
            `zones-refine collapsed zones: ${before.zoneCount} -> ${after.zoneCount} ` +
            `(threshold: ${minZoneCount})`
          );
        }

        const minCells = Math.floor(before.totalCells * 0.5);
        if (after.totalCells < minCells) {
          failures.push(
            `zones-refine collapsed cells: ${before.totalCells} -> ${after.totalCells} ` +
            `(threshold: ${minCells})`
          );
        }
      }

      // Final state: road count > 0, zone count > 0
      const fSnap = snapshots.final;
      if (fSnap) {
        if (fSnap.roadCount === 0) {
          failures.push('road count = 0 at completion');
        }
        if (fSnap.zoneCount === 0) {
          failures.push('zone count = 0 at completion');
        }
      }

      // ── Report ────────────────────────────────────────────────────
      expect(
        failures,
        `seed ${seed}: ${failures.length} property violation(s):\n  - ${failures.join('\n  - ')}`
      ).toHaveLength(0);
    });
  }
});
