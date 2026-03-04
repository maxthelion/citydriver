/**
 * A* pathfinding on a 2D grid with terrain-aware cost functions.
 * Used for routing roads between settlements in procedural terrain.
 *
 * All spatial functions use the (x, z) convention (y is up).
 */

// ---------------------------------------------------------------------------
// MinHeap - array-based binary heap with lazy decrease-key
// ---------------------------------------------------------------------------

class MinHeap {
  constructor() {
    this._heap = [];   // [{key, priority}]
    this._size = 0;
  }

  get size() {
    return this._size;
  }

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
        const tmp = heap[i];
        heap[i] = heap[parent];
        heap[parent] = tmp;
        i = parent;
      } else {
        break;
      }
    }
  }

  _sinkDown(i) {
    const heap = this._heap;
    const n = heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && heap[left].priority < heap[smallest].priority) {
        smallest = left;
      }
      if (right < n && heap[right].priority < heap[smallest].priority) {
        smallest = right;
      }
      if (smallest !== i) {
        const tmp = heap[i];
        heap[i] = heap[smallest];
        heap[smallest] = tmp;
        i = smallest;
      } else {
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 8-connected neighbor offsets
// ---------------------------------------------------------------------------

const NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

// ---------------------------------------------------------------------------
// Default heuristic: euclidean distance
// ---------------------------------------------------------------------------

function euclideanHeuristic(gx, gz, goalGx, goalGz) {
  const dx = gx - goalGx;
  const dz = gz - goalGz;
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------------------
// findPath - A* search on a 2D grid
// ---------------------------------------------------------------------------

/**
 * A* pathfinding on a 2D grid with configurable cost function.
 *
 * @param {number} startGx - start grid x coordinate
 * @param {number} startGz - start grid z coordinate
 * @param {number} goalGx - goal grid x coordinate
 * @param {number} goalGz - goal grid z coordinate
 * @param {number} gridWidth - grid width in cells
 * @param {number} gridHeight - grid height in cells
 * @param {Function} costFn - (fromGx, fromGz, toGx, toGz) => cost (> 0), or Infinity for impassable
 * @param {Function|null} heuristic - (gx, gz, goalGx, goalGz) => admissible estimate (default: euclidean)
 * @returns {{ path: Array<{gx: number, gz: number}>, cost: number } | null}
 *   path is ordered start to goal, inclusive of both endpoints
 */
export function findPath(startGx, startGz, goalGx, goalGz, gridWidth, gridHeight, costFn, heuristic = null) {
  const h = heuristic || euclideanHeuristic;

  // Handle start === goal
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

    // Lazy deletion: skip stale entries
    if (closed.has(currentKey)) continue;

    // Reached goal - reconstruct path
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

      // Bounds check
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
        const f = tentativeG + h(nx, nz, goalGx, goalGz);
        open.push(neighborKey, f);
      }
    }
  }

  // No path found
  return null;
}

// ---------------------------------------------------------------------------
// terrainCostFunction - factory for terrain-aware cost functions
// ---------------------------------------------------------------------------

/**
 * Default terrain-aware cost function factory.
 * Creates a cost function suitable for road routing.
 *
 * @param {Object} heightmap - object with .get(gx, gz) returning elevation, and .width, .height
 * @param {Object} options
 * @param {number} [options.slopePenalty=10] - multiplier for elevation change
 * @param {Set|null} [options.waterCells=null] - set of "gz*width+gx" keys that are water
 * @param {number} [options.waterPenalty=100] - cost for crossing water cells
 * @param {number} [options.edgeMargin=5] - cells from edge that get penalty
 * @param {number} [options.edgePenalty=5] - cost added near edges
 * @returns {Function} costFn suitable for findPath
 */
export function terrainCostFunction(heightmap, options = {}) {
  const {
    slopePenalty = 10,
    waterCells = null,
    waterPenalty = 100,
    edgeMargin = 5,
    edgePenalty = 5,
  } = options;

  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;

  return function cost(fromGx, fromGz, toGx, toGz) {
    const dx = toGx - fromGx;
    const dz = toGz - fromGz;
    const baseDist = Math.sqrt(dx * dx + dz * dz); // 1 or sqrt(2)

    const fromH = heightmap.get(fromGx, fromGz);
    const toH = heightmap.get(toGx, toGz);
    const slope = Math.abs(toH - fromH) / baseDist;

    let c = baseDist + slope * slopePenalty;

    const key = toGz * gridWidth + toGx;
    if (waterCells && waterCells.has(key)) c += waterPenalty;

    if (
      toGx < edgeMargin || toGx >= gridWidth - edgeMargin ||
      toGz < edgeMargin || toGz >= gridHeight - edgeMargin
    ) {
      c += edgePenalty;
    }

    return c;
  };
}

// ---------------------------------------------------------------------------
// simplifyPath - Ramer-Douglas-Peucker algorithm
// ---------------------------------------------------------------------------

/**
 * Perpendicular distance from point P to line segment A-B (in grid coords).
 */
function perpendicularDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;

  if (lenSq === 0) {
    // A and B are the same point
    const ex = px - ax;
    const ez = pz - az;
    return Math.sqrt(ex * ex + ez * ez);
  }

  // Distance = |cross product| / |AB|
  const cross = Math.abs((px - ax) * dz - (pz - az) * dx);
  return cross / Math.sqrt(lenSq);
}

/**
 * Simplify a path by removing redundant collinear points.
 * Uses Ramer-Douglas-Peucker algorithm.
 *
 * @param {Array<{gx: number, gz: number}>} path
 * @param {number} [epsilon=0.5] - tolerance in grid cells
 * @returns {Array<{gx: number, gz: number}>} simplified path
 */
export function simplifyPath(path, epsilon = 0.5) {
  if (path.length <= 2) return path.slice();

  return _rdp(path, 0, path.length - 1, epsilon);
}

function _rdp(points, start, end, epsilon) {
  if (end - start < 1) {
    return [points[start]];
  }

  const a = points[start];
  const b = points[end];

  let maxDist = 0;
  let maxIdx = start;

  for (let i = start + 1; i < end; i++) {
    const d = perpendicularDistance(points[i].gx, points[i].gz, a.gx, a.gz, b.gx, b.gz);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = _rdp(points, start, maxIdx, epsilon);
    const right = _rdp(points, maxIdx, end, epsilon);
    // Combine, avoiding duplicate at maxIdx
    return left.concat(right.slice(1));
  } else {
    return [a, b];
  }
}

// ---------------------------------------------------------------------------
// smoothPath - Chaikin's corner-cutting
// ---------------------------------------------------------------------------

/**
 * Smooth a grid path into a series of world-coordinate points.
 * Converts grid coords to world coords and applies Chaikin's corner-cutting.
 *
 * @param {Array<{gx: number, gz: number}>} path - from findPath
 * @param {number} cellSize - world units per grid cell
 * @param {number} [iterations=2] - number of smoothing passes
 * @returns {Array<{x: number, z: number}>} in world coordinates
 */
export function smoothPath(path, cellSize, iterations = 2) {
  if (path.length === 0) return [];
  if (path.length === 1) {
    return [{ x: path[0].gx * cellSize, z: path[0].gz * cellSize }];
  }

  // Convert to world coordinates
  let points = path.map(p => ({ x: p.gx * cellSize, z: p.gz * cellSize }));

  for (let iter = 0; iter < iterations; iter++) {
    if (points.length < 2) break;

    const smoothed = [points[0]]; // Keep first point fixed

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];

      // 25% point
      const q = {
        x: 0.75 * p0.x + 0.25 * p1.x,
        z: 0.75 * p0.z + 0.25 * p1.z,
      };
      // 75% point
      const r = {
        x: 0.25 * p0.x + 0.75 * p1.x,
        z: 0.25 * p0.z + 0.75 * p1.z,
      };

      smoothed.push(q, r);
    }

    smoothed.push(points[points.length - 1]); // Keep last point fixed
    points = smoothed;
  }

  return points;
}

// ---------------------------------------------------------------------------
// findWorldPath - convenience wrapper for world-coordinate pathfinding
// ---------------------------------------------------------------------------

/**
 * Find path between two world-coordinate points.
 * Convenience wrapper that converts world->grid, runs A*, converts back.
 *
 * @param {number} startX - world x coordinate
 * @param {number} startZ - world z coordinate
 * @param {number} goalX - world x coordinate
 * @param {number} goalZ - world z coordinate
 * @param {Object} heightmap - must have .worldToGrid(x,z), .get(gx,gz), .width, .height, .cellSize
 * @param {Object} [options={}] - passed to terrainCostFunction
 * @returns {{ path: Array<{x: number, z: number}>, cost: number } | null}
 */
export function findWorldPath(startX, startZ, goalX, goalZ, heightmap, options = {}) {
  const startGrid = heightmap.worldToGrid(startX, startZ);
  const goalGrid = heightmap.worldToGrid(goalX, goalZ);

  // Clamp to grid bounds
  const sgx = Math.max(0, Math.min(heightmap.width - 1, Math.round(startGrid.gx)));
  const sgz = Math.max(0, Math.min(heightmap.height - 1, Math.round(startGrid.gz)));
  const ggx = Math.max(0, Math.min(heightmap.width - 1, Math.round(goalGrid.gx)));
  const ggz = Math.max(0, Math.min(heightmap.height - 1, Math.round(goalGrid.gz)));

  const costFn = terrainCostFunction(heightmap, options);
  const result = findPath(sgx, sgz, ggx, ggz, heightmap.width, heightmap.height, costFn);

  if (!result) return null;

  // Convert grid path to world coordinates
  const worldPath = result.path.map(p => ({
    x: p.gx * heightmap.cellSize,
    z: p.gz * heightmap.cellSize,
  }));

  return { path: worldPath, cost: result.cost };
}
