/**
 * Merge overlapping cell-level road paths.
 *
 * Given an array of paths (each a sequence of {gx,gz} cells with a rank),
 * finds where paths share cells, splits them at divergence points, and
 * deduplicates shared portions — keeping the highest-ranked version.
 *
 * Returns an array of unique segments, each with its cell path and the
 * best (lowest) rank among all roads that used those cells.
 *
 * @param {Array<{ cells: Array<{gx,gz}>, rank: number }>} paths
 *   Each path is a sequence of grid cells with a numeric rank (lower = higher priority).
 * @returns {Array<{ cells: Array<{gx,gz}>, rank: number }>}
 *   Deduplicated segments.
 */
export function mergeRoadPaths(paths) {
  if (paths.length <= 1) return paths.map(p => ({ cells: p.cells, rank: p.rank }));

  // Build cell → set of path indices
  const cellToPaths = new Map(); // "gx,gz" → Set<pathIndex>
  for (let pi = 0; pi < paths.length; pi++) {
    for (const c of paths[pi].cells) {
      const key = `${c.gx},${c.gz}`;
      if (!cellToPaths.has(key)) cellToPaths.set(key, new Set());
      cellToPaths.get(key).add(pi);
    }
  }

  // Walk each path, split at divergence points (where co-occupying set changes),
  // emit each segment once (from the best-ranked path in the shared set).
  const result = [];
  const emitted = new Set(); // segment keys for deduplication

  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi];
    const cells = path.cells;
    if (!cells || cells.length < 2) continue;

    // Walk cells, track where the sharing set changes
    const segments = [];
    let segStart = 0;
    let prevSet = cellToPaths.get(`${cells[0].gx},${cells[0].gz}`) || new Set();

    for (let i = 1; i < cells.length; i++) {
      const curSet = cellToPaths.get(`${cells[i].gx},${cells[i].gz}`) || new Set();

      if (!setsEqual(curSet, prevSet)) {
        segments.push({ startIdx: segStart, endIdx: i, coPaths: new Set(prevSet) });
        segStart = i;
        prevSet = curSet;
      }
    }
    segments.push({ startIdx: segStart, endIdx: cells.length - 1, coPaths: new Set(prevSet) });

    for (const seg of segments) {
      const isShared = seg.coPaths.size > 1;

      if (isShared) {
        // Only emit from the best-ranked (lowest rank number) path
        let bestPi = pi;
        let bestRank = path.rank;
        for (const otherPi of seg.coPaths) {
          if (paths[otherPi].rank < bestRank) {
            bestRank = paths[otherPi].rank;
            bestPi = otherPi;
          }
        }
        if (bestPi !== pi) continue;
      }

      const segCells = cells.slice(seg.startIdx, seg.endIdx + 1);
      if (segCells.length < 2) continue;

      // Dedup by start+end cell (either direction)
      const s = segCells[0], e = segCells[segCells.length - 1];
      const keyA = `${s.gx},${s.gz}|${e.gx},${e.gz}`;
      const keyB = `${e.gx},${e.gz}|${s.gx},${s.gz}`;
      if (emitted.has(keyA) || emitted.has(keyB)) continue;
      emitted.add(keyA);

      // Best rank among all paths sharing this segment
      let bestRank = path.rank;
      for (const otherPi of seg.coPaths) {
        if (paths[otherPi].rank < bestRank) bestRank = paths[otherPi].rank;
      }

      result.push({ cells: segCells, rank: bestRank });
    }
  }

  return result;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
