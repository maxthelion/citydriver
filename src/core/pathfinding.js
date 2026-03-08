/**
 * A* pathfinding on a Grid2D with terrain-aware cost functions.
 */

import { Grid2D } from './Grid2D.js';

// Binary min-heap
class MinHeap {
  constructor() {
    this._heap = [];
    this._size = 0;
  }

  get size() { return this._size; }

  push(key, priority) {
    this._heap.push({ key, priority });
    this._size++;
    this._bubbleUp(this._heap.length - 1);
  }

  pop() {
    if (this._heap.length === 0) return null;
    const top = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = last;
      this._sinkDown(0);
    }
    this._size--;
    return top;
  }

  _bubbleUp(i) {
    const heap = this._heap;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[i].priority < heap[parent].priority) {
        [heap[i], heap[parent]] = [heap[parent], heap[i]];
        i = parent;
      } else break;
    }
  }

  _sinkDown(i) {
    const heap = this._heap;
    const n = heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && heap[l].priority < heap[smallest].priority) smallest = l;
      if (r < n && heap[r].priority < heap[smallest].priority) smallest = r;
      if (smallest !== i) {
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      } else break;
    }
  }
}

const NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

function euclideanHeuristic(gx, gz, goalGx, goalGz) {
  const dx = gx - goalGx;
  const dz = gz - goalGz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * A* pathfinding on a 2D grid.
 *
 * @param {number} startGx - start grid x
 * @param {number} startGz - start grid z
 * @param {number} goalGx - goal grid x
 * @param {number} goalGz - goal grid z
 * @param {number} gridWidth
 * @param {number} gridHeight
 * @param {Function} costFn - (fromGx, fromGz, toGx, toGz) => cost or Infinity
 * @param {Function|null} [heuristic] - admissible estimate (default: euclidean)
 * @returns {{ path: Array<{gx, gz}>, cost: number } | null}
 */
export function findPath(startGx, startGz, goalGx, goalGz, gridWidth, gridHeight, costFn, heuristic = null) {
  const h = heuristic || euclideanHeuristic;

  if (startGx === goalGx && startGz === goalGz) {
    return { path: [{ gx: startGx, gz: startGz }], cost: 0 };
  }

  const startKey = startGz * gridWidth + startGx;
  const goalKey = goalGz * gridWidth + goalGx;

  const open = new MinHeap();
  const closed = new Set();
  const gScore = new Map();
  const cameFrom = new Map();

  gScore.set(startKey, 0);
  open.push(startKey, h(startGx, startGz, goalGx, goalGz));

  while (open.size > 0) {
    const { key: currentKey } = open.pop();
    if (closed.has(currentKey)) continue;

    if (currentKey === goalKey) {
      const path = [];
      let k = currentKey;
      while (k !== undefined) {
        const gx = k % gridWidth;
        const gz = (k - gx) / gridWidth;
        path.push({ gx, gz });
        k = cameFrom.get(k);
      }
      path.reverse();
      return { path, cost: gScore.get(goalKey) };
    }

    closed.add(currentKey);
    const currentGx = currentKey % gridWidth;
    const currentGz = (currentKey - currentGx) / gridWidth;
    const currentG = gScore.get(currentKey);

    for (let i = 0; i < NEIGHBORS.length; i++) {
      const nx = currentGx + NEIGHBORS[i][0];
      const nz = currentGz + NEIGHBORS[i][1];
      if (nx < 0 || nx >= gridWidth || nz < 0 || nz >= gridHeight) continue;

      const neighborKey = nz * gridWidth + nx;
      if (closed.has(neighborKey)) continue;

      const moveCost = costFn(currentGx, currentGz, nx, nz);
      if (!isFinite(moveCost) || moveCost <= 0) continue;

      const tentativeG = currentG + moveCost;
      const prevG = gScore.get(neighborKey);

      if (prevG === undefined || tentativeG < prevG) {
        gScore.set(neighborKey, tentativeG);
        cameFrom.set(neighborKey, currentKey);
        open.push(neighborKey, tentativeG + h(nx, nz, goalGx, goalGz));
      }
    }
  }

  return null;
}

/**
 * Create a terrain-aware cost function for road routing on a Grid2D.
 *
 * @param {Grid2D} elevation - elevation grid
 * @param {object} [options]
 * @returns {Function}
 */
export function terrainCostFunction(elevation, options = {}) {
  const {
    slopePenalty = 10,
    waterGrid = null,
    waterPenalty = 100,
    bridgeGrid = null,
    edgeMargin = 5,
    edgePenalty = 5,
    seaLevel = null,
  } = options;

  return function cost(fromGx, fromGz, toGx, toGz) {
    const dx = toGx - fromGx;
    const dz = toGz - fromGz;
    const baseDist = Math.sqrt(dx * dx + dz * dz);

    const fromH = elevation.get(fromGx, fromGz);
    const toH = elevation.get(toGx, toGz);
    const slope = Math.abs(toH - fromH) / baseDist;

    let c = baseDist + slope * slopePenalty;

    // Bridge cells bypass water penalties
    const isBridge = bridgeGrid && bridgeGrid.get(toGx, toGz) > 0;

    // Block below-sea-level cells (unless bridged)
    if (seaLevel !== null && elevation.get(toGx, toGz) < seaLevel && !isBridge) return Infinity;

    if (waterGrid && waterGrid.get(toGx, toGz) > 0 && !isBridge) {
      c += waterPenalty;
    }

    if (
      toGx < edgeMargin || toGx >= elevation.width - edgeMargin ||
      toGz < edgeMargin || toGz >= elevation.height - edgeMargin
    ) {
      c += edgePenalty;
    }

    return c;
  };
}

/**
 * Simplify a path using Ramer-Douglas-Peucker.
 */
export function simplifyPath(path, epsilon = 0.5) {
  if (path.length <= 2) return path.slice();
  return rdp(path, 0, path.length - 1, epsilon);
}

function rdp(points, start, end, epsilon) {
  if (end - start < 1) return [points[start]];

  const a = points[start];
  const b = points[end];
  let maxDist = 0;
  let maxIdx = start;

  for (let i = start + 1; i < end; i++) {
    const d = perpDist(points[i].gx, points[i].gz, a.gx, a.gz, b.gx, b.gz);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left = rdp(points, start, maxIdx, epsilon);
    const right = rdp(points, maxIdx, end, epsilon);
    return left.concat(right.slice(1));
  }
  return [a, b];
}

function perpDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (pz - az) ** 2);
  return Math.abs((px - ax) * dz - (pz - az) * dx) / Math.sqrt(lenSq);
}

/**
 * Convert grid-coord path to world-coord polyline.
 * Quantizes to half-cell resolution and removes consecutive duplicates.
 */
export function gridPathToWorldPolyline(path, cellSize, originX = 0, originZ = 0) {
  if (path.length === 0) return [];

  const half = cellSize * 0.5;
  const result = [];
  let prevX = NaN, prevZ = NaN;

  for (const p of path) {
    const wx = Math.round((p.gx * cellSize + originX) / half) * half;
    const wz = Math.round((p.gz * cellSize + originZ) / half) * half;
    if (wx === prevX && wz === prevZ) continue;
    result.push({ x: wx, z: wz });
    prevX = wx;
    prevZ = wz;
  }

  return result;
}
