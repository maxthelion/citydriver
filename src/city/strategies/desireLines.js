import { buildSkeletonRoads, addRoadToGraph } from '../skeleton.js';
import { findPath, simplifyPath, gridPathToWorldPolyline } from '../../core/pathfinding.js';
import { Grid2D } from '../../core/Grid2D.js';
import { SeededRandom } from '../../core/rng.js';

const OD_PAIRS_PRIMARY = 150;
const OD_PAIRS_SECONDARY = 80;
const BLUR_RADIUS = 3;
const PRIMARY_THRESHOLD = 0.85;   // percentile
const SECONDARY_THRESHOLD = 0.75;
const MIN_POLYLINE_CELLS = 8;
const NUCLEUS_SIGMA = 20;
const MIN_OD_DISTANCE = 10;

export class DesireLines {
  constructor(map) {
    this.map = map;
    this._tick = 0;
    this._rng = map.rng ? map.rng.fork('desire') : new SeededRandom(42);
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    if (this._tick === 2) {
      this._accumulateAndTrace(OD_PAIRS_PRIMARY, PRIMARY_THRESHOLD, 'collector');
      // Always continue — secondary pass may find roads even if primary didn't
      return true;
    }
    if (this._tick === 3) {
      this._accumulateAndTrace(OD_PAIRS_SECONDARY, SECONDARY_THRESHOLD, 'local');
      // Always continue to dead-end connection pass
      return true;
    }
    if (this._tick <= 6) {
      return this._connectDeadEnds();
    }
    return false;
  }

  _accumulateAndTrace(numPairs, thresholdPct, hierarchy) {
    const map = this.map;
    const w = map.width;
    const h = map.height;

    // 1. Generate O/D pairs
    const pairs = this._generateODPairs(numPairs);
    if (pairs.length === 0) return false;

    // 2. Pathfind each pair, accumulate heat
    const heat = new Grid2D(w, h, { type: 'float32' });
    const costFn = map.createPathCost('growth');
    let pathCount = 0;

    for (const { from, to } of pairs) {
      const result = findPath(from.gx, from.gz, to.gx, to.gz, w, h, costFn);
      if (!result || result.path.length < 2) continue;
      pathCount++;
      for (const p of result.path) {
        heat.set(p.gx, p.gz, heat.get(p.gx, p.gz) + 1);
      }
    }

    if (pathCount === 0) return false;

    // 3. Gaussian blur
    const blurred = _blurGrid(heat, w, h, BLUR_RADIUS);

    // 4. Threshold at percentile
    const threshold = _percentileThreshold(blurred, w, h, thresholdPct);
    if (threshold <= 0) return false;

    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      // Don't place roads on water or unbuildable terrain
      const gx = i % w;
      const gz = (i - gx) / w;
      if (blurred[i] >= threshold && map.waterMask.get(gx, gz) === 0) {
        mask[i] = 1;
      }
    }

    // 5. Thin to skeleton (before road exclusion, so the skeleton is connected)
    _thinZhangSuen(mask, w, h);

