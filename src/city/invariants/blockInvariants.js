/**
 * Block (zone/face) invariant checkers.
 *
 * Checks development zone structural consistency:
 *   - boundingEdgeIds all exist in graph.edges (no stale refs)
 *   - No cell overlap between zones (rasterization correctness)
 *   - Every zone has ≥ 1 bounding edge (not a disconnected/empty zone)
 *
 * Spec: specs/v5/next-steps.md § Step 2
 */

/**
 * Check all block/zone invariants.
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @returns {{ staleEdgeRefs: number, cellOverlaps: number, emptyZones: number }}
 */
export function checkAllBlockInvariants(map) {
  const result = {
    staleEdgeRefs: 0,
    cellOverlaps:  0,
    emptyZones:    0,
  };

  const zones = map.developmentZones;
  if (!zones || zones.length === 0) return result;

  const graph = map.roadNetwork?.graph ?? map.graph;

  // Check each zone (only graph-face zones have boundingEdgeIds; legacy flood-fill
  // zones have a 'boundary' polygon but no edge refs — skip them for these checks)
  for (const zone of zones) {
    if (!zone.boundingEdgeIds) continue; // legacy zone format — skip

    // Graph-face zones must have at least one bounding edge
    if (zone.boundingEdgeIds.length === 0) {
      result.emptyZones++;
    }

    // All bounding edge IDs must exist in the graph
    if (graph) {
      for (const edgeId of zone.boundingEdgeIds) {
        if (!graph.edges.has(edgeId)) {
          result.staleEdgeRefs++;
        }
      }
    }
  }

  // Check for cell overlaps between zones
  // Build a set of occupied cell indices; duplicate means overlap.
  const w = map.width;
  const seen = new Set();
  for (const zone of zones) {
    if (!zone.cells) continue;
    for (const cell of zone.cells) {
      const idx = cell.gz * w + cell.gx;
      if (seen.has(idx)) {
        result.cellOverlaps++;
      } else {
        seen.add(idx);
      }
    }
  }

  return result;
}

/**
 * Create a PipelineRunner hook that checks block invariants after every step.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {(stepId: string, invariantName: string, detail: any) => void} onViolation
 * @returns {{ onAfter: Function }}
 */
export function makeBlockInvariantHook(map, onViolation) {
  return {
    onAfter(stepId) {
      const r = checkAllBlockInvariants(map);
      if (r.staleEdgeRefs > 0) onViolation(stepId, 'staleEdgeRefs', r.staleEdgeRefs);
      if (r.cellOverlaps  > 0) onViolation(stepId, 'cellOverlaps',  r.cellOverlaps);
      if (r.emptyZones    > 0) onViolation(stepId, 'emptyZones',    r.emptyZones);
    },
  };
}
