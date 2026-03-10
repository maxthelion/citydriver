/**
 * Merge road paths that share grid cells.
 *
 * Uses a cell-graph approach:
 * 1. Build a graph where each cell is a node, edges connect consecutive cells
 * 2. Identify junctions (degree != 2, or path endpoint)
 * 3. Walk between junctions to extract unique segments
 *
 * Input: Array<{ cells: Array<{gx, gz}>, rank: number }>
 * Output: Array<{ cells: Array<{gx, gz}> }>
 */

export function mergeRoadPaths(paths) {
  if (paths.length === 0) return [];

  // --- Step 1: Build the cell graph ---
  // Each node: { neighbors: Set<key>, isEndpoint: bool }
  const nodes = new Map();

  function getOrCreateNode(key) {
    if (!nodes.has(key)) {
      nodes.set(key, { neighbors: new Set(), isEndpoint: false });
    }
    return nodes.get(key);
  }

  for (let pi = 0; pi < paths.length; pi++) {
    const cells = paths[pi].cells;
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci];
      const key = `${c.gx},${c.gz}`;
      const node = getOrCreateNode(key);

      // Mark first and last cells of each path as endpoints
      if (ci === 0 || ci === cells.length - 1) {
        node.isEndpoint = true;
      }

      if (ci > 0) {
        const prev = cells[ci - 1];
        const prevKey = `${prev.gx},${prev.gz}`;
        // Add bidirectional edge
        node.neighbors.add(prevKey);
        getOrCreateNode(prevKey).neighbors.add(key);
      }
    }
  }

  // --- Step 2: Identify junctions ---
  // A junction is any node where:
  //   - degree != 2 (endpoints of the graph, branches, intersections)
  //   - it is a path endpoint (first or last cell of any input path)
  const junctions = new Set();
  for (const [key, node] of nodes) {
    if (node.neighbors.size !== 2 || node.isEndpoint) {
      junctions.add(key);
    }
  }

  // --- Step 3: Walk between junctions to extract segments ---
  const visitedEdges = new Set();
  const segments = [];

  function edgeKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function parseKey(key) {
    const [gx, gz] = key.split(',').map(Number);
    return { gx, gz };
  }

  for (const startKey of junctions) {
    const startNode = nodes.get(startKey);

    for (const nextKey of startNode.neighbors) {
      const eKey = edgeKey(startKey, nextKey);
      if (visitedEdges.has(eKey)) continue;

      // Walk from startKey -> nextKey until we hit another junction
      const cellKeys = [startKey];
      let prevKey = startKey;
      let currKey = nextKey;

      while (true) {
        visitedEdges.add(edgeKey(prevKey, currKey));
        cellKeys.push(currKey);

        if (junctions.has(currKey)) break; // reached another junction

        // Continue walking (degree 2 non-junction, so exactly one other neighbor)
        const currNode = nodes.get(currKey);
        let nextWalk = null;
        for (const nKey of currNode.neighbors) {
          if (nKey !== prevKey) {
            nextWalk = nKey;
            break;
          }
        }

        if (!nextWalk) break;
        prevKey = currKey;
        currKey = nextWalk;
      }

      if (cellKeys.length >= 2) {
        segments.push({
          cells: cellKeys.map(parseKey),
        });
      }
    }
  }

  // Handle isolated cycles (no junctions at all) — rings where every node is degree 2
  // and no path endpoints. Pick an unvisited edge and walk around the cycle.
  for (const [key, node] of nodes) {
    for (const nKey of node.neighbors) {
      const eKey = edgeKey(key, nKey);
      if (visitedEdges.has(eKey)) continue;

      // Unvisited edge in a cycle — walk it
      const cellKeys = [key];
      let prevKey = key;
      let currKey = nKey;

      while (true) {
        visitedEdges.add(edgeKey(prevKey, currKey));
        cellKeys.push(currKey);

        if (currKey === key) break; // completed the cycle

        const currNode = nodes.get(currKey);
        let nextWalk = null;
        for (const nk of currNode.neighbors) {
          if (nk !== prevKey && !visitedEdges.has(edgeKey(currKey, nk))) {
            nextWalk = nk;
            break;
          }
        }
        if (!nextWalk) {
          // Try to close the cycle
          for (const nk of currNode.neighbors) {
            if (nk === key && nk !== prevKey) {
              nextWalk = nk;
              break;
            }
          }
        }
        if (!nextWalk) break;
        prevKey = currKey;
        currKey = nextWalk;
      }

      if (cellKeys.length >= 2) {
        segments.push({
          cells: cellKeys.map(parseKey),
        });
      }
    }
  }

  return segments;
}
