/**
 * Connect city nuclei using Union-Find + MST + shared-grid merging.
 *
 * Uses the shared-grid road merging pattern (from generateAnchorRoutes):
 * all nucleus connections are pathfound onto a shared usage grid with strong
 * reuse discount, so they merge onto existing roads and each other. Junctions
 * and segments are extracted from the merged grid, producing proper graph
 * topology instead of overlapping independent edges.
 *
 * Phases:
 *   1. Attach each nucleus to nearest road node
 *   2. Discover existing connectivity via BFS → Union-Find
 *   3. Identify clusters, select MST crossings + redundant links
 *   4. Pathfind all connections onto shared usage grid
 *   5. Extract junctions + segments → add merged edges to graph
 *   6. Safety-net: connect remaining graph components
 */

import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';
import { UnionFind } from '../core/UnionFind.js';
import { findPath, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { stampEdge, stampJunction } from './roadOccupancy.js';
import { nucleusConnectionCost } from './pathCost.js';

const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];

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
  // Phase 3: Identify clusters + collect connection pairs
  // ============================================================

  if (uf.componentCount() <= 1) return;

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
  const allConnections = []; // { nucA, nucB, isMST, nucleusIdxA, nucleusIdxB, clusterI, clusterJ }

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

  if (allConnections.length === 0) return;

  // ============================================================
  // Phase 4: Pathfind all connections onto shared usage grid
  // ============================================================

  const usageGrid = new Grid2D(w, h, { type: 'uint8' });
  const importanceGrid = new Grid2D(w, h, { type: 'float32' });

  // Cost function wrapping nucleusConnectionCost with shared-grid reuse discount
  const sharedCost = (fromGx, fromGz, toGx, toGz) => {
    let c = costFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(c)) return c;
    // Strong discount on cells already used by previous connections
    if (toGx >= 0 && toGx < w && toGz >= 0 && toGz < h && usageGrid.get(toGx, toGz) > 0) {
      c *= 0.15;
    }
    return c;
  };

  for (const conn of allConnections) {
    const nodeA = conn.nucA.roadNodeId;
    const nodeB = conn.nucB.roadNodeId;
    if (nodeA == null || nodeB == null) continue;

    const nA = graph.getNode(nodeA);
    const nB = graph.getNode(nodeB);
    if (!nA || !nB) continue;

    const result = findPath(
      Math.round(nA.x / cs), Math.round(nA.z / cs),
      Math.round(nB.x / cs), Math.round(nB.z / cs),
      w, h, sharedCost,
    );
    if (!result || result.path.length < 2) continue;

    const pathLen = result.path.length * cs;
    const importance = computeImportance(conn.nucA, conn.nucB, pathLen, maxLength, conn.isMST);

    // Stamp cells onto shared grid
    for (const cell of result.path) {
      const prev = usageGrid.get(cell.gx, cell.gz);
      if (prev < 255) usageGrid.set(cell.gx, cell.gz, prev + 1);
      const prevImp = importanceGrid.get(cell.gx, cell.gz);
      if (importance > prevImp) importanceGrid.set(cell.gx, cell.gz, importance);
    }

    conn.success = true;
  }

  // ============================================================
  // Phase 5: Extract junctions + segments → add to graph
  // ============================================================

  // 5a. Detect junctions
  const junctionSet = new Set();

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (usageGrid.get(gx, gz) === 0) continue;

      let roadNeighbors = 0;
      for (const [dx, dz] of DIRS8) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && usageGrid.get(nx, nz) > 0) {
          roadNeighbors++;
        }
      }

      if (roadNeighbors !== 2 || usageGrid.get(gx, gz) > 1) {
        if (usageGrid.get(gx, gz) > 1) {
          // Only mark as junction if usage count changes or topology branches
          let usageChanges = false;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = gx + dx, nz = gz + dz;
            if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
              if (usageGrid.get(nx, nz) > 0 && usageGrid.get(nx, nz) !== usageGrid.get(gx, gz)) {
                usageChanges = true;
                break;
              }
            }
          }
          if (usageChanges || roadNeighbors !== 2) {
            junctionSet.add(`${gx},${gz}`);
          }
        } else {
          junctionSet.add(`${gx},${gz}`);
        }
      }
    }
  }

  // 5b. Trace segments between junctions
  const segments = [];
  const segKeys = new Set();

  for (const jKey of junctionSet) {
    const [jgx, jgz] = jKey.split(',').map(Number);

    for (const [dx, dz] of DIRS8) {
      const nx = jgx + dx, nz = jgz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      if (usageGrid.get(nx, nz) === 0) continue;

      // Trace along road cells until we hit another junction or dead end
      const segment = [{ gx: jgx, gz: jgz }];
      let cx = nx, cz = nz;
      let px = jgx, pz = jgz;

      while (true) {
        segment.push({ gx: cx, gz: cz });
        if (junctionSet.has(`${cx},${cz}`)) break;

        let found = false;
        for (const [ddx, ddz] of DIRS8) {
          const nnx = cx + ddx, nnz = cz + ddz;
          if (nnx === px && nnz === pz) continue;
          if (nnx < 0 || nnx >= w || nnz < 0 || nnz >= h) continue;
          if (usageGrid.get(nnx, nnz) === 0) continue;
          px = cx; pz = cz;
          cx = nnx; cz = nnz;
          found = true;
          break;
        }
        if (!found) break;
      }

      if (segment.length < 2) continue;

      // Deduplicate (same start/end pair, either direction)
      const startKey = `${segment[0].gx},${segment[0].gz}`;
      const endKey = `${segment[segment.length - 1].gx},${segment[segment.length - 1].gz}`;
      const segKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
      if (segKeys.has(segKey)) continue;
      segKeys.add(segKey);

      // Determine importance from the cells in this segment
      let maxImp = 0;
      for (const cell of segment) {
        const imp = importanceGrid.get(cell.gx, cell.gz);
        if (imp > maxImp) maxImp = imp;
      }

      segments.push({ cells: segment, importance: maxImp });
    }
  }

  // 5c. Convert segments to graph edges
  const nodeMap = new Map(); // "gx,gz" -> nodeId (for new segment nodes)

  function getOrCreateNode(gx, gz) {
    const key = `${gx},${gz}`;
    if (nodeMap.has(key)) return nodeMap.get(key);

    // Snap to nearest existing graph node within tolerance
    const wx = gx * cs, wz = gz * cs;
    const nearest = graph.nearestNode(wx, wz);
    if (nearest && nearest.dist < cs * 2) {
      nodeMap.set(key, nearest.id);
      return nearest.id;
    }

    const id = graph.addNode(wx, wz, { type: 'nucleus-connection' });
    nodeMap.set(key, id);
    return id;
  }

  for (const seg of segments) {
    if (seg.cells.length < 2) continue;

    const startCell = seg.cells[0];
    const endCell = seg.cells[seg.cells.length - 1];

    const startNode = getOrCreateNode(startCell.gx, startCell.gz);
    const endNode = getOrCreateNode(endCell.gx, endCell.gz);
    if (startNode === endNode) continue;

    // Check if edge already exists between these nodes
    if (graph.neighbors(startNode).includes(endNode)) continue;

    const simplified = simplifyPath(seg.cells, 2.0);
    const smooth = smoothPath(simplified, cs, 1);
    if (smooth.length < 2) continue;

    const imp = seg.importance;
    const edgeId = graph.addEdge(startNode, endNode, {
      points: smooth.slice(1, -1),
      width: edgeWidth(imp),
      hierarchy: edgeHierarchy(imp),
      importance: imp,
    });

    if (occupancy) {
      stampEdge(graph, edgeId, occupancy);
      // Stamp junctions at segment endpoints
      const sn = graph.getNode(startNode);
      const en = graph.getNode(endNode);
      if (graph.degree(startNode) >= 3) stampJunction(sn.x, sn.z, 10, occupancy);
      if (graph.degree(endNode) >= 3) stampJunction(en.x, en.z, 10, occupancy);
    }
  }

  // ============================================================
  // Phase 6: Safety-net — connect remaining graph components
  // ============================================================

  connectGraphComponents(graph, costFn, w, h, cs, occupancy);
}

/**
 * Final safety net: connect any remaining disconnected graph components.
 */
function connectGraphComponents(graph, costFn, w, h, cs, occupancy) {
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
      if (result) {
        const simplified = simplifyPath(result.path, 1.0);
        const smooth = smoothPath(simplified, cs);
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
      for (const id of components[i]) mainSet.add(id);
    }
  }
}
