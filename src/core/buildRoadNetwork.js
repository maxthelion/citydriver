/**
 * Shared road-building pipeline used by both regional and city scales.
 *
 * Given a set of connections (from/to pairs) and a grid with a cost function:
 * 1. Pathfind each connection (stamping roadGrid after each for reuse discount)
 * 2. Merge shared segments via mergeRoadPaths
 * 3. Simplify (RDP) + smooth (Chaikin) the merged segments
 * 4. Return the results for the caller to handle
 *
 * This is the abstraction the spec called for — both generateRoads.js and
 * skeleton.js call this instead of implementing the pipeline independently.
 */

import { findPath, simplifyPath, smoothPath, gridPathToWorldPolyline } from './pathfinding.js';
import { mergeRoadPaths } from './mergeRoadPaths.js';

const HIER_RANK = { arterial: 1, collector: 2, local: 3, track: 4 };
const RANK_HIER = { 1: 'arterial', 2: 'collector', 3: 'local', 4: 'track' };

/**
 * @param {object} options
 * @param {number} options.width - Grid width
 * @param {number} options.height - Grid height
 * @param {number} options.cellSize - World units per cell
 * @param {Function} options.costFn - A* cost function (fromGx, fromGz, toGx, toGz) => cost
 * @param {Array} options.connections - [{ from: {gx,gz}, to: {gx,gz}, hierarchy }]
 * @param {import('./Grid2D.js').Grid2D} options.roadGrid - Stamped during pathfinding for reuse
 * @param {Array} [options.existingPaths] - [{ cells, hierarchy }] to include in merge
 * @param {object} [options.smooth] - { simplifyEpsilon, chaikinIterations }
 * @param {number} [options.originX=0] - World origin for coordinate conversion
 * @param {number} [options.originZ=0]
 * @returns {Array<{ cells, polyline, hierarchy, from, to }>}
 */
export function buildRoadNetwork(options) {
  const {
    width, height, cellSize,
    costFn, connections, roadGrid,
    existingPaths = [],
    smooth = {},
    originX = 0, originZ = 0,
  } = options;

  const { simplifyEpsilon = 1.0, chaikinIterations = 4 } = smooth;

  // Collect all raw cell paths for merging
  const rawPaths = [];

  // Include existing paths so the merge can split them at new junctions
  for (const ep of existingPaths) {
    if (ep.cells && ep.cells.length >= 2) {
      rawPaths.push({ cells: ep.cells, rank: 1, hierarchy: ep.hierarchy || 'local' });
    }
  }

  // Pathfind each connection, stamp roadGrid between each for reuse
  for (const conn of connections) {
    const result = findPath(
      conn.from.gx, conn.from.gz,
      conn.to.gx, conn.to.gz,
      width, height, costFn,
    );

    if (!result) continue;

    // Stamp onto roadGrid so later pathfinds get the reuse discount
    for (const p of result.path) {
      roadGrid.set(p.gx, p.gz, 1);
    }

    rawPaths.push({
      cells: result.path,
      rank: 1,
      hierarchy: conn.hierarchy || 'local',
    });
  }

  // Snap near-parallel paths onto each other before merging.
  // A* on an 8-connected grid produces paths that can be 1 cell apart through
  // the same corridor. mergeRoadPaths only merges exact cell matches, so we
  // first snap cells to neighboring cells used by earlier paths.
  _snapPaths(rawPaths, width, height);

  // Merge shared segments
  const merged = mergeRoadPaths(rawPaths);

  // Build cell → best hierarchy lookup from original paths
  const cellBestHier = new Map();
  for (const p of rawPaths) {
    const rank = HIER_RANK[p.hierarchy] || 4;
    for (const c of p.cells) {
      const key = `${c.gx},${c.gz}`;
      const prev = cellBestHier.get(key) || 9;
      if (rank < prev) cellBestHier.set(key, rank);
    }
  }

  // Simplify, smooth, and build output
  const results = [];
  for (const seg of merged) {
    if (seg.cells.length < 2) continue;

    const simplified = simplifyPath(seg.cells, simplifyEpsilon);

    // Derive hierarchy from best original path that used these cells
    let bestRank = 9;
    for (const c of seg.cells) {
      const r = cellBestHier.get(`${c.gx},${c.gz}`) || 9;
      if (r < bestRank) bestRank = r;
    }
    const hierarchy = RANK_HIER[bestRank] || 'local';

    // Convert to world coordinates
    let polyline;
    if (chaikinIterations > 0) {
      const smoothed = smoothPath(simplified, cellSize, chaikinIterations);
      polyline = smoothed.map(p => ({
        x: p.x + originX,
        z: p.z + originZ,
      }));
    } else {
      polyline = gridPathToWorldPolyline(simplified, cellSize, originX, originZ);
    }

    results.push({
      cells: seg.cells,
      path: simplified,  // grid-coord simplified path (always present)
      polyline,           // world-coord smoothed polyline (null if no smoothing)
      hierarchy,
      from: { gx: seg.cells[0].gx, gz: seg.cells[0].gz },
      to: { gx: seg.cells[seg.cells.length - 1].gx, gz: seg.cells[seg.cells.length - 1].gz },
    });
  }

  return results;
}

/**
 * Snap cells in later paths onto cells from earlier paths when within 1 cell.
 * This collapses near-parallel paths (the 1-cell-offset diamond problem) into
 * shared cells that mergeRoadPaths can then deduplicate.
 */
function _snapPaths(rawPaths, width, height) {
  // Build a grid of which cells are used by paths, tracking the earliest path index
  const used = new Int16Array(width * height).fill(-1);

  for (let pi = 0; pi < rawPaths.length; pi++) {
    const cells = rawPaths[pi].cells;
    const snapped = [];

    for (const cell of cells) {
      const { gx, gz } = cell;
      const idx = gz * width + gx;

      // Check if this exact cell is already used by an earlier path
      if (used[idx] >= 0 && used[idx] < pi) {
        snapped.push(cell);
        continue;
      }

      // Check 8-connected neighbors for cells from earlier paths
      let bestNeighbor = null;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = gx + dx, nz = gz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
          const nIdx = nz * width + nx;
          if (used[nIdx] >= 0 && used[nIdx] < pi) {
            bestNeighbor = { gx: nx, gz: nz };
            break;
          }
        }
        if (bestNeighbor) break;
      }

      if (bestNeighbor) {
        // Snap to the neighboring cell from an earlier path
        snapped.push(bestNeighbor);
      } else {
        snapped.push(cell);
      }
    }

    // Update the path with snapped cells
    rawPaths[pi].cells = snapped;

    // Mark all cells in this path as used
    for (const cell of snapped) {
      const idx = cell.gz * width + cell.gx;
      if (used[idx] < 0) {
        used[idx] = pi;
      }
    }
  }
}
