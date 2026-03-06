/**
 * C3. Anchor routes — inherit regional roads as a merged network.
 *
 * Pathfinds each regional road onto the city grid with a reuse discount,
 * then merges shared portions via mergeRoadPaths so overlapping roads
 * produce proper junctions and shared segments.
 */

import { PlanarGraph } from '../core/PlanarGraph.js';
import { Grid2D } from '../core/Grid2D.js';
import { findPath, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { anchorRouteCost } from './pathCost.js';
import { addMergedRoads } from './roadNetwork.js';

const HIER_RANK = { arterial: 1, collector: 2, structural: 3 };
const HIER_IMPORTANCE = { arterial: 0.9, collector: 0.6, structural: 0.45 };

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object|null} [occupancy] - occupancy grid for stamping
 * @returns {PlanarGraph}
 */
export function generateAnchorRoutes(cityLayers, rng, occupancy) {
  const graph = new PlanarGraph();
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!elevation || !params) return graph;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel;

  const baseCost = anchorRouteCost(cityLayers);
  const regionalRoads = cityLayers.getData('regionalRoads') || [];

  // --- Phase 1: Pathfind all roads onto a shared grid ---

  const roadGrid = new Grid2D(w, h, { type: 'uint8' });

  // Cost function: existing road cells get fixed low cost
  const sharedCost = (fromGx, fromGz, toGx, toGz) => {
    if (roadGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.3;
    }

    const dx = toGx - fromGx;
    const dz = toGz - fromGz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const fromH = elevation.get(fromGx, fromGz);
    const toH = elevation.get(toGx, toGz);
    const slope = Math.abs(toH - fromH) / dist;
    let c = dist + slope * 10;

    if (waterMask && waterMask.get(toGx, toGz) > 0) c += 50;
    if (seaLevel !== null && elevation.get(toGx, toGz) < seaLevel) c += 50;

    return c;
  };

  // Sort: arterials first
  const sortedRoads = regionalRoads
    .filter(r => r.hierarchy !== 'local')
    .sort((a, b) => (HIER_RANK[a.hierarchy] || 9) - (HIER_RANK[b.hierarchy] || 9));

  const rawPaths = []; // { cells, rank } for mergeRoadPaths

  for (const road of sortedRoads) {
    const path = pathfindRegionalRoad(road, params, elevation, waterMask, sharedCost);
    if (!path || path.length < 2) continue;

    const hierarchy = road.hierarchy || 'arterial';

    // Stamp onto road grid so later roads get reuse discount
    for (const cell of path) roadGrid.set(cell.gx, cell.gz, 1);

    const importance = HIER_IMPORTANCE[hierarchy] || 0.45;
    rawPaths.push({ cells: path, importance });
  }

  // --- Phase 2+3: Merge shared segments + add to graph ---

  addMergedRoads(graph, rawPaths, cs, occupancy);

  // Mark the city-center seed node
  const seedX = Math.floor(w / 2) * cs;
  const seedZ = Math.floor(h / 2) * cs;
  markSeedNode(graph, seedX, seedZ, cs);

  // Fallback: if no regional roads crossed the city, add minimal roads
  if (graph.edges.size === 0) {
    addFallbackRoads(graph, seedX, seedZ, baseCost, params, rng);
  }

  return graph;
}

// --- Helpers ---

function pathfindRegionalRoad(road, params, elevation, waterMask, costFn) {
  const { width: w, height: h, cellSize: cs, regionalCellSize, regionalMinGx, regionalMinGz } = params;
  const rcs = regionalCellSize || 50;
  const maxX = (w - 1) * cs;
  const maxZ = (h - 1) * cs;

  if (!road.path || road.path.length < 2) return null;
  const sourcePath = road.rawPath || road.path;

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

function markSeedNode(graph, seedX, seedZ, cs) {
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
  } else {
    graph.addNode(seedX, seedZ, { type: 'seed' });
  }
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