    // Now remove skeleton cells that overlap existing roads (suppress parallels).
    // But keep a 1-cell border so endpoints can still connect.
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (mask[gz * w + gx] === 0) continue;
        // Check if this cell is within 2 cells of an existing road
        let nearRoad = false;
        for (let dz = -2; dz <= 2 && !nearRoad; dz++) {
          for (let dx = -2; dx <= 2 && !nearRoad; dx++) {
            const nx = gx + dx, nz = gz + dz;
            if (nx >= 0 && nx < w && nz >= 0 && nz < h && map.roadGrid.get(nx, nz) > 0) {
              nearRoad = true;
            }
          }
        }
        if (nearRoad) mask[gz * w + gx] = 0;
      }
    }

    // 6. Trace polylines
    const polylines = _tracePolylines(mask, w, h);

    // 7. Extend endpoints to nearest road, simplify, smooth, add as roads
    let added = 0;
    for (const cells of polylines) {
      if (cells.length < MIN_POLYLINE_CELLS) continue;

      // Extend both endpoints toward nearest existing road cell
      const extended = _extendToRoad(cells, map.roadGrid, w, h);

      const gridPath = extended.map(i => ({ gx: i % w, gz: (i - i % w) / w }));
      const simplified = simplifyPath(gridPath, 1.0);
      const polyline = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
      if (polyline.length < 2) continue;

      map.addFeature('road', {
        polyline,
        width: 6,
        hierarchy,
        importance: hierarchy === 'collector' ? 0.5 : 0.3,
        source: 'desire',
      });

      // Add to graph so face-based strategies can find enclosed regions
      addRoadToGraph(map, polyline, 6, hierarchy);

      // Stamp onto roadGrid for subsequent passes
      for (const cell of cells) {
        const gx = cell % w;
        const gz = (cell - gx) / w;
        map.roadGrid.set(gx, gz, 1);
      }

      added++;
    }

    return added > 0;
  }

  _generateODPairs(count) {
    const map = this.map;
    const rng = this._rng;
    const w = map.width;
    const h = map.height;
    const nuclei = map.nuclei;
    const maxDist = Math.sqrt(w * w + h * h) * 0.8;

    // Precompute edge midpoints as potential destinations
    const edgePoints = [
      { gx: Math.floor(w / 2), gz: 2 },           // top
      { gx: Math.floor(w / 2), gz: h - 3 },       // bottom
      { gx: 2, gz: Math.floor(h / 2) },            // left
      { gx: w - 3, gz: Math.floor(h / 2) },        // right
    ];

    const pairs = [];

    for (let i = 0; i < count; i++) {
      const from = this._weightedPoint(rng, nuclei, w, h);
      if (!from) continue;

      let to;
      const r = rng.next();
      if (r < 0.3 && nuclei.length > 0) {
        // Target a nucleus
        const n = rng.pick(nuclei);
        to = { gx: n.gx, gz: n.gz };
      } else if (r < 0.5) {
        // Target a map edge
        to = rng.pick(edgePoints);
      } else {
        // Random buildable point
        to = this._randomBuildablePoint(rng, w, h);
      }

      if (!to) continue;

      const dx = from.gx - to.gx;
      const dz = from.gz - to.gz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < MIN_OD_DISTANCE || dist > maxDist) continue;

      pairs.push({ from, to });
    }

    return pairs;
  }

  _weightedPoint(rng, nuclei, w, h) {
    // 60% chance: near a nucleus (Gaussian), 40% chance: random buildable
    if (rng.next() < 0.6 && nuclei.length > 0) {
      const n = rng.pick(nuclei);
      const tierWeight = n.tier <= 1 ? 1.0 : n.tier <= 2 ? 0.7 : 0.4;
      const sigma = NUCLEUS_SIGMA * tierWeight;
      const gx = Math.round(n.gx + rng.gaussian() * sigma);
      const gz = Math.round(n.gz + rng.gaussian() * sigma);
      if (gx >= 1 && gx < w - 1 && gz >= 1 && gz < h - 1 &&
          this.map.buildability.get(gx, gz) > 0.1) {
        return { gx, gz };
      }
    }
    return this._randomBuildablePoint(rng, w, h);
  }

  _randomBuildablePoint(rng, w, h) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const gx = rng.int(3, w - 4);
      const gz = rng.int(3, h - 4);
      if (this.map.buildability.get(gx, gz) > 0.1) {
        return { gx, gz };
      }
    }
    return null;
  }

  /**
   * Extend dead-end graph nodes along their direction until they hit
   * another road, creating junction connections and enclosed faces.
   * Returns true if any connections were made.
   */
  _connectDeadEnds() {
    const map = this.map;
    const graph = map.graph;
    const MAX_EXTEND = 40;
    const MAX_PER_TICK = 15;

    const deadEnds = graph.deadEnds();
    if (deadEnds.length === 0) return false;

    let connected = 0;

    for (const nodeId of deadEnds) {
      if (connected >= MAX_PER_TICK) break;

      const node = graph.getNode(nodeId);
      const neighbors = graph.neighbors(nodeId);
      if (neighbors.length !== 1) continue;

      // Get direction: from the neighbor toward the dead end
      const neighborNode = graph.getNode(neighbors[0]);
      const dx = node.x - neighborNode.x;
      const dz = node.z - neighborNode.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1) continue;

      const dirX = dx / len;
      const dirZ = dz / len;

      const startGx = Math.round((node.x - map.originX) / map.cellSize);
      const startGz = Math.round((node.z - map.originZ) / map.cellSize);

      // Walk in edge direction — DON'T stop at water/unbuildable, just skip past them.
      // Check for road cells first (they may sit on low-buildability terrain).
      let hitGx = -1, hitGz = -1;
      for (let step = 3; step <= MAX_EXTEND; step++) {
        const gx = Math.round(startGx + dirX * step);
        const gz = Math.round(startGz + dirZ * step);
        if (gx < 1 || gx >= map.width - 1 || gz < 1 || gz >= map.height - 1) break;

        // Road check FIRST — if we hit a road, connect to it regardless of terrain
        if (map.roadGrid.get(gx, gz) > 0) {
          hitGx = gx;
          hitGz = gz;
          break;
        }
        // Don't break on water/unbuildable — keep walking, the road may be beyond
      }

      if (hitGx < 0) continue;

      // Pathfind using 'nucleus' preset — tolerates low buildability
      const costFn = map.createPathCost('nucleus');
      const result = findPath(startGx, startGz, hitGx, hitGz, map.width, map.height, costFn);
      if (!result || result.path.length < 2) continue;

      const simplified = simplifyPath(result.path, 1.0);
      const polyline = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
      if (polyline.length < 2) continue;

      map.addFeature('road', {
        polyline,
        width: 6,
        hierarchy: 'local',
        importance: 0.3,
        source: 'desire',
      });

      addRoadToGraph(map, polyline, 6, 'local');

      for (const p of result.path) {
        map.roadGrid.set(p.gx, p.gz, 1);
      }

      connected++;
    }

    return connected > 0;
  }
}

