/**
 * Connect city nuclei using Union-Find + MST + shortcut roads + merged paths.
 *
 * After pathfinding all connections (with reuse discount so they share cells),
 * mergeRoadPaths splits at divergence points and deduplicates shared portions.
 *
 * Phases:
 *   1. Attach each nucleus to nearest road node
 *   2. Discover existing connectivity via BFS → Union-Find
 *   3. Identify clusters, select MST crossings + redundant links
 *   4. Pathfind MST connections with reuse discount
 *   5. Merge shared segments → add to graph
 *   6. Safety-net: connect remaining graph components
 *   7. Shortcut roads between nearby nuclei with high detour ratio
 */

import { distance2D } from '../core/math.js';
import { UnionFind } from '../core/UnionFind.js';
import { findPath, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { stampEdge, stampJunction } from './roadOccupancy.js';
import { nucleusConnectionCost, shortcutRoadCost } from './pathCost.js';
import { addMergedRoads } from './roadNetwork.js';

// ============================================================
// Importance / hierarchy helpers
// ============================================================

function computeImportance(a, b, pathLength, maxLength, isMSTEdge) {
  const tierWeight = t => t <= 1 ? 1.0 : t <= 2 ? 0.7 : t <= 3 ? 0.45 : t <= 4 ? 0.2 : 0.1;
  const pairWeight = (tierWeight(a.tier) + tierWeight(b.tier)) / 2;
  const lengthWeight = Math.min(1, pathLength / maxLength);
  const bridgeWeight = isMSTEdge ? 1.0 : 0.0;
  return Math.min(1, pairWeight * 0.4 + lengthWeight * 0.3 + bridgeWeight * 0.3);
}

function edgeWidth(importance) {
  return Math.round(6 + importance * 10);
}

function edgeHierarchy(importance) {
  if (importance > 0.7) return 'arterial';
  if (importance > 0.4) return 'collector';
  return 'local';
}

function estimateCrossingCost(ax, az, bx, bz, buildability, cs) {
  const dist = distance2D(ax, az, bx, bz);
  if (dist < 1) return 0;
  const steps = Math.max(2, Math.ceil(dist / cs));
  let unbuildable = 0, lowBuild = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gx = Math.round((ax + (bx - ax) * t) / cs);
    const gz = Math.round((az + (bz - az) * t) / cs);
    if (buildability) {
      const b = buildability.get(gx, gz);
      if (b < 0.01) unbuildable++;
      else if (b < 0.3) lowBuild++;
    }
  }
  const unbuildableFrac = unbuildable / (steps + 1);
  const lowFrac = lowBuild / (steps + 1);
  return dist * (1 + unbuildableFrac * 5 + lowFrac * 2);
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += distance2D(pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z);
  }
  return len;
}

// ============================================================
// Main entry point
// ============================================================

