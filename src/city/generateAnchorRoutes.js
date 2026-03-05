/**
 * C3. Anchor routes — inherit regional roads as a merged network.
 *
 * Instead of adding each regional road as an independent edge, we:
 *   1. Pathfind all roads onto a shared grid (with road-reuse discount)
 *   2. Build a cell-level usage map (which cells are used by any road)
 *   3. Extract the network as connected segments with junctions where
 *      roads meet, merge, or split
 *   4. Convert segments to graph edges
 *
 * This guarantees no overlapping roads by construction.
 */

import { PlanarGraph } from '../core/PlanarGraph.js';
import { Grid2D } from '../core/Grid2D.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { stampEdge, stampJunction, wrapCostWithOccupancy } from './roadOccupancy.js';

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {PlanarGraph}
 */
export function generateAnchorRoutes(cityLayers, rng) {
  const graph = new PlanarGraph();
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!elevation || !params) return graph;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel;

  const baseCost = terrainCostFunction(elevation, { waterGrid: waterMask, seaLevel });
  const regionalRoads = cityLayers.getData('regionalRoads') || [];

  // --- Phase 1: Pathfind all roads onto a shared grid ---

  // Usage grid: how many roads use each cell (0 = no road)
  const usageGrid = new Grid2D(w, h, { type: 'uint8' });
  // Hierarchy grid: highest hierarchy touching each cell (0=none, 1=arterial, 2=collector, 3=structural)
  const hierarchyGrid = new Grid2D(w, h, { type: 'uint8' });

  const HIER_RANK = { arterial: 1, collector: 2, structural: 3 };

  // Cost function that strongly rewards reusing existing road cells
  const sharedCost = (fromGx, fromGz, toGx, toGz) => {
    const dx = toGx - fromGx;
    const dz = toGz - fromGz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const fromH = elevation.get(fromGx, fromGz);
    const toH = elevation.get(toGx, toGz);
    const slope = Math.abs(toH - fromH) / dist;
    let c = dist + slope * 10;

    if (waterMask && waterMask.get(toGx, toGz) > 0) c += 50;
    if (seaLevel !== null && elevation.get(toGx, toGz) < seaLevel) c += 50;

    // Strong discount for reusing existing road cells
    if (usageGrid.get(toGx, toGz) > 0) c *= 0.15;

    return c;
  };

  // Pathfind each regional road and stamp onto usage grid
  const allPaths = []; // array of { cells: [{gx,gz}], hierarchy }

  // Sort: arterials first (they define the primary network others merge into)
  const sortedRoads = regionalRoads
    .filter(r => r.hierarchy !== 'local')
    .sort((a, b) => (HIER_RANK[a.hierarchy] || 9) - (HIER_RANK[b.hierarchy] || 9));

  for (const road of sortedRoads) {
    const path = pathfindRegionalRoad(road, params, elevation, waterMask, sharedCost);
    if (!path || path.length < 2) continue;

    const hierarchy = road.hierarchy || 'arterial';
    const rank = HIER_RANK[hierarchy] || 9;

    // Stamp onto usage grid
    for (const cell of path) {
      const prev = usageGrid.get(cell.gx, cell.gz);
      usageGrid.set(cell.gx, cell.gz, prev + 1);
      const prevH = hierarchyGrid.get(cell.gx, cell.gz);
      if (prevH === 0 || rank < prevH) {
        hierarchyGrid.set(cell.gx, cell.gz, rank);
      }
    }

    allPaths.push({ cells: path, hierarchy });
  }

  // --- Phase 2: Extract network from usage grid ---

  // Find junction cells: cells with road usage that have != 2 road neighbours
  // (endpoints have 1 neighbour, junctions have 3+)
  const junctionSet = new Set(); // "gx,gz" strings

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (usageGrid.get(gx, gz) === 0) continue;

      let roadNeighbors = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && usageGrid.get(nx, nz) > 0) {
          roadNeighbors++;
        }
      }

      // Junction if: endpoint (<=1 neighbor), branch point (>=3 neighbors),
      // or multiple roads converge (usage > 1 and neighbors suggest branching)
      if (roadNeighbors !== 2 || usageGrid.get(gx, gz) > 1) {
        // For high-usage cells, only mark as junction if neighbors change usage count
        // (i.e., this is where roads actually merge/split)
        if (usageGrid.get(gx, gz) > 1) {
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

  // --- Phase 3: Trace segments between junctions ---

  const visited = new Grid2D(w, h, { type: 'uint8' });
  const segments = []; // array of { cells: [{gx,gz}], hierarchy }

  for (const jKey of junctionSet) {
    const [jgx, jgz] = jKey.split(',').map(Number);

    // Walk in each direction from this junction
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const nx = jgx + dx, nz = jgz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      if (usageGrid.get(nx, nz) === 0) continue;

      // Check if we already traced this direction
      const edgeKey = `${jgx},${jgz}->${nx},${nz}`;
      if (visited.get(nx, nz) && !junctionSet.has(`${nx},${nz}`)) continue;

      // Trace along road cells until we hit another junction or dead end
      const segment = [{ gx: jgx, gz: jgz }];
      let cx = nx, cz = nz;
      let px = jgx, pz = jgz;

      while (true) {
        segment.push({ gx: cx, gz: cz });

        if (junctionSet.has(`${cx},${cz}`)) break; // reached another junction

        // Find next unvisited road neighbor (not the one we came from)
        let found = false;
        for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
          const nnx = cx + ddx, nnz = cz + ddz;
          if (nnx === px && nnz === pz) continue; // don't go back
          if (nnx < 0 || nnx >= w || nnz < 0 || nnz >= h) continue;
          if (usageGrid.get(nnx, nnz) === 0) continue;

          px = cx;
          pz = cz;
          cx = nnx;
          cz = nnz;
          found = true;
          break;
        }

        if (!found) break; // dead end
      }

      if (segment.length < 2) continue;

      // Check this segment isn't a duplicate (reverse of already traced)
      const startKey = `${segment[0].gx},${segment[0].gz}`;
      const endKey = `${segment[segment.length - 1].gx},${segment[segment.length - 1].gz}`;
      const segKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;

      if (!segments.some(s => {
        const sk = `${s.cells[0].gx},${s.cells[0].gz}`;
        const ek = `${s.cells[s.cells.length - 1].gx},${s.cells[s.cells.length - 1].gz}`;
        const k = sk < ek ? `${sk}|${ek}` : `${ek}|${sk}`;
        return k === segKey;
      })) {
        // Determine hierarchy from the cells in this segment
        let bestHier = 9;
        for (const cell of segment) {
          const h = hierarchyGrid.get(cell.gx, cell.gz);
          if (h > 0 && h < bestHier) bestHier = h;
        }
        const hierarchy = bestHier === 1 ? 'arterial' : bestHier === 2 ? 'collector' : 'structural';

        segments.push({ cells: segment, hierarchy });
      }
    }
  }

  // --- Phase 4: Convert segments to graph edges ---

  const nodeMap = new Map(); // "gx,gz" -> nodeId

  function getNode(gx, gz) {
    const key = `${gx},${gz}`;
    if (nodeMap.has(key)) return nodeMap.get(key);
    const id = graph.addNode(gx * cs, gz * cs, { type: 'inherited' });
    nodeMap.set(key, id);
    return id;
  }

  for (const seg of segments) {
    if (seg.cells.length < 2) continue;

    const startCell = seg.cells[0];
    const endCell = seg.cells[seg.cells.length - 1];

    const startNode = getNode(startCell.gx, startCell.gz);
    const endNode = getNode(endCell.gx, endCell.gz);
    if (startNode === endNode) continue;
    if (graph.neighbors(startNode).includes(endNode)) continue;

    // Simplify and smooth the segment
    const simplified = simplifyPath(seg.cells, 3.0);
    const smooth = smoothPath(simplified, cs, 1);
    if (smooth.length < 2) continue;

    const roadWidth = seg.hierarchy === 'arterial' ? 16 : seg.hierarchy === 'collector' ? 12 : 14;

    graph.addEdge(startNode, endNode, {
      points: smooth.slice(1, -1),
      width: roadWidth,
      hierarchy: seg.hierarchy,
    });
  }

  // --- Phase 5: Waterfront road + seed connection ---
  // Stamp Phase 1-4 edges onto occupancy so Phase 5 pathfinding can reuse them
  const occupancy = cityLayers.getData('occupancy');
  const phase5Cost = occupancy ? wrapCostWithOccupancy(baseCost, occupancy, cs) : baseCost;

  // Stamp existing edges before Phase 5 pathfinding
  if (occupancy) {
    for (const edgeId of graph.edges.keys()) {
      stampEdge(graph, edgeId, occupancy);
    }
    for (const [nodeId, node] of graph.nodes) {
      if (graph.neighbors(nodeId).length >= 3) {
        stampJunction(node.x, node.z, 15, occupancy);
      }
    }
  }

  const seedX = Math.floor(w / 2) * cs;
  const seedZ = Math.floor(h / 2) * cs;
  connectSeed(graph, seedX, seedZ, phase5Cost, params, cityLayers);
  addWaterfrontRoad(graph, cityLayers, phase5Cost);

  if (graph.edges.size === 0) {
    addFallbackRoads(graph, seedX, seedZ, baseCost, params, rng);
  }

  return graph;
}

