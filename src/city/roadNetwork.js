/**
 * Unified road addition with overlap prevention.
 *
 * addMergedRoads() rasterizes existing graph edges into cell paths,
 * merges them with new paths via mergeRoadPaths, then only adds
 * truly new segments to the graph (upgrading existing edges when
 * a new path has higher importance).
 */

import { mergeRoadPaths } from '../core/mergeRoadPaths.js';
import { simplifyPath, smoothPath } from '../core/pathfinding.js';
import { stampEdge, stampJunction } from './roadOccupancy.js';

// ---- Importance → hierarchy / width ----

export function importanceToHierarchy(imp) {
  if (imp > 0.7) return 'arterial';
  if (imp > 0.4) return 'collector';
  return 'local';
}

export function importanceToWidth(imp) {
  if (imp > 0.7) return 16;
  if (imp > 0.4) return 12;
  return 8;
}

// ---- Rasterization ----

/**
 * Walk a world-coordinate polyline and return grid cells (Bresenham).
 */
export function rasterizePolyline(polyline, cs) {
  const cells = [];
  const seen = new Set();
  for (let i = 0; i < polyline.length - 1; i++) {
    const gx0 = Math.round(polyline[i].x / cs);
    const gz0 = Math.round(polyline[i].z / cs);
    const gx1 = Math.round(polyline[i + 1].x / cs);
    const gz1 = Math.round(polyline[i + 1].z / cs);
    bresenham(gx0, gz0, gx1, gz1, (gx, gz) => {
      const key = `${gx},${gz}`;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push({ gx, gz });
      }
    });
  }
  return cells;
}

function bresenham(x0, z0, x1, z1, visit) {
  let dx = Math.abs(x1 - x0);
  let dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;
  let x = x0, z = z0;
  while (true) {
    visit(x, z);
    if (x === x1 && z === z1) break;
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; x += sx; }
    if (e2 < dx) { err += dx; z += sz; }
  }
}

/**
 * Rasterize all existing graph edges into cell paths.
 * Returns pseudo-paths tagged with existingEdgeId.
 */
function rasterizeGraphEdges(graph, cs) {
  const result = [];
  for (const [edgeId, edge] of graph.edges) {
    const polyline = graph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;
    const cells = rasterizePolyline(polyline, cs);
    if (cells.length < 2) continue;
    const imp = edge.attrs.importance || (edge.hierarchy === 'arterial' ? 0.9 : edge.hierarchy === 'collector' ? 0.6 : 0.3);
    result.push({ cells, rank: 1, importance: imp, existingEdgeId: edgeId });
  }
  return result;
}

// ---- Main entry point ----

/**
 * Add a batch of road paths to the graph, merging against existing edges.
 *
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {Array<{ cells: Array<{gx,gz}>, importance: number }>} newPaths
 * @param {number} cs - city cellSize
 * @param {object|null} occupancy - occupancy grid (optional)
 * @returns {number[]} IDs of newly added edges
 */
export function addMergedRoads(graph, newPaths, cs, occupancy) {
  if (newPaths.length === 0) return [];

  // 1. Rasterize existing graph edges
  const existingPaths = rasterizeGraphEdges(graph, cs);

  // Build cell→existingEdgeId lookup for existing edges
  const cellToExistingEdge = new Map(); // "gx,gz" → { edgeId, importance }
  for (const ep of existingPaths) {
    for (const c of ep.cells) {
      const key = `${c.gx},${c.gz}`;
      const prev = cellToExistingEdge.get(key);
      if (!prev || ep.importance > prev.importance) {
        cellToExistingEdge.set(key, { edgeId: ep.existingEdgeId, importance: ep.importance });
      }
    }
  }

  // 2. Combine all paths for merge (existing + new)
  const allPaths = [];
  for (const ep of existingPaths) {
    allPaths.push({ cells: ep.cells, rank: 1, importance: ep.importance, existingEdgeId: ep.existingEdgeId });
  }
  for (const np of newPaths) {
    allPaths.push({ cells: np.cells, rank: 1, importance: np.importance });
  }

  // 3. Merge
  const merged = mergeRoadPaths(allPaths);

  // 4. Build cell → best importance from ALL paths (for hierarchy derivation)
  const cellBestImportance = new Map();
  for (const p of allPaths) {
    for (const c of p.cells) {
      const key = `${c.gx},${c.gz}`;
      const prev = cellBestImportance.get(key) || 0;
      if (p.importance > prev) cellBestImportance.set(key, p.importance);
    }
  }

  // 5. Process merged segments
  const nodeMap = new Map(); // "gx,gz" → nodeId
  const addedEdges = [];

  function getOrCreateNode(gx, gz) {
    const key = `${gx},${gz}`;
    if (nodeMap.has(key)) return nodeMap.get(key);
    const wx = gx * cs, wz = gz * cs;
    const nearest = graph.nearestNode(wx, wz);
    if (nearest && nearest.dist < cs * 2) {
      nodeMap.set(key, nearest.id);
      return nearest.id;
    }
    const id = graph.addNode(wx, wz, { type: 'road' });
    nodeMap.set(key, id);
    return id;
  }

  for (const seg of merged) {
    if (seg.cells.length < 2) continue;

    // Check how much of this segment overlaps existing edges
    let existingCells = 0;
    let bestNewImportance = 0;
    const overlappedEdges = new Set();

    for (const c of seg.cells) {
      const key = `${c.gx},${c.gz}`;
      const existing = cellToExistingEdge.get(key);
      if (existing) {
        existingCells++;
        overlappedEdges.add(existing.edgeId);
      }
    }

    // Derive importance for this segment
    let imp = 0;
    for (const c of seg.cells) {
      const ci = cellBestImportance.get(`${c.gx},${c.gz}`) || 0;
      if (ci > imp) imp = ci;
    }
    if (imp === 0) imp = 0.25;

    const overlapFraction = existingCells / seg.cells.length;

    // If segment is mostly from existing edges, consider upgrading instead of adding
    if (overlapFraction > 0.8) {
      // Check if new paths contribute higher importance → upgrade existing edges
      for (const edgeId of overlappedEdges) {
        const edge = graph.getEdge(edgeId);
        if (!edge) continue;
        const existingImp = edge.attrs.importance || 0;
        if (imp > existingImp) {
          edge.hierarchy = importanceToHierarchy(imp);
          edge.width = importanceToWidth(imp);
          edge.attrs.importance = imp;
        }
      }
      continue;
    }

    // New segment — add to graph
    const startCell = seg.cells[0];
    const endCell = seg.cells[seg.cells.length - 1];

    const startNode = getOrCreateNode(startCell.gx, startCell.gz);
    const endNode = getOrCreateNode(endCell.gx, endCell.gz);
    if (startNode === endNode) continue;
    if (graph.neighbors(startNode).includes(endNode)) continue;

    const simplified = simplifyPath(seg.cells, 2.0);
    const smooth = smoothPath(simplified, cs, 1);
    if (smooth.length < 2) continue;

    const edgeId = graph.addEdge(startNode, endNode, {
      points: smooth.slice(1, -1),
      width: importanceToWidth(imp),
      hierarchy: importanceToHierarchy(imp),
      importance: imp,
    });

    if (occupancy) {
      stampEdge(graph, edgeId, occupancy);
      const sn = graph.getNode(startNode);
      const en = graph.getNode(endNode);
      if (graph.degree(startNode) >= 3) stampJunction(sn.x, sn.z, 10, occupancy);
      if (graph.degree(endNode) >= 3) stampJunction(en.x, en.z, 10, occupancy);
    }

    addedEdges.push(edgeId);
  }

  return addedEdges;
}