export function connectNuclei(cityLayers, graph, nuclei, occupancy) {
  if (nuclei.length === 0) return;

  const params = cityLayers.getData('params');
  const buildability = cityLayers.getGrid('buildability');
  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const maxLength = Math.sqrt(w * w + h * h) * cs * 0.5;
  const costFn = nucleusConnectionCost(cityLayers);

  // ============================================================
  // Phase 1: Attach each nucleus to nearest road node
  // ============================================================

  for (const nucleus of nuclei) {
    const nearest = graph.nearestNode(nucleus.x, nucleus.z);
    if (!nearest) continue;

    if (nearest.dist < cs * 3) {
      nucleus.roadNodeId = nearest.id;
      continue;
    }

    const startGx = Math.round(nucleus.x / cs);
    const startGz = Math.round(nucleus.z / cs);
    const nearNode = graph.getNode(nearest.id);
    const goalGx = Math.round(nearNode.x / cs);
    const goalGz = Math.round(nearNode.z / cs);

    const result = findPath(startGx, startGz, goalGx, goalGz, w, h, costFn);
    if (!result || result.path.length < 2) {
      nucleus.roadNodeId = nearest.id;
      continue;
    }

    const simplified = simplifyPath(result.path, 2.0);
    const smooth = smoothPath(simplified, cs);
    if (smooth.length < 2) {
      nucleus.roadNodeId = nearest.id;
      continue;
    }

    const nucNode = graph.addNode(nucleus.x, nucleus.z, { type: 'nucleus' });
    const importance = computeImportance(nucleus, nucleus, nearest.dist, maxLength, false);
    const edgeId = graph.addEdge(nucNode, nearest.id, {
      points: smooth.slice(1, -1),
      width: edgeWidth(importance),
      hierarchy: edgeHierarchy(importance),
      importance,
    });

    if (occupancy) {
      stampEdge(graph, edgeId, occupancy);
      stampJunction(nucleus.x, nucleus.z, 10, occupancy);
    }

    nucleus.roadNodeId = nucNode;
  }

  for (const n of nuclei) {
    if (n.roadNodeId == null) {
      const nearest = graph.nearestNode(n.x, n.z);
      n.roadNodeId = nearest ? nearest.id : null;
    }
  }

  // ============================================================
  // Phase 2: Discover existing connectivity via BFS → Union-Find
  // ============================================================

  const n = nuclei.length;
  const uf = new UnionFind(n);

  for (let i = 0; i < n; i++) {
    if (nuclei[i].roadNodeId == null) continue;

    const nodeToNucleus = new Map();
    for (let j = 0; j < n; j++) {
      if (j !== i && nuclei[j].roadNodeId != null) {
        nodeToNucleus.set(nuclei[j].roadNodeId, j);
      }
    }

    const maxHops = Math.ceil(Math.max(w, h) * 0.5);
    const visited = new Set([nuclei[i].roadNodeId]);
    let frontier = [nuclei[i].roadNodeId];

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const next = [];
      for (const nodeId of frontier) {
        if (nodeToNucleus.has(nodeId)) {
          uf.union(i, nodeToNucleus.get(nodeId));
          nodeToNucleus.delete(nodeId);
        }
        for (const neighbor of graph.neighbors(nodeId)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
      if (nodeToNucleus.size === 0) break;
    }
  }

  // ============================================================
  // Phase 3a: Identify clusters + collect MST connection pairs
  // ============================================================

  const allConnections = [];

  if (uf.componentCount() > 1) {
    const clusters = [];
    const components = uf.components();
    for (const [root, members] of components) {
      let importance = 0;
      let cx = 0, cz = 0;
      for (const idx of members) {
        const nuc = nuclei[idx];
        const tw = nuc.tier <= 1 ? 10 : nuc.tier <= 2 ? 5 : nuc.tier <= 3 ? 3 : 1;
        importance += tw;
        cx += nuc.x;
        cz += nuc.z;
      }
      cx /= members.length;
      cz /= members.length;
      clusters.push({ root, members, importance, cx, cz });
    }

    // Build MST crossing candidates
    const crossings = [];
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let bestCost = Infinity;
        let bestA = null, bestB = null;
        for (const ai of clusters[i].members) {
          for (const bi of clusters[j].members) {
            const a = nuclei[ai];
            const b = nuclei[bi];
            const cost = estimateCrossingCost(a.x, a.z, b.x, b.z, buildability, cs);
            if (cost < bestCost) {
              bestCost = cost;
              bestA = ai;
              bestB = bi;
            }
          }
        }
        if (bestA != null && bestB != null) {
          crossings.push({ clusterI: i, clusterJ: j, nucleusA: bestA, nucleusB: bestB, cost: bestCost });
        }
      }
    }

    crossings.sort((a, b) => a.cost - b.cost);

    // Kruskal's: select MST edges
    const clusterUF = new UnionFind(clusters.length);

    for (const crossing of crossings) {
      if (clusterUF.componentCount() <= 1) break;
      const { clusterI, clusterJ, nucleusA, nucleusB } = crossing;
      if (clusterUF.connected(clusterI, clusterJ)) continue;

      allConnections.push({
        nucA: nuclei[nucleusA], nucB: nuclei[nucleusB],
        isMST: true, nucleusIdxA: nucleusA, nucleusIdxB: nucleusB,
        clusterI, clusterJ,
      });
      clusterUF.union(clusterI, clusterJ);
      uf.union(nucleusA, nucleusB);
    }

    // Redundant links for important clusters
    for (const crossing of crossings) {
      const { clusterI, clusterJ, nucleusA, nucleusB } = crossing;
      const cI = clusters[clusterI];
      const cJ = clusters[clusterJ];
      if (cI.importance < 3 && cJ.importance < 3) continue;
      if (uf.connected(nucleusA, nucleusB)) continue;

      allConnections.push({
        nucA: nuclei[nucleusA], nucB: nuclei[nucleusB],
        isMST: false, nucleusIdxA: nucleusA, nucleusIdxB: nucleusB,
        clusterI, clusterJ,
      });
      uf.union(nucleusA, nucleusB);
    }
  }

  if (allConnections.length > 0) {
    // ============================================================
    // Phase 4: Pathfind MST connections with reuse discount
    // ============================================================

    const usedCells = new Set();
    const rawPaths = [];

    for (const conn of allConnections) {
      const nodeA = conn.nucA.roadNodeId;
      const nodeB = conn.nucB.roadNodeId;
      if (nodeA == null || nodeB == null) continue;

      const nA = graph.getNode(nodeA);
      const nB = graph.getNode(nodeB);
      if (!nA || !nB) continue;

      // Cost function with fixed low cost for cells used by previous connections
      const sharedCost = (fromGx, fromGz, toGx, toGz) => {
        if (usedCells.has(`${toGx},${toGz}`)) {
          const dx = toGx - fromGx, dz = toGz - fromGz;
          return Math.sqrt(dx * dx + dz * dz) * 0.3;
        }
        return costFn(fromGx, fromGz, toGx, toGz);
      };

      const result = findPath(
        Math.round(nA.x / cs), Math.round(nA.z / cs),
        Math.round(nB.x / cs), Math.round(nB.z / cs),
        w, h, sharedCost,
      );
      if (!result || result.path.length < 2) continue;

      const pathLen = result.path.length * cs;
      const importance = computeImportance(conn.nucA, conn.nucB, pathLen, maxLength, conn.isMST);

      for (const cell of result.path) usedCells.add(`${cell.gx},${cell.gz}`);
      rawPaths.push({ cells: result.path, rank: 1, importance });
    }

    // ============================================================
    // Phase 5: Merge shared segments → add to graph
    // ============================================================

    const mergeInput = rawPaths.map(p => ({ cells: p.cells, importance: p.importance }));
    addMergedRoads(graph, mergeInput, cs, occupancy);
  }

  // ============================================================
  // Phase 6: Safety-net — connect remaining graph components
  // ============================================================

  connectGraphComponents(graph, costFn, w, h, cs, occupancy);

  // ============================================================
  // Phase 7: Shortcut roads between nearby nuclei with high detour
  // ============================================================

  const scCostFn = shortcutRoadCost(cityLayers);
  addShortcutRoads(cityLayers, graph, nuclei, scCostFn, w, h, cs, maxLength, occupancy);

  // ============================================================
  // Phase 8: Post-shortcut safety net (merge pipeline may fragment)
  // ============================================================

  connectGraphComponents(graph, costFn, w, h, cs, occupancy);
}