// --- Grid processing helpers ---

function _blurGrid(grid, w, h, radius) {
  const data = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      data[gz * w + gx] = grid.get(gx, gz);
    }
  }

  // Separable Gaussian blur
  const sigma = Math.max(radius / 3, 0.5);
  const kSize = radius * 2 + 1;
  const kernel = new Float32Array(kSize);
  let kSum = 0;
  for (let i = 0; i < kSize; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    kSum += kernel[i];
  }
  for (let i = 0; i < kSize; i++) kernel[i] /= kSum;

  // Horizontal
  const temp = new Float32Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.max(0, Math.min(w - 1, gx + k));
        sum += data[gz * w + sx] * kernel[k + radius];
      }
      temp[gz * w + gx] = sum;
    }
  }

  // Vertical
  const result = new Float32Array(w * h);
  for (let gx = 0; gx < w; gx++) {
    for (let gz = 0; gz < h; gz++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sz = Math.max(0, Math.min(h - 1, gz + k));
        sum += temp[sz * w + gx] * kernel[k + radius];
      }
      result[gz * w + gx] = sum;
    }
  }

  return result;
}

function _percentileThreshold(data, w, h, percentile) {
  const nonzero = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] > 0) nonzero.push(data[i]);
  }
  if (nonzero.length === 0) return 0;
  nonzero.sort((a, b) => a - b);
  const idx = Math.floor(nonzero.length * percentile);
  return nonzero[Math.min(idx, nonzero.length - 1)];
}

