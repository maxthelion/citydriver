/**
 * Graph utility functions for the road network.
 * Provides rasterization, flood-fill, boundary extraction,
 * and ID generation for nodes and edges.
 */

import { distance2D, pointToSegmentDist } from '../core/math.js';

// ---------------------------------------------------------------------------
// Node / Edge ID generators
// ---------------------------------------------------------------------------

let nextNodeId = 0;
let nextEdgeId = 0;

export function newNodeId() {
  return nextNodeId++;
}

export function resetNodeIds() {
  nextNodeId = 0;
}

export function newEdgeId() {
  return nextEdgeId++;
}

export function resetEdgeIds() {
  nextEdgeId = 0;
}

// ---------------------------------------------------------------------------
// Rasterize roads onto a grid
// ---------------------------------------------------------------------------

/**
 * Rasterize road edges onto a grid for block detection.
 * Uses distance-to-segment thick line rasterization based on each edge's width.
 *
 * @param {Array} edges - Edge objects with .points [{x,z}] and .width
 * @param {number} gridWidth
 * @param {number} gridHeight
 * @param {number} cellSize
 * @returns {Uint8Array} 1 = road, 0 = not road (indexed as gz * gridWidth + gx)
 */
export function rasterizeRoads(edges, gridWidth, gridHeight, cellSize) {
  const grid = new Uint8Array(gridWidth * gridHeight);

  for (const edge of edges) {
    const points = edge.points;
    if (!points || points.length < 2) continue;

    const halfWidth = (edge.width || 10) / 2;
    const halfCells = Math.ceil(halfWidth / cellSize);

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];

      const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x) / cellSize) - halfCells);
      const maxX = Math.min(gridWidth - 1, Math.ceil(Math.max(p0.x, p1.x) / cellSize) + halfCells);
      const minZ = Math.max(0, Math.floor(Math.min(p0.z, p1.z) / cellSize) - halfCells);
      const maxZ = Math.min(gridHeight - 1, Math.ceil(Math.max(p0.z, p1.z) / cellSize) + halfCells);

      const ax = p0.x;
      const az = p0.z;
      const bx = p1.x;
      const bz = p1.z;

      for (let gz = minZ; gz <= maxZ; gz++) {
        for (let gx = minX; gx <= maxX; gx++) {
          if (grid[gz * gridWidth + gx] === 1) continue;

          const wx = gx * cellSize;
          const wz = gz * cellSize;

          const dx = bx - ax;
          const dz = bz - az;
          const lenSq = dx * dx + dz * dz;

          let dist;
          if (lenSq === 0) {
            dist = distance2D(wx, wz, ax, az);
          } else {
            let t = ((wx - ax) * dx + (wz - az) * dz) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const projX = ax + t * dx;
            const projZ = az + t * dz;
            dist = distance2D(wx, wz, projX, projZ);
          }

          if (dist <= halfWidth) {
            grid[gz * gridWidth + gx] = 1;
          }
        }
      }
    }
  }

  return grid;
}

// ---------------------------------------------------------------------------
// Flood-fill to find connected non-road regions
// ---------------------------------------------------------------------------

/**
 * Flood-fill to find connected non-road, non-water regions (blocks).
 *
 * @param {Uint8Array} roadGrid - from rasterizeRoads (1=road, 0=not)
 * @param {Set<number>} waterCells - set of gz*gridWidth+gx for water cells
 * @param {number} gridWidth
 * @param {number} gridHeight
 * @returns {number[][]} array of arrays of cell indices, one per region
 */
export function floodFillRegions(roadGrid, waterCells, gridWidth, gridHeight) {
  const visited = new Uint8Array(gridWidth * gridHeight);
  const regions = [];

  for (let i = 0; i < gridWidth * gridHeight; i++) {
    if (roadGrid[i] === 1 || waterCells.has(i)) {
      visited[i] = 1;
    }
  }

  const stack = [];

  for (let gz = 0; gz < gridHeight; gz++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const idx = gz * gridWidth + gx;
      if (visited[idx]) continue;

      const region = [];
      stack.length = 0;
      stack.push(idx);
      visited[idx] = 1;

      while (stack.length > 0) {
        const cellIdx = stack.pop();
        region.push(cellIdx);

        const cx = cellIdx % gridWidth;
        const cz = (cellIdx - cx) / gridWidth;

        const neighbors = [
          { nx: cx - 1, nz: cz },
          { nx: cx + 1, nz: cz },
          { nx: cx, nz: cz - 1 },
          { nx: cx, nz: cz + 1 },
        ];

        for (const { nx, nz } of neighbors) {
          if (nx < 0 || nx >= gridWidth || nz < 0 || nz >= gridHeight) continue;
          const nIdx = nz * gridWidth + nx;
          if (visited[nIdx]) continue;
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }

      if (region.length > 0) {
        regions.push(region);
      }
    }
  }

  return regions;
}

