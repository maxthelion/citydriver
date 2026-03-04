/**
 * Phase 6: Plot Subdivision
 *
 * Divides each block into individual building plots:
 *   - District-driven frontage/depth dimensions
 *   - ±10-15% random variation per plot
 *   - Frontage detection along road edges
 *   - Block interior handling (back-to-back in dense, gardens in sparse)
 *   - Plot merging for corners, plazas, landmarks
 */

import { clamp, lerp, distance2D, pointToSegmentDist } from '../core/math.js';

// ---------------------------------------------------------------------------
// Constants: plot dimensions by district character
// ---------------------------------------------------------------------------

/**
 * Plot dimension table: [minFrontage, maxFrontage, minDepth, maxDepth]
 * and setbacks: {front, side, rear}
 */
export const PLOT_DIMS = {
  commercial_core: {
    frontage: [6, 10], depth: [20, 40],
    setbacks: { front: 0, side: 0, rear: 2 },
    style: 'commercial',
  },
  industrial_docks: {
    frontage: [20, 50], depth: [30, 80],
    setbacks: { front: 3, side: 2, rear: 3 },
    style: 'industrial',
  },
  mixed_use: {
    frontage: [8, 12], depth: [15, 25],
    setbacks: { front: 0, side: 0, rear: 3 },
    style: 'mixed',
  },
  dense_residential: {
    frontage: [5, 7], depth: [15, 25],
    setbacks: { front: 0, side: 0, rear: 3 },
    style: 'terrace',
  },
  suburban_residential: {
    frontage: [12, 20], depth: [15, 25],
    setbacks: { front: 4, side: 2, rear: 5 },
    style: 'suburban',
  },
  parkland: {
    frontage: [0, 0], depth: [0, 0],
    setbacks: { front: 0, side: 0, rear: 0 },
    style: 'park',
  },
};

const VARIATION = 0.12; // ±12% random variation

// ---------------------------------------------------------------------------
// Frontage detection
// ---------------------------------------------------------------------------

/**
 * Find frontage edges of a block polygon (edges closest to roads).
 *
 * @param {Array<{x,z}>} polygon - block polygon
 * @param {Array} edges - road edges
 * @returns {Array<{start: {x,z}, end: {x,z}, length: number, edgeIdx: number}>}
 */
function findFrontageEdges(polygon, roadEdges) {
  const frontages = [];

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const edgeLen = distance2D(a.x, a.z, b.x, b.z);
    if (edgeLen < 3) continue;

    // Check midpoint distance to nearest road
    const midX = (a.x + b.x) / 2;
    const midZ = (a.z + b.z) / 2;

    let minRoadDist = Infinity;
    for (const re of roadEdges) {
      if (!re.points || re.points.length < 2) continue;
      for (let j = 0; j < re.points.length - 1; j++) {
        const d = pointToSegmentDist(
          midX, midZ,
          re.points[j].x, re.points[j].z,
          re.points[j + 1].x, re.points[j + 1].z
        );
        if (d < minRoadDist) minRoadDist = d;
      }
    }

    // Consider it a frontage if close to a road
    if (minRoadDist < 15) {
      frontages.push({
        start: a,
        end: b,
        length: edgeLen,
        edgeIdx: i,
        roadDist: minRoadDist,
      });
    }
  }

  // Sort by proximity to road (closest = primary frontage)
  frontages.sort((a, b) => a.roadDist - b.roadDist);

  return frontages;
}

// ---------------------------------------------------------------------------
// Plot subdivision
// ---------------------------------------------------------------------------

/**
 * Subdivide a single block into plots.
 *
 * @param {Object} block
 * @param {Array} roadEdges
 * @param {Object} rng
 * @returns {Array<Object>} plots
 */
