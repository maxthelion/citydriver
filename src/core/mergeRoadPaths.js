/**
 * Merge road paths that share grid cells.
 * Shared portions are kept once; unique tails become separate segments.
 *
 * Input: Array<{ cells: Array<{gx, gz}>, rank: number }>
 * Output: Array<{ cells: Array<{gx, gz}> }>
 */

export function mergeRoadPaths(paths) {
  if (paths.length === 0) return [];

  // Build cell -> path membership lookup
  const cellPaths = new Map(); // "gx,gz" -> Set<pathIndex>

  for (let pi = 0; pi < paths.length; pi++) {
    for (const c of paths[pi].cells) {
      const key = `${c.gx},${c.gz}`;
      if (!cellPaths.has(key)) cellPaths.set(key, new Set());
      cellPaths.get(key).add(pi);
    }
  }

  // Walk each path, split at junctions (cells where path membership changes)
  const segments = [];
  const visited = new Set();

  for (let pi = 0; pi < paths.length; pi++) {
    const cells = paths[pi].cells;
    if (cells.length < 2) continue;

    let currentSeg = [cells[0]];
    let prevKey = membershipKey(cellPaths, cells[0]);

    for (let ci = 1; ci < cells.length; ci++) {
      const cell = cells[ci];
      const key = membershipKey(cellPaths, cell);

      if (key !== prevKey) {
        // Membership changed — end current segment, start new one
        currentSeg.push(cell); // overlap point
        const segKey = segmentKey(currentSeg);
        if (!visited.has(segKey)) {
          visited.add(segKey);
          segments.push({ cells: currentSeg });
        }
        currentSeg = [cell];
        prevKey = key;
      } else {
        currentSeg.push(cell);
      }
    }

    // Final segment
    if (currentSeg.length >= 2) {
      const segKey = segmentKey(currentSeg);
      if (!visited.has(segKey)) {
        visited.add(segKey);
        segments.push({ cells: currentSeg });
      }
    }
  }

  return segments;
}

function membershipKey(cellPaths, cell) {
  const key = `${cell.gx},${cell.gz}`;
  const paths = cellPaths.get(key);
  if (!paths) return '';
  return [...paths].sort().join(',');
}

function segmentKey(cells) {
  const first = cells[0];
  const last = cells[cells.length - 1];
  const a = `${first.gx},${first.gz}`;
  const b = `${last.gx},${last.gz}`;
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}