/**
 * Zhang-Suen thinning. Reduces binary mask to 1-pixel-wide skeleton.
 * Modifies mask in place.
 */
function _thinZhangSuen(mask, w, h) {
  let changed = true;
  while (changed) {
    changed = false;

    // Sub-iteration 1
    const toRemove1 = [];
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        if (mask[gz * w + gx] === 0) continue;
        const n = _neighbors8(mask, gx, gz, w);
        const B = n[0] + n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7];
        if (B < 2 || B > 6) continue;
        const A = _transitions(n);
        if (A !== 1) continue;
        // p2 * p4 * p6 == 0
        if (n[0] * n[2] * n[4] !== 0) continue;
        // p4 * p6 * p8 == 0
        if (n[2] * n[4] * n[6] !== 0) continue;
        toRemove1.push(gz * w + gx);
      }
    }
    for (const idx of toRemove1) { mask[idx] = 0; changed = true; }

    // Sub-iteration 2
    const toRemove2 = [];
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        if (mask[gz * w + gx] === 0) continue;
        const n = _neighbors8(mask, gx, gz, w);
        const B = n[0] + n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7];
        if (B < 2 || B > 6) continue;
        const A = _transitions(n);
        if (A !== 1) continue;
        // p2 * p4 * p8 == 0
        if (n[0] * n[2] * n[6] !== 0) continue;
        // p2 * p6 * p8 == 0
        if (n[0] * n[4] * n[6] !== 0) continue;
        toRemove2.push(gz * w + gx);
      }
    }
    for (const idx of toRemove2) { mask[idx] = 0; changed = true; }
  }
}

/** Get 8-connected neighbors as array [P2,P3,P4,P5,P6,P7,P8,P9] clockwise from top */
function _neighbors8(mask, gx, gz, w) {
  return [
    mask[(gz - 1) * w + gx] ? 1 : 0,       // P2 (top)
    mask[(gz - 1) * w + gx + 1] ? 1 : 0,   // P3 (top-right)
    mask[gz * w + gx + 1] ? 1 : 0,          // P4 (right)
    mask[(gz + 1) * w + gx + 1] ? 1 : 0,   // P5 (bottom-right)
    mask[(gz + 1) * w + gx] ? 1 : 0,        // P6 (bottom)
    mask[(gz + 1) * w + gx - 1] ? 1 : 0,   // P7 (bottom-left)
    mask[gz * w + gx - 1] ? 1 : 0,          // P8 (left)
    mask[(gz - 1) * w + gx - 1] ? 1 : 0,   // P9 (top-left)
  ];
}

/** Count 0->1 transitions in the ordered sequence P2..P9..P2 */
function _transitions(n) {
  let count = 0;
  for (let i = 0; i < 8; i++) {
    if (n[i] === 0 && n[(i + 1) % 8] === 1) count++;
  }
  return count;
}

/**
 * Trace connected runs of skeleton pixels into polylines.
 * Starts from endpoints (degree 1) and junctions (degree > 2).
 */
