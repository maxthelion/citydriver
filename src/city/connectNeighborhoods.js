/**
 * C5. Connect neighborhoods.
 * A* pathfinding between neighborhood nuclei to form direct cross-connections.
 * Paths prefer straight lines, only detouring for water and steep terrain.
 */

import { distance2D } from '../core/math.js';
import { UnionFind } from '../core/UnionFind.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {Array} neighborhoods - from placeNeighborhoods()
 * @param {import('../core/rng.js').SeededRandom} rng
 */
export function connectNeighborhoods(cityLayers, graph, neighborhoods, rng) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  const bridgeGrid = cityLayers.getGrid('bridgeGrid');

  if (!params || !elevation || neighborhoods.length < 2) return;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;

  // Terrain cost: low slope penalty so paths stay direct, only avoid water/cliffs
  // Bridge grid allows crossing rivers at identified bridge points
  const costFn = terrainCostFunction(elevation, {
    slopePenalty: 3,
    waterGrid: waterMask,
    waterPenalty: 100,
    bridgeGrid: bridgeGrid || null,
    seaLevel,
    edgeMargin: 0,
  });

  // Build connections
  const connections = buildNeighborhoodConnections(neighborhoods);

  // Sort: higher importance connections first, then shorter
  connections.sort((a, b) => {
    const impDiff = b.importance - a.importance;
    if (Math.abs(impDiff) > 0.1) return impDiff;
    return a.dist - b.dist;
  });

  // Pathfind each connection
  for (const conn of connections) {
    const result = findPath(
      conn.from.gx, conn.from.gz,
      conn.to.gx, conn.to.gz,
      w, h, costFn,
    );

    if (!result) continue;

    // Simplify and smooth
    const simplified = simplifyPath(result.path, 1.5);
    const smooth = smoothPath(simplified, cs);
    if (smooth.length < 2) continue;

    // Add to graph
    const startNode = findOrCreateNode(graph, smooth[0].x, smooth[0].z, cs * 3);
    const endNode = findOrCreateNode(graph, smooth[smooth.length - 1].x, smooth[smooth.length - 1].z, cs * 3);
    if (startNode === endNode) continue;

    graph.addEdge(startNode, endNode, {
      points: smooth.slice(1, -1),
      width: conn.hierarchy === 'arterial' ? 16 : 12,
      hierarchy: conn.hierarchy,
    });
  }
}

/**
 * Build connections between neighborhoods using K-nearest + Union-Find.
 */
function buildNeighborhoodConnections(neighborhoods) {
  const n = neighborhoods.length;
  const uf = new UnionFind(n);
  const connections = [];
  const pairSet = new Set();

  function addConn(i, j) {
    const key = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (pairSet.has(key)) return;
    pairSet.add(key);

    const a = neighborhoods[i];
    const b = neighborhoods[j];
    const dist = distance2D(a.gx, a.gz, b.gx, b.gz);
    const minImp = Math.min(a.importance, b.importance);
    const maxImp = Math.max(a.importance, b.importance);

    let hierarchy;
    if (maxImp > 0.7 || a.type === 'oldTown' || b.type === 'oldTown') {
      hierarchy = 'arterial';
    } else if (maxImp > 0.4) {
      hierarchy = 'collector';
    } else {
      hierarchy = 'collector';
    }

    connections.push({
      from: a, to: b, dist, hierarchy,
      importance: maxImp + minImp * 0.5,
    });
    uf.union(i, j);
  }

  // Old town (index 0) connects to nearest K neighbors (not all — distant
  // connections create unnaturally long straight roads)
  const oldTownK = Math.min(n - 1, Math.max(3, Math.ceil(n * 0.5)));
  const sortedFromCenter = [];
  for (let j = 1; j < n; j++) {
    sortedFromCenter.push({
      j,
      dist: distance2D(neighborhoods[0].gx, neighborhoods[0].gz, neighborhoods[j].gx, neighborhoods[j].gz),
    });
  }
  sortedFromCenter.sort((a, b) => a.dist - b.dist);
  for (let k = 0; k < Math.min(oldTownK, sortedFromCenter.length); k++) {
    addConn(0, sortedFromCenter[k].j);
  }

  // Each nucleus connects to K=2 nearest
  for (let i = 1; i < n; i++) {
    const sorted = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      sorted.push({ j, dist: distance2D(neighborhoods[i].gx, neighborhoods[i].gz, neighborhoods[j].gx, neighborhoods[j].gz) });
    }
    sorted.sort((a, b) => a.dist - b.dist);
    for (let k = 0; k < Math.min(2, sorted.length); k++) {
      addConn(i, sorted[k].j);
    }
  }

  // Ensure full connectivity
  for (let i = 1; i < n; i++) {
    if (!uf.connected(0, i)) {
      // Find nearest connected nucleus
      let bestJ = -1, bestDist = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (!uf.connected(0, j)) continue;
        const d = distance2D(neighborhoods[i].gx, neighborhoods[i].gz, neighborhoods[j].gx, neighborhoods[j].gz);
        if (d < bestDist) { bestDist = d; bestJ = j; }
      }
      if (bestJ >= 0) addConn(i, bestJ);
    }
  }

  return connections;
}

function findOrCreateNode(graph, x, z, threshold) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < threshold) {
    return nearest.id;
  }
  return graph.addNode(x, z, { type: 'neighborhood' });
}