// ---------------------------------------------------------------------------
// Extract boundary polygon from a set of grid cells
// ---------------------------------------------------------------------------

/**
 * Extract boundary polygon from a set of grid cells.
 * Finds boundary cells, sorts by angle from centroid, simplifies by
 * removing collinear points.
 *
 * @param {number[]} cells - cell indices (gz*gridWidth+gx)
 * @param {number} gridWidth
 * @param {number} cellSize
 * @returns {{x: number, z: number}[]} polygon vertices in world coords
 */
export function extractBoundary(cells, gridWidth, cellSize) {
  if (cells.length === 0) return [];

  const cellSet = new Set(cells);

  const boundaryCells = [];
  for (const idx of cells) {
    const gx = idx % gridWidth;
    const gz = (idx - gx) / gridWidth;

    const hasExternalNeighbor =
      !cellSet.has((gz - 1) * gridWidth + gx) ||
      !cellSet.has((gz + 1) * gridWidth + gx) ||
      !cellSet.has(gz * gridWidth + (gx - 1)) ||
      !cellSet.has(gz * gridWidth + (gx + 1));

    if (hasExternalNeighbor) {
      boundaryCells.push({ gx, gz, idx });
    }
  }

  if (boundaryCells.length === 0) {
    let minGx = Infinity, maxGx = -Infinity, minGz = Infinity, maxGz = -Infinity;
    for (const idx of cells) {
      const gx = idx % gridWidth;
      const gz = (idx - gx) / gridWidth;
      if (gx < minGx) minGx = gx;
      if (gx > maxGx) maxGx = gx;
      if (gz < minGz) minGz = gz;
      if (gz > maxGz) maxGz = gz;
    }
    return [
      { x: minGx * cellSize, z: minGz * cellSize },
      { x: (maxGx + 1) * cellSize, z: minGz * cellSize },
      { x: (maxGx + 1) * cellSize, z: (maxGz + 1) * cellSize },
      { x: minGx * cellSize, z: (maxGz + 1) * cellSize },
    ];
  }

  let cx = 0, cz = 0;
  for (const bc of boundaryCells) {
    cx += bc.gx;
    cz += bc.gz;
  }
  cx /= boundaryCells.length;
  cz /= boundaryCells.length;

  boundaryCells.sort((a, b) => {
    const angleA = Math.atan2(a.gz - cz, a.gx - cx);
    const angleB = Math.atan2(b.gz - cz, b.gx - cx);
    return angleA - angleB;
  });

  const polygon = [];
  const len = boundaryCells.length;

  for (let i = 0; i < len; i++) {
    const prev = boundaryCells[(i - 1 + len) % len];
    const curr = boundaryCells[i];
    const next = boundaryCells[(i + 1) % len];

    const dx1 = curr.gx - prev.gx;
    const dz1 = curr.gz - prev.gz;
    const dx2 = next.gx - curr.gx;
    const dz2 = next.gz - curr.gz;

    if (dx1 !== dx2 || dz1 !== dz2) {
      polygon.push({
        x: curr.gx * cellSize,
        z: curr.gz * cellSize,
      });
    }
  }

  if (polygon.length < 3) {
    return boundaryCells.map(bc => ({
      x: bc.gx * cellSize,
      z: bc.gz * cellSize,
    }));
  }

  return polygon;
}

// ---------------------------------------------------------------------------
// Graph query helpers
// ---------------------------------------------------------------------------

export function hasEdge(edges, nodeA, nodeB) {
  return edges.some(
    e => (e.from === nodeA && e.to === nodeB) || (e.from === nodeB && e.to === nodeA)
  );
}

export function getNodeEdges(edges, nodeId) {
  return edges.filter(e => e.from === nodeId || e.to === nodeId);
}