function _tracePolylines(mask, w, h) {
  const degree = new Uint8Array(w * h);
  const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

  // Compute degree of each skeleton pixel
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      if (mask[gz * w + gx] === 0) continue;
      let d = 0;
      for (const [dx, dz] of DIRS) {
        if (mask[(gz + dz) * w + gx + dx]) d++;
      }
      degree[gz * w + gx] = d;
    }
  }

  const visited = new Uint8Array(w * h);
  const polylines = [];

  // Start from endpoints (degree 1) first, then junctions (degree > 2)
  const startPoints = [];
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      const idx = gz * w + gx;
      if (mask[idx] === 0) continue;
      if (degree[idx] === 1 || degree[idx] > 2) {
        startPoints.push(idx);
      }
    }
  }

  // Also pick up isolated loops (all degree-2 pixels)
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      const idx = gz * w + gx;
      if (mask[idx] && degree[idx] === 2 && !visited[idx]) {
        startPoints.push(idx);
      }
    }
  }

  for (const startIdx of startPoints) {
    if (visited[startIdx] && degree[startIdx] <= 2) continue;

    // Try each unvisited neighbor direction from this start
    const sgx = startIdx % w;
    const sgz = (startIdx - sgx) / w;

    for (const [dx, dz] of DIRS) {
      const ngx = sgx + dx;
      const ngz = sgz + dz;
      const nIdx = ngz * w + ngx;
      if (!mask[nIdx] || visited[nIdx]) continue;

      // Walk the chain
      const chain = [startIdx];
      visited[startIdx] = 1;

      let cx = ngx, cz = ngz;
      while (true) {
        const cIdx = cz * w + cx;
        chain.push(cIdx);
        visited[cIdx] = 1;

        if (degree[cIdx] !== 2) break; // endpoint or junction

        // Find next unvisited neighbor
        let found = false;
        for (const [ddx, ddz] of DIRS) {
          const nnx = cx + ddx;
          const nnz = cz + ddz;
          const nnIdx = nnz * w + nnx;
          if (mask[nnIdx] && !visited[nnIdx]) {
            cx = nnx;
            cz = nnz;
            found = true;
            break;
          }
        }
        if (!found) break;
      }

      if (chain.length >= MIN_POLYLINE_CELLS) {
        polylines.push(chain);
      }
    }
  }

  return polylines;
}

/**
 * Extend a traced polyline (array of grid indices) so both endpoints
 * connect to the nearest existing road cell. Walks in a straight line
 * from each endpoint toward the closest roadGrid cell (up to 8 cells).
 */
function _extendToRoad(cells, roadGrid, w, h) {
  if (cells.length < 2) return cells;

  const result = [...cells];

  // Extend start
  const startExt = _walkToRoad(cells[0], cells[1], roadGrid, w, h);
  if (startExt.length > 0) {
    startExt.reverse();
    result.unshift(...startExt);
  }

  // Extend end
  const endExt = _walkToRoad(cells[cells.length - 1], cells[cells.length - 2], roadGrid, w, h);
  if (endExt.length > 0) {
    result.push(...endExt);
  }

  return result;
}

/**
 * From an endpoint, walk toward the nearest road cell (up to 8 steps).
 * Direction is away from the interior (opposite of endpoint→interior vector).
 */
function _walkToRoad(endIdx, interiorIdx, roadGrid, w, h) {
  const ex = endIdx % w, ez = (endIdx - ex) / w;
  const ix = interiorIdx % w, iz = (interiorIdx - ix) / w;

  // Find nearest road cell within search radius
  const SEARCH = 8;
  let bestDist = Infinity, bestGx = -1, bestGz = -1;
  for (let dz = -SEARCH; dz <= SEARCH; dz++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      const gx = ex + dx, gz = ez + dz;
      if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
      if (roadGrid.get(gx, gz) === 0) continue;
      const d = dx * dx + dz * dz;
      if (d < bestDist && d > 0) { bestDist = d; bestGx = gx; bestGz = gz; }
    }
  }

  if (bestGx < 0) return [];

  // Walk from endpoint toward the road cell using Bresenham
  const steps = [];
  let cx = ex, cz = ez;
  for (let i = 0; i < 12; i++) {
    const dx = bestGx - cx, dz = bestGz - cz;
    if (dx === 0 && dz === 0) break;
    // Step in the dominant direction
    const sx = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
    const sz = dz === 0 ? 0 : (dz > 0 ? 1 : -1);
    if (Math.abs(dx) >= Math.abs(dz)) {
      cx += sx;
    } else {
      cz += sz;
    }
    if (cx < 0 || cx >= w || cz < 0 || cz >= h) break;
    steps.push(cz * w + cx);
    if (roadGrid.get(cx, cz) > 0) break; // reached road
  }

  return steps;
}
