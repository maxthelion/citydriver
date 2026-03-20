/**
 * Pipeline invariant integration tests.
 *
 * Runs the full city pipeline (LandFirstDevelopment) via PipelineRunner hooks and
 * checks bitmap, polyline, and block invariants after every named step.
 *
 * Any violation causes the test for that invariant × seed pair to fail,
 * reporting which step introduced the violation.
 *
 * Seeds:
 *   42      — general case
 *   99      — different terrain/settlement layout
 *   751119  — river city (railways near water)
 *
 * Spec: specs/v5/next-steps.md § Step 2
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getRegion } from '../fixtures.js';
import { setupCity } from '../../src/city/setup.js';
import { SeededRandom } from '../../src/core/rng.js';
import { ARCHETYPES } from '../../src/city/archetypes.js';
import { LandFirstDevelopment } from '../../src/city/strategies/landFirstDevelopment.js';
import { checkAllBitmapInvariants } from '../../src/city/invariants/bitmapInvariants.js';
import { checkAllPolylineInvariants } from '../../src/city/invariants/polylineInvariants.js';
import { checkAllBlockInvariants } from '../../src/city/invariants/blockInvariants.js';

const SEEDS = [42, 99, 751119];
const ARCHETYPE = ARCHETYPES.marketTown;

/**
 * Run the full pipeline with all three invariant checkers attached as hooks.
 * Records violations per step per invariant.
 *
 * @param {number} seed
 * @returns {{ violations: Map<string, object>, finalBitmap: object,
 *             finalPolyline: object, finalBlock: object }}
 */
function runPipelineWithInvariants(seed) {
  const region = getRegion(seed);
  if (!region || !region.settlement) return null;

  const rng = new SeededRandom(seed);
  const map = setupCity(region.layers, region.settlement, rng.fork('city'));

  const violations = new Map(); // stepId → { bitmap, polyline, block }

  const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPE });

  strategy.runner.addHook({
    onAfter(stepId) {
      const bitmap   = checkAllBitmapInvariants(map);
      const polyline = checkAllPolylineInvariants(map);
      const block    = checkAllBlockInvariants(map);

      const hasBitmap   = Object.values(bitmap).some(v => v > 0);
      const hasPolyline = Object.values(polyline).some(v => v > 0 || v === true);
      const hasBlock    = Object.values(block).some(v => v > 0);

      if (hasBitmap || hasPolyline || hasBlock) {
        violations.set(stepId, { bitmap, polyline, block });
      }
    },
  });

  // Run to completion
  while (strategy.tick()) {}

  // Final check after completion
  const finalBitmap   = checkAllBitmapInvariants(map);
  const finalPolyline = checkAllPolylineInvariants(map);
  const finalBlock    = checkAllBlockInvariants(map);

  return { violations, finalBitmap, finalPolyline, finalBlock, map };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const seed of SEEDS) {
  describe(`pipeline invariants (seed ${seed})`, { timeout: 300000 }, () => {
    let result;

    beforeAll(() => {
      result = runPipelineWithInvariants(seed);
    }, 300000); // 5 minutes — seed 751119 has 50 large zones, takes ~260s

    it('region has a settlement to test', () => {
      const region = getRegion(seed);
      expect(region?.settlement).toBeTruthy();
    });

    // ── Bitmap invariants ──

    it('no road cells on water at any pipeline step', () => {
      if (!result) return;
      const stepViolations = [];
      for (const [stepId, v] of result.violations) {
        if (v.bitmap.noRoadOnWater > 0)
          stepViolations.push(`${stepId}: ${v.bitmap.noRoadOnWater} cells`);
      }
      expect(stepViolations, `noRoadOnWater violations: ${stepViolations.join(', ')}`).toHaveLength(0);
    });

    it('no rail cells on water at any pipeline step', () => {
      if (!result) return;
      const stepViolations = [];
      for (const [stepId, v] of result.violations) {
        if (v.bitmap.noRailOnWater > 0)
          stepViolations.push(`${stepId}: ${v.bitmap.noRailOnWater} cells`);
      }
      expect(stepViolations, `noRailOnWater violations: ${stepViolations.join(', ')}`).toHaveLength(0);
    });

    it('no zone cells on water at any pipeline step', () => {
      if (!result) return;
      const stepViolations = [];
      for (const [stepId, v] of result.violations) {
        if (v.bitmap.noZoneOnWater > 0)
          stepViolations.push(`${stepId}: ${v.bitmap.noZoneOnWater} cells`);
      }
      expect(stepViolations, `noZoneOnWater violations: ${stepViolations.join(', ')}`).toHaveLength(0);
    });

    it('no reservation cells outside zones at any pipeline step', () => {
      if (!result) return;
      const stepViolations = [];
      for (const [stepId, v] of result.violations) {
        if (v.bitmap.noResOutsideZone > 0)
          stepViolations.push(`${stepId}: ${v.bitmap.noResOutsideZone} cells`);
      }
      expect(stepViolations, `noResOutsideZone violations: ${stepViolations.join(', ')}`).toHaveLength(0);
    });

    it('bridge cells only on water at any pipeline step', () => {
      if (!result) return;
      const stepViolations = [];
      for (const [stepId, v] of result.violations) {
        if (v.bitmap.bridgesOnlyOnWater > 0)
          stepViolations.push(`${stepId}: ${v.bitmap.bridgesOnlyOnWater} cells`);
      }
      expect(stepViolations, `bridgesOnlyOnWater violations: ${stepViolations.join(', ')}`).toHaveLength(0);
    });

    // ── Polyline invariants (final state) ──

    it('no degenerate roads (< 2 points) at completion', () => {
      if (!result) return;
      expect(result.finalPolyline.degenerateRoads).toBe(0);
    });

    it('no out-of-bounds polyline points at completion', () => {
      if (!result) return;
      expect(result.finalPolyline.outOfBoundsPoints).toBe(0);
    });

    it('graph edge count matches road count at completion', () => {
      if (!result) return;
      expect(result.finalPolyline.graphEdgeMismatch).toBe(false);
    });

    it('no orphan graph nodes at completion', () => {
      if (!result) return;
      expect(result.finalPolyline.orphanNodes).toBe(0);
    });

    it('no bridge banks on water at completion', () => {
      if (!result) return;
      expect(result.finalPolyline.bridgeBanksOnWater).toBe(0);
    });

    // ── Block invariants (final state) ──

    it('no stale edge refs immediately after zone extraction', () => {
      // staleEdgeRefs is expected to be non-zero at COMPLETION because ribbon layout
      // calls graph.splitEdge() on edges that zones reference (T-junction splitting).
      // This is correct behaviour: zones capture graph topology at extraction time.
      // Instead we check that stale refs are zero right after 'zones' and 'zones-refine'.
      if (!result) return;
      const afterZones      = result.violations.get('zones');
      const afterZonesRefine = result.violations.get('zones-refine');
      const staleAfterZones = afterZones?.block?.staleEdgeRefs ?? 0;
      const staleAfterRefine = afterZonesRefine?.block?.staleEdgeRefs ?? 0;
      expect(staleAfterZones,   'staleEdgeRefs after zones').toBe(0);
      expect(staleAfterRefine, 'staleEdgeRefs after zones-refine').toBe(0);
    });

    it('no cell overlaps between zones at completion', () => {
      if (!result) return;
      expect(result.finalBlock.cellOverlaps).toBe(0);
    });

    it('no empty zones (0 bounding edges) at completion', () => {
      if (!result) return;
      expect(result.finalBlock.emptyZones).toBe(0);
    });
  });
}