export function nearestNode(nodes, x, z) {
  let best = null;
  let bestDist = Infinity;

  for (const node of nodes.values()) {
    const d = distance2D(x, z, node.x, node.z);
    if (d < bestDist) {
      bestDist = d;
      best = node;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Snap new edge endpoints into the existing road graph
// ---------------------------------------------------------------------------

/**
 * Snap the endpoints of a newly-added edge to existing nodes or edge polylines.
 * This ensures the road network stays connected rather than creating isolated
 * node pairs.
 *
 * @param {number} edgeId - ID of the edge to snap
 * @param {Map} nodes - road network nodes
 * @param {Array} edges - road network edges
 * @param {number} [snapDist=30] - maximum snap distance
 */
export function snapEndpointsToNetwork(edgeId, nodes, edges, snapDist = 30) {
  const edge = edges.find(e => e.id === edgeId);
  if (!edge) return;

  const endpoints = ['from', 'to'];

  for (const endKey of endpoints) {
    const nodeId = edge[endKey];
    const node = nodes.get(nodeId);
    if (!node) continue;

    const px = node.x;
    const pz = node.z;

    // 1. Find nearest existing node (excluding nodes on this edge)
    let bestNode = null;
    let bestNodeDist = Infinity;
    for (const [id, n] of nodes) {
      if (id === edge.from || id === edge.to) continue;
      const d = distance2D(px, pz, n.x, n.z);
      if (d < bestNodeDist) {
        bestNodeDist = d;
        bestNode = n;
      }
    }

    if (bestNode && bestNodeDist <= snapDist) {
      // Reuse existing node
      edge[endKey] = bestNode.id;
      nodes.delete(nodeId);
      // Update polyline endpoint
      if (endKey === 'from' && edge.points && edge.points.length > 0) {
        edge.points[0] = { x: bestNode.x, z: bestNode.z };
      } else if (endKey === 'to' && edge.points && edge.points.length > 0) {
        edge.points[edge.points.length - 1] = { x: bestNode.x, z: bestNode.z };
      }
      continue;
    }

    // 2. Find nearest point on any existing edge polyline
    let bestEdge = null;
    let bestSegIdx = -1;
    let bestT = 0;
    let bestProjDist = Infinity;
    let bestProjX = 0;
    let bestProjZ = 0;

    for (const otherEdge of edges) {
      if (otherEdge.id === edgeId) continue;
      if (!otherEdge.points || otherEdge.points.length < 2) continue;

      for (let i = 0; i < otherEdge.points.length - 1; i++) {
        const ax = otherEdge.points[i].x;
        const az = otherEdge.points[i].z;
        const bx = otherEdge.points[i + 1].x;
        const bz = otherEdge.points[i + 1].z;

        const d = pointToSegmentDist(px, pz, ax, az, bx, bz);
        if (d < bestProjDist) {
          bestProjDist = d;
          bestEdge = otherEdge;
          bestSegIdx = i;

          // Compute projection point
          const dx = bx - ax;
          const dz = bz - az;
          const lenSq = dx * dx + dz * dz;
          if (lenSq === 0) {
            bestT = 0;
            bestProjX = ax;
            bestProjZ = az;
          } else {
            let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
            t = Math.max(0, Math.min(1, t));
            bestT = t;
            bestProjX = ax + t * dx;
            bestProjZ = az + t * dz;
          }
        }
      }
    }

    if (bestEdge && bestProjDist <= snapDist) {
      // Move endpoint to projection point
      node.x = bestProjX;
      node.z = bestProjZ;

      // Update polyline endpoint
      if (endKey === 'from' && edge.points && edge.points.length > 0) {
        edge.points[0] = { x: bestProjX, z: bestProjZ };
      } else if (endKey === 'to' && edge.points && edge.points.length > 0) {
        edge.points[edge.points.length - 1] = { x: bestProjX, z: bestProjZ };
      }

      // Split the existing edge at the projection point
      const splitPts = bestEdge.points;
      const firstHalf = splitPts.slice(0, bestSegIdx + 1);
      firstHalf.push({ x: bestProjX, z: bestProjZ });
      const secondHalf = [{ x: bestProjX, z: bestProjZ }];
      secondHalf.push(...splitPts.slice(bestSegIdx + 1));

      // Create new node at split point (reuse our endpoint node)
      const splitNodeId = nodeId;

      // Create new edge for the second half
      const splitEdgeId = newEdgeId();
      const origTo = bestEdge.to;

      // Update original edge: keep first half
      bestEdge.points = firstHalf;
      bestEdge.to = splitNodeId;

      // Add second-half edge
      edges.push({
        id: splitEdgeId,
        from: splitNodeId,
        to: origTo,
        points: secondHalf,
        width: bestEdge.width,
        hierarchy: bestEdge.hierarchy,
        districtId: bestEdge.districtId,
      });
    }
  }

  // Remove degenerate edge (from === to)
  if (edge.from === edge.to) {
    const idx = edges.indexOf(edge);
    if (idx >= 0) edges.splice(idx, 1);
    return;
  }

  // Remove duplicate edges (same from/to pair as existing edge)
  const keyA = edge.from < edge.to ? `${edge.from}-${edge.to}` : `${edge.to}-${edge.from}`;
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i];
    if (e.id === edge.id) continue;
    const keyB = e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
    if (keyA === keyB) {
      // Keep the one with higher hierarchy; remove the new one
      const idx = edges.indexOf(edge);
      if (idx >= 0) edges.splice(idx, 1);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Post-processing: separate close parallel edges
// ---------------------------------------------------------------------------

const HIERARCHY_RANK = { primary: 3, secondary: 2, collector: 1, local: 0, alley: 0 };

/**
 * Compute min segment-to-segment distance between two polylines.
 */
function minPolylineDist(ptsA, ptsB) {
  let min = Infinity;
  for (let i = 0; i < ptsA.length - 1; i++) {
    for (let j = 0; j < ptsB.length - 1; j++) {
      const d = Math.min(
        pointToSegmentDist(ptsA[i].x, ptsA[i].z, ptsB[j].x, ptsB[j].z, ptsB[j + 1].x, ptsB[j + 1].z),
        pointToSegmentDist(ptsA[i + 1].x, ptsA[i + 1].z, ptsB[j].x, ptsB[j].z, ptsB[j + 1].x, ptsB[j + 1].z),
        pointToSegmentDist(ptsB[j].x, ptsB[j].z, ptsA[i].x, ptsA[i].z, ptsA[i + 1].x, ptsA[i + 1].z),
        pointToSegmentDist(ptsB[j + 1].x, ptsB[j + 1].z, ptsA[i].x, ptsA[i].z, ptsA[i + 1].x, ptsA[i + 1].z),
      );
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Check if removing an edge keeps the graph connected.
 * Uses BFS from any remaining node, checking all nodes are reachable.
 * Also excludes already-removed edges from consideration.
 */
function isConnectedWithout(edges, excludeEdge, alreadyRemoved) {
  const nodeSet = new Set();
  const adj = new Map();

  for (const e of edges) {
    if (e === excludeEdge || alreadyRemoved.has(e)) continue;
    if (!e.points || e.points.length < 2) continue;
    nodeSet.add(e.from);
    nodeSet.add(e.to);
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }

  if (nodeSet.size === 0) return true;

  const start = nodeSet.values().next().value;
  const visited = new Set([start]);
  const queue = [start];

  while (queue.length > 0) {
    const node = queue.shift();
    for (const n of (adj.get(node) || [])) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }

  return visited.size === nodeSet.size;
}

/**
 * Remove close non-connected edges to ensure road clearance (V4).
 * For each violating pair, removes the lower-hierarchy/shorter edge,
 * but only if the graph remains connected.
 *
 * @param {Array} edges - road network edges (modified in-place via splice)
 * @param {number} [minDist=5] - minimum separation distance
 */
export function separateCloseEdges(edges, minDist = 5) {
  const limit = Math.min(edges.length, 100);

  // Find all violating pairs
  const violations = [];
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      const a = edges[i];
      const b = edges[j];

      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      if (!a.points || a.points.length < 2 || !b.points || b.points.length < 2) continue;

      const d = minPolylineDist(a.points, b.points);
      if (d >= minDist) continue;

      violations.push({ a, b, dist: d });
    }
  }

  // Sort by distance (closest pairs first — most urgent)
  violations.sort((x, y) => x.dist - y.dist);

  const removed = new Set();

  for (const { a, b } of violations) {
    if (removed.has(a) || removed.has(b)) continue;

    // Choose candidate for removal: lower hierarchy first, then shorter polyline
    const rankA = HIERARCHY_RANK[a.hierarchy] ?? 0;
    const rankB = HIERARCHY_RANK[b.hierarchy] ?? 0;

    let candidates;
    if (rankA !== rankB) {
      candidates = rankA < rankB ? [a, b] : [b, a];
    } else {
      // Same hierarchy: try shorter one first
      const lenA = a.points.length;
      const lenB = b.points.length;
      candidates = lenA <= lenB ? [a, b] : [b, a];
    }

    for (const candidate of candidates) {
      if (removed.has(candidate)) continue;
      if (isConnectedWithout(edges, candidate, removed)) {
        removed.add(candidate);
        break;
      }
    }
  }

  // Remove marked edges
  for (let i = edges.length - 1; i >= 0; i--) {
    if (removed.has(edges[i])) {
      edges.splice(i, 1);
    }
  }
}

