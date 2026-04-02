/**
 * Polyline and graph invariant checkers.
 *
 * Checks road network structural consistency:
 *   - Every road has ≥ 2 polyline points
 *   - Every polyline point is within map bounds
 *   - graph.edges.size matches the total number of way segments
 *   - Every graph node has degree ≥ 1 (no orphaned nodes)
 *   - Bridge bank points are on dry land
 *
 * Spec: specs/v5/next-steps.md § Step 2
 */

/**
 * Check all polyline/graph invariants.
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @returns {{ degenerateRoads: number, outOfBoundsPoints: number,
 *             graphEdgeMismatch: boolean, orphanNodes: number, bridgeBanksOnWater: number,
 *             duplicateEdges: number, danglingEdges: number }}
 */
export function checkAllPolylineInvariants(map) {
  const result = {
    degenerateRoads:   0,
    outOfBoundsPoints: 0,
    graphEdgeMismatch: false,
    orphanNodes:       0,
    bridgeBanksOnWater: 0,
    duplicateEdges:    0,
    danglingEdges:     0,
  };

  const network = map.roadNetwork;
  if (!network) return result;

  const graph = network.graph ?? map.graph;
  if (!graph) return result;

  const w = map.width;
  const h = map.height;
  const cs = map.cellSize ?? 1;
  const ox = map.originX ?? 0;
  const oz = map.originZ ?? 0;

  let expectedEdgeCount = 0;

  // Check every way
  for (const way of network.ways) {
    const pts = way.polyline ?? way.points ?? [];

    // Must have at least 2 points
    if (pts.length < 2) {
      result.degenerateRoads++;
      continue;
    }

    expectedEdgeCount += Math.max(0, pts.length - 1);

    // Every point must be within world bounds (allow 1-cell tolerance for
    // sub-cell floating-point drift from ribbon layout near map edges)
    const worldW = w * cs;
    const worldH = h * cs;
    const margin = cs; // 1 cell
    for (const pt of pts) {
      const lx = pt.x - ox;
      const lz = pt.z - oz;
      if (lx < -margin || lz < -margin || lx > worldW + margin || lz > worldH + margin) {
        result.outOfBoundsPoints++;
      }
    }
  }

  if (graph.edges && graph.edges.size !== expectedEdgeCount) {
    result.graphEdgeMismatch = true;
  }

  // Every graph node must have degree ≥ 1
  if (graph.nodes) {
    for (const [nodeId] of graph.nodes) {
      if (graph.degree(nodeId) === 0) {
        result.orphanNodes++;
      }
    }
  }

  // Bridge bank points must be on dry land
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  if (waterMask) {
    for (const way of network.ways) {
      const bridges = way.bridges ?? [];
      for (const bridge of bridges) {
        for (const bank of [bridge.bankA, bridge.bankB]) {
          if (!bank) continue;
          const gx = Math.floor((bank.x - ox) / cs);
          const gz = Math.floor((bank.z - oz) / cs);
          if (gx >= 0 && gx < w && gz >= 0 && gz < h) {
            if (waterMask.get(gx, gz) > 0) result.bridgeBanksOnWater++;
          }
        }
      }
    }
  }

  // Duplicate edges: two different edge IDs connecting the same node pair
  if (graph.edges) {
    const seen = new Set();
    for (const [, edge] of graph.edges) {
      const lo = Math.min(edge.from, edge.to);
      const hi = Math.max(edge.from, edge.to);
      const key = `${lo}-${hi}`;
      if (seen.has(key)) {
        result.duplicateEdges++;
      } else {
        seen.add(key);
      }
    }
  }

  // Dangling edges: degree-1 nodes NOT near the map boundary (within 2 cells of edge).
  // These are dead-end graph nodes from clipped road segments that break DCEL face extraction.
  if (graph.nodes) {
    const boundaryMargin = cs * 2;
    const worldW = w * cs;
    const worldH = h * cs;
    for (const [nodeId, node] of graph.nodes) {
      if (graph.degree(nodeId) !== 1) continue;
      const lx = node.x - ox;
      const lz = node.z - oz;
      const nearBoundary =
        lx < boundaryMargin || lz < boundaryMargin ||
        lx > worldW - boundaryMargin || lz > worldH - boundaryMargin;
      if (!nearBoundary) {
        result.danglingEdges++;
      }
    }
  }

  return result;
}

/**
 * Create a PipelineRunner hook that checks polyline/graph invariants after every step.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 * @param {(stepId: string, invariantName: string, detail: any) => void} onViolation
 * @returns {{ onAfter: Function }}
 */
export function makePolylineInvariantHook(map, onViolation) {
  return {
    onAfter(stepId) {
      const r = checkAllPolylineInvariants(map);
      if (r.degenerateRoads   > 0)  onViolation(stepId, 'degenerateRoads',   r.degenerateRoads);
      if (r.outOfBoundsPoints > 0)  onViolation(stepId, 'outOfBoundsPoints', r.outOfBoundsPoints);
      if (r.graphEdgeMismatch)      onViolation(stepId, 'graphEdgeMismatch', true);
      if (r.orphanNodes       > 0)  onViolation(stepId, 'orphanNodes',       r.orphanNodes);
      if (r.bridgeBanksOnWater > 0) onViolation(stepId, 'bridgeBanksOnWater', r.bridgeBanksOnWater);
      if (r.duplicateEdges    > 0)  onViolation(stepId, 'duplicateEdges',    r.duplicateEdges);
      if (r.danglingEdges     > 0)  onViolation(stepId, 'danglingEdges',     r.danglingEdges);
    },
  };
}