// --- Helpers ---

/**
 * Pathfind a regional road through the city grid, returning grid-cell path.
 */
function pathfindRegionalRoad(road, params, elevation, waterMask, costFn) {
  const { width: w, height: h, cellSize: cs, regionalCellSize, regionalMinGx, regionalMinGz, seaLevel } = params;
  const rcs = regionalCellSize || 50;
  const maxX = (w - 1) * cs;
  const maxZ = (h - 1) * cs;

  if (!road.path || road.path.length < 2) return null;

  const sourcePath = road.rawPath || road.path;

  // Convert to city-local world coords and clip
  const worldPts = sourcePath.map(p => ({
    x: (p.gx - regionalMinGx) * rcs,
    z: (p.gz - regionalMinGz) * rcs,
  }));

  const clipped = clipPathToBounds(worldPts, maxX, maxZ);
  if (clipped.length < 2) return null;

  const startGx = clamp(Math.round(clipped[0].x / cs), 0, w - 1);
  const startGz = clamp(Math.round(clipped[0].z / cs), 0, h - 1);
  const endGx = clamp(Math.round(clipped[clipped.length - 1].x / cs), 0, w - 1);
  const endGz = clamp(Math.round(clipped[clipped.length - 1].z / cs), 0, h - 1);

  if (startGx === endGx && startGz === endGz) return null;

  const result = findPath(startGx, startGz, endGx, endGz, w, h, costFn);
  return result ? result.path : null;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Clip a world-coord path to [0, maxX] x [0, maxZ].
 */
function clipPathToBounds(worldPts, maxX, maxZ) {
  const result = [];
  const isInside = p => p.x >= 0 && p.x <= maxX && p.z >= 0 && p.z <= maxZ;

  for (let i = 0; i < worldPts.length; i++) {
    const cur = worldPts[i];
    const curIn = isInside(cur);

    if (i > 0) {
      const prev = worldPts[i - 1];
      const prevIn = isInside(prev);

      if (!prevIn && curIn) {
        const entry = interpolateBoundaryCrossing(prev, cur, maxX, maxZ);
        if (entry) result.push(entry);
      }
      if (prevIn && !curIn) {
        const exit = interpolateBoundaryCrossing(cur, prev, maxX, maxZ);
        if (exit) result.push(exit);
        break;
      }
    }

    if (curIn) result.push(cur);
  }

  return result;
}

function interpolateBoundaryCrossing(outside, inside, maxX, maxZ) {
  const dx = inside.x - outside.x;
  const dz = inside.z - outside.z;
  let tMin = 0, tMax = 1;

  for (const { p, q } of [
    { p: -dx, q: outside.x },
    { p: dx, q: maxX - outside.x },
    { p: -dz, q: outside.z },
    { p: dz, q: maxZ - outside.z },
  ]) {
    if (Math.abs(p) < 1e-10) continue;
    const t = q / p;
    if (p < 0) { if (t > tMin) tMin = t; }
    else { if (t < tMax) tMax = t; }
  }

  if (tMin > tMax) return null;
  return {
    x: clamp(outside.x + tMin * dx, 0, maxX),
    z: clamp(outside.z + tMin * dz, 0, maxZ),
  };
}

function connectSeed(graph, seedX, seedZ, baseCost, params, cityLayers) {
  const { width, height, cellSize: cs } = params;

  if (graph.nodes.size === 0) {
    graph.addNode(seedX, seedZ, { type: 'seed' });
    return;
  }

  const nearest = graph.nearestNode(seedX, seedZ);
  if (!nearest) {
    graph.addNode(seedX, seedZ, { type: 'seed' });
    return;
  }

  if (nearest.dist < cs * 5) {
    graph.getNode(nearest.id).attrs.type = 'seed';
    return;
  }

  const seedNode = graph.addNode(seedX, seedZ, { type: 'seed' });
  const target = graph.getNode(nearest.id);
  const result = findPath(
    Math.round(seedX / cs), Math.round(seedZ / cs),
    Math.round(target.x / cs), Math.round(target.z / cs),
    width, height, baseCost,
  );
  if (result) {
    const smooth = smoothPath(simplifyPath(result.path, 3.0), cs, 1);
    const edgeId = graph.addEdge(seedNode, nearest.id, {
      points: smooth.slice(1, -1),
      width: 16,
      hierarchy: 'arterial',
    });
    const occupancy = cityLayers?.getData('occupancy');
    if (occupancy) stampEdge(graph, edgeId, occupancy);
  }
}

function addWaterfrontRoad(graph, cityLayers, baseCost) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  if (!elevation || !params) return;

  const { width, height, cellSize: cs, seaLevel } = params;
  const centerX = Math.floor(width / 2);
  const centerZ = Math.floor(height / 2);
  const maxRadius = Math.floor(Math.min(width, height) * 0.25);

  const waterfrontCells = [];
  for (let gz = centerZ - maxRadius; gz <= centerZ + maxRadius; gz++) {
    for (let gx = centerX - maxRadius; gx <= centerX + maxRadius; gx++) {
      if (gx < 1 || gx >= width - 1 || gz < 1 || gz >= height - 1) continue;
      if (elevation.get(gx, gz) < seaLevel) continue;
      if (waterMask && waterMask.get(gx, gz) > 0) continue;

      let adj = false;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (elevation.get(nx, nz) < seaLevel || (waterMask && waterMask.get(nx, nz) > 0)) {
          adj = true;
          break;
        }
      }
      if (adj) waterfrontCells.push({ gx, gz });
    }
  }

  if (waterfrontCells.length < 4) return;

  waterfrontCells.sort((a, b) =>
    Math.atan2(a.gz - centerZ, a.gx - centerX) - Math.atan2(b.gz - centerZ, b.gx - centerX));

  const startCell = waterfrontCells[0];
  const endCell = waterfrontCells[Math.floor(waterfrontCells.length / 2)];

  const wfCost = (fgx, fgz, tgx, tgz) => {
    let c = baseCost(fgx, fgz, tgx, tgz);
    if (!isFinite(c)) return c;
    let minD = Infinity;
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const nx = tgx + dx, nz = tgz + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
        if (elevation.get(nx, nz) < seaLevel || (waterMask && waterMask.get(nx, nz) > 0)) {
          minD = Math.min(minD, Math.sqrt(dx * dx + dz * dz));
        }
      }
    }
    c *= minD <= 4 ? (0.3 + (minD / 4)) : 3.0;
    return c;
  };

  const result = findPath(startCell.gx, startCell.gz, endCell.gx, endCell.gz, width, height, wfCost);
  if (!result) return;

  const smooth = smoothPath(simplifyPath(result.path, 3.0), cs, 1);
  if (smooth.length < 2) return;

  // Snap endpoints to existing nodes if close enough, to avoid duplicate geometry
  const snapThresh = cs * 3;
  const existingNodeIds = new Set(graph.nodes.keys());

  const sn = snapOrCreateNode(graph, smooth[0].x, smooth[0].z, snapThresh, 'waterfront');
  const en = snapOrCreateNode(graph, smooth[smooth.length - 1].x, smooth[smooth.length - 1].z, snapThresh, 'waterfront');
  if (sn === en) return;

  const snSnapped = existingNodeIds.has(sn);
  const enSnapped = existingNodeIds.has(en);

  graph.addEdge(sn, en, { points: smooth.slice(1, -1), width: 14, hierarchy: 'structural' });

  // Stamp waterfront edge onto occupancy so connectors see it
  const occupancy = cityLayers.getData('occupancy');
  if (occupancy) {
    for (const edgeId of graph.incidentEdges(sn)) {
      stampEdge(graph, edgeId, occupancy);
    }
    for (const edgeId of graph.incidentEdges(en)) {
      stampEdge(graph, edgeId, occupancy);
    }
  }

  // Connect endpoints to nearest existing road node — skip if already snapped
  for (const [wfId, wasSnapped] of [[sn, snSnapped], [en, enSnapped]]) {
    if (wasSnapped) continue; // already connected to existing network

    const wf = graph.getNode(wfId);
    let bestId = null, bestDist = Infinity;
    for (const [id, node] of graph.nodes) {
      if (id === sn || id === en) continue;
      const d = Math.sqrt((node.x - wf.x) ** 2 + (node.z - wf.z) ** 2);
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
    if (bestId !== null && bestDist < cs * 30) {
      const t = graph.getNode(bestId);
      const r = findPath(
        Math.round(wf.x / cs), Math.round(wf.z / cs),
        Math.round(t.x / cs), Math.round(t.z / cs),
        width, height, baseCost,
      );
      if (r) {
        const sm = smoothPath(simplifyPath(r.path, 3.0), cs, 1);
        const edgeId = graph.addEdge(wfId, bestId, { points: sm.slice(1, -1), width: 8, hierarchy: 'structural' });
        if (occupancy) stampEdge(graph, edgeId, occupancy);
      }
    }
  }
}

