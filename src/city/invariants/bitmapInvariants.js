/**
 * Bitmap (grid-level) invariant checkers.
 *
 * Each checker takes a FeatureMap and returns an array of violation objects.
 * An empty array means no violations — the invariant holds.
 *
 * All checks are O(width × height) — one pass over the grid, checking every cell.
 * Running all six checks in one combined pass is ~2× faster than running separately.
 *
 * Usage:
 *   const violations = checkAllBitmapInvariants(map);
 *   // or attach as a PipelineRunner hook:
 *   runner.addHook({ onAfter(id, _, ms) { checkAndReport(map, id); } });
 *
 * Spec: specs/v5/next-steps.md § Step 2
 */

/**
 * Run all bitmap invariants in a single grid pass.
 * Returns a map of { invariantName: violationCount }.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @returns {{ noRoadOnWater: number, noRailOnWater: number, noZoneOnWater: number,
 *             noResOutsideZone: number, bridgesOnlyOnWater: number }}
 */
export function checkAllBitmapInvariants(map) {
  const w = map.width;
  const h = map.height;

  const waterMask    = map.hasLayer('waterMask')      ? map.getLayer('waterMask')      : null;
  const roadGrid     = map.hasLayer('roadGrid')        ? map.getLayer('roadGrid')        : null;
  const railGrid     = map.hasLayer('railwayGrid')     ? map.getLayer('railwayGrid')     : null;
  const bridgeGrid   = map.hasLayer('bridgeGrid')      ? map.getLayer('bridgeGrid')      : null;
  const zoneGrid     = map.hasLayer('zoneGrid')        ? map.getLayer('zoneGrid')        : null;
  const resGrid      = map.hasLayer('reservationGrid') ? map.getLayer('reservationGrid') : null;

  const counts = {
    noRoadOnWater:     0,
    noRailOnWater:     0,
    noZoneOnWater:     0,
    noResOutsideZone:  0,
    bridgesOnlyOnWater: 0,
  };

  if (!waterMask) return counts; // can't check anything without water mask

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const isWater = waterMask.get(gx, gz) > 0;
      const isRoad  = roadGrid  ? roadGrid.get(gx, gz)   > 0 : false;
      const isRail  = railGrid  ? railGrid.get(gx, gz)   > 0 : false;
      const isBridge = bridgeGrid ? bridgeGrid.get(gx, gz) > 0 : false;
      const inZone  = zoneGrid  ? zoneGrid.get(gx, gz)   > 0 : false;
      const isRes   = resGrid   ? resGrid.get(gx, gz)    > 0 : false;

      // Roads must not be on water — except bridge cells (bridges intentionally cross water)
      if (isWater && isRoad && !isBridge) counts.noRoadOnWater++;
      // Railways must not be on water
      if (isWater && isRail)   counts.noRailOnWater++;
      // Zones must not overlap water
      if (isWater && inZone)   counts.noZoneOnWater++;
      // Reserved cells must be within zones
      if (isRes && !inZone)    counts.noResOutsideZone++;
      // Bridges must only be on water cells
      if (isBridge && !isWater) counts.bridgesOnlyOnWater++;
    }
  }

  return counts;
}

/**
 * Check a single named invariant.
 * Returns violation count.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {'noRoadOnWater'|'noRailOnWater'|'noZoneOnWater'|'noResOutsideZone'|'bridgesOnlyOnWater'} name
 * @returns {number}
 */
export function checkBitmapInvariant(map, name) {
  return checkAllBitmapInvariants(map)[name];
}

/**
 * Create a PipelineRunner hook that checks all bitmap invariants after every step
 * and calls onViolation(stepId, invariantName, count) for any violations found.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {(stepId: string, invariantName: string, count: number) => void} onViolation
 * @returns {{ onAfter: Function }}
 */
export function makeBitmapInvariantHook(map, onViolation) {
  return {
    onAfter(stepId) {
      const counts = checkAllBitmapInvariants(map);
      for (const [name, count] of Object.entries(counts)) {
        if (count > 0) onViolation(stepId, name, count);
      }
    },
  };
}