function subdivideBlock(block, roadEdges, rng) {
  const character = block.districtCharacter || 'suburban_residential';
  const dims = PLOT_DIMS[character] || PLOT_DIMS.suburban_residential;

  // Skip park blocks
  if (character === 'parkland' || block.landUse === 'park') return [];
  if (block.area < 100) return [];

  const plots = [];

  // Find frontage edges
  const frontages = findFrontageEdges(block.polygon, roadEdges);
  if (frontages.length === 0) return [];

  // Use primary frontage (and secondary if commercial/mixed)
  const useFrontages = (character === 'commercial_core' || character === 'mixed_use')
    ? frontages.slice(0, Math.min(3, frontages.length))
    : frontages.slice(0, 1);

  for (const frontage of useFrontages) {
    const { start, end, length: edgeLen } = frontage;

    // Target frontage width with variation
    const targetFrontage = lerp(dims.frontage[0], dims.frontage[1], rng.next());
    if (targetFrontage <= 0) continue;

    const numPlots = Math.max(1, Math.floor(edgeLen / targetFrontage));

    // Direction along frontage
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1) continue;
    const dirX = dx / len;
    const dirZ = dz / len;

    // Inward normal (perpendicular, pointing into the block)
    // Try both perpendicular directions, pick the one closer to block centroid
    const perpAx = -dirZ;
    const perpAz = dirX;

    const testX = (start.x + end.x) / 2 + perpAx * 10;
    const testZ = (start.z + end.z) / 2 + perpAz * 10;
    const distA = distance2D(testX, testZ, block.centroid.x, block.centroid.z);

    const testX2 = (start.x + end.x) / 2 - perpAx * 10;
    const testZ2 = (start.z + end.z) / 2 - perpAz * 10;
    const distB = distance2D(testX2, testZ2, block.centroid.x, block.centroid.z);

    const inwardX = distA < distB ? perpAx : -perpAx;
    const inwardZ = distA < distB ? perpAz : -perpAz;

    // Target depth with variation
    const maxDepth = Math.sqrt(block.area) * 0.6;
    const targetDepth = Math.min(
      lerp(dims.depth[0], dims.depth[1], rng.next()),
      maxDepth
    );
    if (targetDepth <= 0) continue;

    for (let p = 0; p < numPlots; p++) {
      // Vary width slightly
      const variation = 1 + (rng.next() - 0.5) * 2 * VARIATION;
      const plotWidth = targetFrontage * variation;
      const plotDepth = targetDepth * (1 + (rng.next() - 0.5) * 2 * VARIATION);

      const t0 = p / numPlots;
      const t1 = (p + 1) / numPlots;

      // Front edge
      const f0x = start.x + dx * t0;
      const f0z = start.z + dz * t0;
      const f1x = start.x + dx * t1;
      const f1z = start.z + dz * t1;

      // Back edge (extruded inward)
      const b0x = f0x + inwardX * plotDepth;
      const b0z = f0z + inwardZ * plotDepth;
      const b1x = f1x + inwardX * plotDepth;
      const b1z = f1z + inwardZ * plotDepth;

      const polygon = [
        { x: f0x, z: f0z },
        { x: f1x, z: f1z },
        { x: b1x, z: b1z },
        { x: b0x, z: b0z },
      ];

      const frontEdge = [{ x: f0x, z: f0z }, { x: f1x, z: f1z }];

      // Determine flags
      const flags = new Set();
      if (p === 0 || p === numPlots - 1) flags.add('corner');
      if (block.isCorner) flags.add('corner');

      // Check if plaza-facing
      // (Will be set by phase 7 based on plaza proximity)

      plots.push({
        id: -1, // assigned below
        blockId: block.id,
        districtId: block.districtId,
        districtCharacter: character,
        polygon,
        frontage: distance2D(f0x, f0z, f1x, f1z),
        depth: plotDepth,
        frontEdge,
        style: dims.style,
        setbacks: { ...dims.setbacks },
        density: block.density,
        flags,
      });
    }
  }

  return plots;
}

// ---------------------------------------------------------------------------
// Plot merging
// ---------------------------------------------------------------------------

/**
 * Merge adjacent plots for special uses (corners, landmarks, plazas).
 */
function mergePlots(plots, blocks, roadNetwork) {
  // Mark corner plots
  for (const plot of plots) {
    if (plot.flags.has('corner') && plot.frontage < 15) {
      // Look for adjacent plot to merge with
      const block = blocks.find(b => b.id === plot.blockId);
      if (!block) continue;

      const neighborPlots = plots.filter(p =>
        p.blockId === plot.blockId &&
        p.id !== plot.id &&
        distance2D(
          (p.polygon[0].x + p.polygon[1].x) / 2,
          (p.polygon[0].z + p.polygon[1].z) / 2,
          (plot.polygon[0].x + plot.polygon[1].x) / 2,
          (plot.polygon[0].z + plot.polygon[1].z) / 2,
        ) < plot.frontage * 2
      );

      if (neighborPlots.length > 0) {
        plot.flags.add('merged');
        // Double the frontage
        plot.frontage *= 1.5;
      }
    }
  }

  // Mark plaza-facing plots
  for (const node of roadNetwork.nodes.values()) {
    if (node.type !== 'plaza') continue;

    for (const plot of plots) {
      const frontMid = {
        x: (plot.frontEdge[0].x + plot.frontEdge[1].x) / 2,
        z: (plot.frontEdge[0].z + plot.frontEdge[1].z) / 2,
      };
      if (distance2D(frontMid.x, frontMid.z, node.x, node.z) < 40) {
        plot.flags.add('plaza_facing');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 6 entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 6: Plot Subdivision.
 *
 * @param {Array} blocks - from Phase 5
 * @param {Object} roadNetwork - from Phases 2+4+5
 * @param {Array} districts - from Phase 4
 * @param {Object} rng
 * @returns {Array<Object>} plots
 */
export function runPhase6(blocks, roadNetwork, districts, rng) {
  const plotRng = rng.fork('plots');
  let plotId = 0;
  const allPlots = [];

  for (const block of blocks) {
    const plots = subdivideBlock(block, roadNetwork.edges, plotRng.fork(`b${block.id}`));
    for (const plot of plots) {
      plot.id = plotId++;
      allPlots.push(plot);
    }
  }

  // Merge plots for special uses
  mergePlots(allPlots, blocks, roadNetwork);

  return allPlots;
}