/** Snap to an existing node if within threshold, otherwise create a new one. */
function snapOrCreateNode(graph, x, z, threshold, type) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < threshold) return nearest.id;
  return graph.addNode(x, z, { type });
}

function addFallbackRoads(graph, seedX, seedZ, baseCost, params, rng) {
  const { width, height, cellSize: cs } = params;
  const margin = cs * 5;

  const dirs = [
    { x: seedX, z: margin },
    { x: seedX, z: (height - 5) * cs },
    { x: margin, z: seedZ },
    { x: (width - 5) * cs, z: seedZ },
  ];

  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }

  let seedNode = null;
  for (const [id, node] of graph.nodes) {
    if (node.attrs.type === 'seed') { seedNode = id; break; }
  }
  if (!seedNode) seedNode = graph.addNode(seedX, seedZ, { type: 'seed' });

  for (const d of dirs.slice(0, 2)) {
    const result = findPath(
      Math.round(seedX / cs), Math.round(seedZ / cs),
      Math.round(d.x / cs), Math.round(d.z / cs),
      width, height, baseCost,
    );
    if (result) {
      const smooth = smoothPath(simplifyPath(result.path, 3.0), cs, 1);
      const node = graph.addNode(smooth[smooth.length - 1].x, smooth[smooth.length - 1].z, { type: 'entry' });
      graph.addEdge(seedNode, node, { points: smooth.slice(1, -1), width: 12, hierarchy: 'arterial' });
    }
  }
}