/**
 * Final safety net: connect any remaining disconnected graph components.
 * Uses direct edge addition (not addMergedRoads) to avoid creating fragments.
 */
function connectGraphComponents(graph, costFn, w, h, cs, occupancy) {
  // Remove orphaned nodes (degree 0) left by merge deduplication
  for (const [id] of graph.nodes) {
    if (graph.degree(id) === 0) graph.removeNode(id);
  }

  if (graph.nodes.size === 0) return;

  const visited = new Set();
  const components = [];

  for (const [id] of graph.nodes) {
    if (visited.has(id)) continue;
    const component = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const cur = queue.shift();
      component.push(cur);
      for (const neighbor of graph.neighbors(cur)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  if (components.length <= 1) return;

  components.sort((a, b) => b.length - a.length);
  const mainSet = new Set(components[0]);

  for (let i = 1; i < components.length; i++) {
    let bestMainId = null, bestOtherId = null, bestDist = Infinity;
    for (const otherId of components[i]) {
      const other = graph.getNode(otherId);
      for (const mainId of mainSet) {
        const main = graph.getNode(mainId);
        const d = distance2D(other.x, other.z, main.x, main.z);
        if (d < bestDist) { bestDist = d; bestMainId = mainId; bestOtherId = otherId; }
      }
    }

    if (bestMainId != null && bestOtherId != null) {
      const other = graph.getNode(bestOtherId);
      const main = graph.getNode(bestMainId);
      const result = findPath(
        Math.round(other.x / cs), Math.round(other.z / cs),
        Math.round(main.x / cs), Math.round(main.z / cs),
        w, h, costFn,
      );
      if (result && result.path.length >= 2) {
        const simplified = simplifyPath(result.path, 2.0);
        const smooth = smoothPath(simplified, cs);
        if (smooth.length >= 2) {
          const edgeId = graph.addEdge(bestOtherId, bestMainId, {
            points: smooth.slice(1, -1),
            width: 9, hierarchy: 'local', importance: 0.3,
          });
          if (occupancy) stampEdge(graph, edgeId, occupancy);
        } else {
          graph.addEdge(bestOtherId, bestMainId, {
            width: 9, hierarchy: 'local', importance: 0.2,
          });
        }
      } else {
        graph.addEdge(bestOtherId, bestMainId, {
          width: 9, hierarchy: 'local', importance: 0.2,
        });
      }
      for (const id of components[i]) mainSet.add(id);
    }
  }
}

/**
 * For each nucleus, find its Kth closest neighbor (skipping excludePairs)
 * and propose a shortcut if the road-network route has high detour.
 * Reject shortcuts that cross existing edges.
 */
/**
 * For each nucleus, find its closest neighbor (skipping excludePairs)
 * and propose a shortcut if the road-network route has high detour.
 * All attempted pairs are added to excludePairs so future passes skip them.
 */
function findShortcutCandidates(graph, nuclei, cs, excludePairs) {
  const n = nuclei.length;
  const minShortcutDist = cs * 5;
  const candidates = [];

  for (let i = 0; i < n; i++) {
    if (nuclei[i].roadNodeId == null) continue;

    // Find closest neighbor not in excludePairs
    let closestJ = -1;
    let closestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || nuclei[j].roadNodeId == null) continue;
      const key = `${Math.min(i, j)},${Math.max(i, j)}`;
      if (excludePairs.has(key)) continue;
      const d = distance2D(nuclei[i].x, nuclei[i].z, nuclei[j].x, nuclei[j].z);
      if (d < closestDist) { closestDist = d; closestJ = j; }
    }

    if (closestJ < 0 || closestDist < minShortcutDist) continue;

    const a = Math.min(i, closestJ);
    const b = Math.max(i, closestJ);
    candidates.push({ i: a, j: b, straightDist: closestDist });
  }

  // Deduplicate and mark all as attempted
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = `${c.i},${c.j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    excludePairs.add(key);
    unique.push(c);
  }

  // Filter: detour ratio > 2.0
  const accepted = [];
  for (const cand of unique) {
    const graphDist = graph.shortestPathLength(nuclei[cand.i].roadNodeId, nuclei[cand.j].roadNodeId);
    if (!isFinite(graphDist)) continue;
    const detourRatio = graphDist / cand.straightDist;
    if (detourRatio < 2.0) continue;

    accepted.push({ ...cand, detourRatio });
  }

  return accepted;
}

/**
 * Pathfind a shortcut and return its raw path + importance for merging.
 * Returns null if pathfinding fails.
 */
function pathfindShortcut(graph, nucA, nucB, costFn, w, h, cs, maxLength) {
  const nA = graph.getNode(nucA.roadNodeId);
  const nB = graph.getNode(nucB.roadNodeId);
  if (!nA || !nB) return null;

  const result = findPath(
    Math.round(nA.x / cs), Math.round(nA.z / cs),
    Math.round(nB.x / cs), Math.round(nB.z / cs),
    w, h, costFn,
  );
  if (!result || result.path.length < 2) return null;

  const pathLen = result.path.length * cs;
  const importance = computeImportance(nucA, nucB, pathLen, maxLength, false);

  return { cells: result.path, importance };
}

/**
 * Multi-pass shortcut addition:
 *  Pass 1: each nucleus → closest neighbor with high detour
 *  Pass 2-3: next-closest neighbors, skipping already-attempted pairs
 * All paths are collected and fed through addMergedRoads in one batch.
 */
function addShortcutRoads(cityLayers, graph, nuclei, costFn, w, h, cs, maxLength, occupancy) {
  const n = nuclei.length;
  if (n < 2) return;

  const attemptedPairs = new Set();
  const allAccepted = [];
  const allPaths = [];

  for (let pass = 1; pass <= 3; pass++) {
    const found = findShortcutCandidates(graph, nuclei, cs, attemptedPairs);
    if (found.length === 0) break;

    for (const cand of found) {
      const pathData = pathfindShortcut(graph, nuclei[cand.i], nuclei[cand.j], costFn, w, h, cs, maxLength);
      if (pathData) {
        allAccepted.push(cand);
        allPaths.push(pathData);
      }
    }
  }

  // Store for debug rendering
  cityLayers.setData('shortcutCandidates', allAccepted.map(c => ({
    ax: nuclei[c.i].x, az: nuclei[c.i].z,
    bx: nuclei[c.j].x, bz: nuclei[c.j].z,
    detourRatio: c.detourRatio,
  })));

  // Feed all shortcut paths through merge pipeline
  if (allPaths.length > 0) {
    addMergedRoads(graph, allPaths, cs, occupancy);
  }
}
