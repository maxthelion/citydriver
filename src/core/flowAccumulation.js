/**
 * D8 and D-infinity flow routing and drainage network extraction.
 * Adapted to work with Grid2D.
 */

// D8 direction encoding: 0=E 1=SE 2=S 3=SW 4=W 5=NW 6=N 7=NE
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1];
const DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];
const NO_DIR = -1;

export { DX, DZ, DIST, NO_DIR };

// Min-heap for priority flood
class MinHeap {
  constructor() { this._data = []; }
  get size() { return this._data.length; }

  push(priority, value) {
    this._data.push({ priority, value });
    this._bubbleUp(this._data.length - 1);
  }

  pop() {
    const top = this._data[0];
    const last = this._data.pop();
    if (this._data.length > 0 && last !== undefined) {
      this._data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  _bubbleUp(i) {
    const d = this._data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (d[i].priority >= d[parent].priority) break;
      [d[i], d[parent]] = [d[parent], d[i]];
      i = parent;
    }
  }

  _sinkDown(i) {
    const d = this._data;
    const n = d.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && d[l].priority < d[smallest].priority) smallest = l;
      if (r < n && d[r].priority < d[smallest].priority) smallest = r;
      if (smallest === i) break;
      [d[i], d[smallest]] = [d[smallest], d[i]];
      i = smallest;
    }
  }
}

/**
 * Fill sinks in a Grid2D elevation so water can always flow to an edge.
 * Modifies the grid in place.
 */
export function fillSinks(elevation) {
  const W = elevation.width;
  const H = elevation.height;
  const total = W * H;
  const EPS = 1e-5;

  const processed = new Uint8Array(total);
  const heap = new MinHeap();

  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      if (gx === 0 || gx === W - 1 || gz === 0 || gz === H - 1) {
        const idx = gz * W + gx;
        processed[idx] = 1;
        heap.push(elevation.get(gx, gz), idx);
      }
    }
  }

  while (heap.size > 0) {
    const { priority: elev, value: idx } = heap.pop();
    const cx = idx % W;
    const cz = (idx / W) | 0;

    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d];
      const nz = cz + DZ[d];
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;

      const nIdx = nz * W + nx;
      if (processed[nIdx]) continue;
      processed[nIdx] = 1;

      let nElev = elevation.get(nx, nz);
      if (nElev <= elev) {
        const raised = elev + EPS;
        if (nElev < raised) {
          elevation.set(nx, nz, raised);
          nElev = raised;
        }
      }
      heap.push(nElev, nIdx);
    }
  }
}

/**
 * Compute D8 flow directions for a Grid2D.
 * Returns an Int8Array of size width*height.
 */
export function flowDirections(elevation) {
  const W = elevation.width;
  const H = elevation.height;
  const dirs = new Int8Array(W * H);

  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const elev = elevation.get(gx, gz);
      let bestDir = NO_DIR;
      let bestGrad = 0;

      for (let d = 0; d < 8; d++) {
        const nx = gx + DX[d];
        const nz = gz + DZ[d];
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;

        const drop = elev - elevation.get(nx, nz);
        if (drop <= 0) continue;

        const grad = drop / DIST[d];
        if (grad > bestGrad) {
          bestGrad = grad;
          bestDir = d;
        }
      }

      dirs[gz * W + gx] = bestDir;
    }
  }

  return dirs;
}

/**
 * Compute flow accumulation from elevation and flow directions.
 * Returns a Float32Array of size width*height.
 */
export function flowAccumulation(elevation, directions) {
  const W = elevation.width;
  const H = elevation.height;
  const total = W * H;

  const indices = new Uint32Array(total);
  for (let i = 0; i < total; i++) indices[i] = i;

  const elevations = new Float32Array(total);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      elevations[gz * W + gx] = elevation.get(gx, gz);
    }
  }

  indices.sort((a, b) => elevations[b] - elevations[a]);

  const acc = new Float32Array(total);
  for (let i = 0; i < total; i++) acc[i] = 1;

  for (let k = 0; k < total; k++) {
    const idx = indices[k];
    const dir = directions[idx];
    if (dir === NO_DIR) continue;

    const cx = idx % W;
    const cz = (idx / W) | 0;
    const nx = cx + DX[dir];
    const nz = cz + DZ[dir];
    if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;

    acc[nz * W + nx] += acc[idx];
  }

  return acc;
}

// ─── D-infinity (Tarboton 1997) ─────────────────────────────────────────────
//
// 8 triangular facets, each formed by two adjacent D8 neighbors.
// Facet k uses directions k and (k+1)%8 as its two edges.
//
// Facet 0: E  & SE    (dirs 0,1)
// Facet 1: SE & S     (dirs 1,2)
// Facet 2: S  & SW    (dirs 2,3)
// Facet 3: SW & W     (dirs 3,4)
// Facet 4: W  & NW    (dirs 4,5)
// Facet 5: NW & N     (dirs 5,6)
// Facet 6: N  & NE    (dirs 6,7)
// Facet 7: NE & E     (dirs 7,0)

const PI_OVER_4 = Math.PI / 4;

/**
 * Internal: compute the D-infinity angle and the two facet neighbor directions
 * for a single cell.  Returns { angle, dir1, dir2, singleDir } where angle is
 * the continuous angle (radians, 0 = east, increasing counter-clockwise in D8
 * convention), dir1/dir2 are the two D8 neighbor indices for the best facet,
 * and singleDir is set (instead of dir1/dir2) when only one neighbor is downhill.
 * Returns null if the cell is a pit (no downhill neighbor).
 */
function _dinfCell(elevation, gx, gz) {
  const W = elevation.width;
  const H = elevation.height;
  const e0 = elevation.get(gx, gz);

  let bestSlope = 0;
  let bestAngle = 0;
  let bestD1 = -1;
  let bestD2 = -1;
  let bestSingle = -1;

  for (let f = 0; f < 8; f++) {
    const d1 = f;
    const d2 = (f + 1) % 8;

    const nx1 = gx + DX[d1];
    const nz1 = gz + DZ[d1];
    const nx2 = gx + DX[d2];
    const nz2 = gz + DZ[d2];

    const in1 = nx1 >= 0 && nx1 < W && nz1 >= 0 && nz1 < H;
    const in2 = nx2 >= 0 && nx2 < W && nz2 >= 0 && nz2 < H;

    if (!in1 && !in2) continue;

    const s1 = in1 ? (e0 - elevation.get(nx1, nz1)) / DIST[d1] : -Infinity;
    const s2 = in2 ? (e0 - elevation.get(nx2, nz2)) / DIST[d2] : -Infinity;

    if (s1 <= 0 && s2 <= 0) continue; // both uphill or flat

    let slope, angle, isSingle, singleDir;

    if (s1 > 0 && s2 > 0) {
      // Both neighbors downhill — compute optimal angle within facet
      let r = Math.atan2(s2, s1);
      if (r < 0) r = 0;
      if (r > PI_OVER_4) r = PI_OVER_4;
      slope = Math.sqrt(s1 * s1 + s2 * s2);
      angle = f * PI_OVER_4 + r;
      isSingle = false;
    } else if (s1 > 0) {
      slope = s1;
      angle = f * PI_OVER_4; // exactly at d1
      isSingle = true;
      singleDir = d1;
    } else {
      slope = s2;
      angle = (f + 1) * PI_OVER_4; // exactly at d2
      isSingle = true;
      singleDir = d2;
    }

    if (slope > bestSlope) {
      bestSlope = slope;
      bestAngle = angle;
      if (isSingle) {
        bestD1 = -1;
        bestD2 = -1;
        bestSingle = singleDir;
      } else {
        bestD1 = d1;
        bestD2 = d2;
        bestSingle = -1;
      }
    }
  }

  if (bestSlope <= 0) return null; // pit

  return { angle: bestAngle, dir1: bestD1, dir2: bestD2, singleDir: bestSingle };
}

/**
 * Compute D-infinity flow directions, returned as the nearest D8 direction
 * (Int8Array) for compatibility with downstream code that traces D8 paths.
 *
 * The key improvement over plain D8: on gentle slopes where the true gradient
 * falls between two D8 directions, Dinf picks the direction closest to the
 * true gradient rather than always picking the steepest single-neighbor drop.
 *
 * @param {import('./Grid2D.js').Grid2D} elevation
 * @returns {Int8Array}
 */
export function dinfFlowDirections(elevation) {
  const W = elevation.width;
  const H = elevation.height;
  const dirs = new Int8Array(W * H);

  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const result = _dinfCell(elevation, gx, gz);
      if (!result) {
        dirs[gz * W + gx] = NO_DIR;
        continue;
      }

      if (result.singleDir >= 0) {
        dirs[gz * W + gx] = result.singleDir;
      } else {
        // Convert continuous angle to nearest D8 direction
        let d8 = Math.round(result.angle / PI_OVER_4) % 8;
        dirs[gz * W + gx] = d8;
      }
    }
  }

  return dirs;
}

/**
 * Compute D-infinity flow accumulation.
 *
 * Unlike D8 which sends all flow to a single neighbor, Dinf distributes each
 * cell's flow proportionally to TWO downstream neighbors based on the
 * continuous flow angle within the steepest triangular facet. This eliminates
 * the axis-aligned accumulation artifacts typical of D8.
 *
 * @param {import('./Grid2D.js').Grid2D} elevation
 * @param {Int8Array} _dinfDirsUnused - Kept for API symmetry with D8 flowAccumulation(elevation, directions)
 * @returns {Float32Array}
 */
export function dinfFlowAccumulation(elevation, _dinfDirsUnused) {
  const W = elevation.width;
  const H = elevation.height;
  const total = W * H;

  // Sort cells by elevation, highest first
  const indices = new Uint32Array(total);
  for (let i = 0; i < total; i++) indices[i] = i;

  const elevations = new Float32Array(total);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      elevations[gz * W + gx] = elevation.get(gx, gz);
    }
  }
  indices.sort((a, b) => elevations[b] - elevations[a]);

  // Accumulation starts at 1 for each cell (self)
  const acc = new Float32Array(total);
  for (let i = 0; i < total; i++) acc[i] = 1;

  // Process from highest to lowest, distributing flow proportionally
  for (let k = 0; k < total; k++) {
    const idx = indices[k];
    const gx = idx % W;
    const gz = (idx / W) | 0;

    const result = _dinfCell(elevation, gx, gz);
    if (!result) continue;

    const cellAcc = acc[idx];

    if (result.singleDir >= 0) {
      // Only one downhill neighbor — send all flow there
      const d = result.singleDir;
      const nx = gx + DX[d];
      const nz = gz + DZ[d];
      if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
        acc[nz * W + nx] += cellAcc;
      }
    } else {
      // Two downhill neighbors — distribute proportionally
      const facetStart = result.dir1 * PI_OVER_4;
      const r = result.angle - facetStart; // angle within facet [0, π/4]
      const p2 = r / PI_OVER_4;            // proportion to dir2
      const p1 = 1 - p2;                   // proportion to dir1

      const nx1 = gx + DX[result.dir1];
      const nz1 = gz + DZ[result.dir1];
      const nx2 = gx + DX[result.dir2];
      const nz2 = gz + DZ[result.dir2];

      if (nx1 >= 0 && nx1 < W && nz1 >= 0 && nz1 < H) {
        acc[nz1 * W + nx1] += cellAcc * p1;
      }
      if (nx2 >= 0 && nx2 < W && nz2 >= 0 && nz2 < H) {
        acc[nz2 * W + nx2] += cellAcc * p2;
      }
    }
  }

  return acc;
}

/**
 * Compute slope-scaled stream threshold.
 * Steep terrain (mountains) uses the base threshold so small streams appear.
 * Flat terrain (plains) requires much higher accumulation — only major rivers visible.
 */
function slopeScaledThreshold(maxDrop, baseThreshold) {
  if (maxDrop > 0.15) return baseThreshold;            // steep mountain
  if (maxDrop > 0.08) return baseThreshold * 2.5;      // hills
  if (maxDrop > 0.03) return baseThreshold * 10;       // gentle terrain
  return baseThreshold * 25;                            // flat plains
}

/**
 * Extract stream segments from flow accumulation data.
 */
export function extractStreams(accumulation, directions, elevation, thresholds = { stream: 50, river: 500, majorRiver: 5000 }, seaLevel = 0) {
  const W = elevation.width;
  const H = elevation.height;
  const total = W * H;
  const streamThreshold = thresholds.stream;

  // Two stream masks:
  // - isStream: slope-scaled threshold, determines where streams can ORIGINATE
  // - canFlow: base threshold, determines where an existing stream can CONTINUE
  // This prevents gaps where a stream crosses from steep to flat terrain.
  const isStream = new Uint8Array(total);
  const canFlow = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const gx = i % W;
    const gz = (i / W) | 0;
    const elev = elevation.get(gx, gz);

    // Skip cells below sea level
    if (elev < seaLevel) continue;

    if (accumulation[i] >= streamThreshold) {
      canFlow[i] = 1;

      // Compute max drop to any neighbor (local slope proxy)
      let maxDrop = 0;
      for (let d = 0; d < 8; d++) {
        const nx = gx + DX[d];
        const nz = gz + DZ[d];
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        const drop = (elev - elevation.get(nx, nz)) / DIST[d];
        if (drop > maxDrop) maxDrop = drop;
      }

      const localThreshold = slopeScaledThreshold(maxDrop, streamThreshold);
      if (accumulation[i] >= localThreshold) isStream[i] = 1;
    }
  }

  // Count upstream stream-cell neighbors flowing into each cell
  // Use canFlow (base threshold) so streams aren't broken by flat gaps
  const upstreamCount = new Uint8Array(total);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (!canFlow[idx]) continue;
      const dir = directions[idx];
      if (dir === NO_DIR) continue;
      const nx = gx + DX[dir];
      const nz = gz + DZ[dir];
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
      if (canFlow[nz * W + nx]) upstreamCount[nz * W + nx]++;
    }
  }

  // Find headwaters: cells that pass the slope-scaled threshold
  // with no upstream contributors (where new streams originate)
  const headwaters = [];
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (isStream[idx] && upstreamCount[idx] === 0) {
        headwaters.push({ gx, gz });
      }
    }
  }

  const visited = new Uint8Array(total);
  const segments = [];
  const segmentOf = new Int32Array(total).fill(-1);

  function traceSegment(startGx, startGz) {
    let gx = startGx;
    let gz = startGz;
    const cells = [];

    while (true) {
      const idx = gz * W + gx;
      if (!canFlow[idx] || visited[idx]) break;
      if (upstreamCount[idx] >= 2 && cells.length > 0) break;
      if (elevation.get(gx, gz) < seaLevel) break; // river reached coast

      visited[idx] = 1;
      cells.push({
        gx, gz,
        elevation: elevation.get(gx, gz),
        accumulation: accumulation[idx],
      });

      const dir = directions[idx];
      if (dir === NO_DIR) break;

      const nx = gx + DX[dir];
      const nz = gz + DZ[dir];
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) break;

      gx = nx;
      gz = nz;
    }

    if (cells.length === 0) return;

    const segId = segments.length;
    for (const c of cells) segmentOf[c.gz * W + c.gx] = segId;

    const maxAcc = cells[cells.length - 1].accumulation;
    const rank = maxAcc >= thresholds.majorRiver ? 'majorRiver'
      : maxAcc >= thresholds.river ? 'river' : 'stream';

    const seg = {
      cells,
      flowVolume: maxAcc,
      rank,
      children: [],
      mouth: { gx: cells[cells.length - 1].gx, gz: cells[cells.length - 1].gz },
      _mouthDownstream: null,
    };

    const mouthCell = cells[cells.length - 1];
    const mouthDir = directions[mouthCell.gz * W + mouthCell.gx];
    if (mouthDir !== NO_DIR) {
      const dnx = mouthCell.gx + DX[mouthDir];
      const dnz = mouthCell.gz + DZ[mouthDir];
      if (dnx >= 0 && dnx < W && dnz >= 0 && dnz < H) {
        seg._mouthDownstream = dnz * W + dnx;
      }
    }

    segments.push(seg);
  }

  // Trace from headwaters
  for (const hw of headwaters) traceSegment(hw.gx, hw.gz);

  // Trace confluence-to-confluence segments
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (!canFlow[idx] || visited[idx]) continue;
      if (upstreamCount[idx] >= 2) traceSegment(gx, gz);
    }
  }

  // Assemble tree
  const roots = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dsIdx = seg._mouthDownstream;
    if (dsIdx !== null && segmentOf[dsIdx] >= 0 && segmentOf[dsIdx] !== i) {
      segments[segmentOf[dsIdx]].children.push(seg);
    } else {
      roots.push(seg);
    }
  }

  for (const seg of segments) delete seg._mouthDownstream;

  return roots;
}

/**
 * Find confluence points.
 */
export function findConfluences(accumulation, directions, elevation, threshold = 50) {
  const W = elevation.width;
  const H = elevation.height;
  const total = W * H;

  const incomingStream = new Uint8Array(total);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (accumulation[idx] < threshold) continue;
      const dir = directions[idx];
      if (dir === NO_DIR) continue;
      const nx = gx + DX[dir];
      const nz = gz + DZ[dir];
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
      if (accumulation[nz * W + nx] >= threshold) {
        incomingStream[nz * W + nx]++;
      }
    }
  }

  const results = [];
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (incomingStream[idx] >= 2) {
        results.push({ gx, gz, flowVolume: accumulation[idx], tributaryCount: incomingStream[idx] });
      }
    }
  }

  return results;
}

/**
 * Smooth river paths by adding sinusoidal perpendicular displacement on gentle terrain.
 * Produces natural meanders while leaving steep gorge sections straight.
 *
 * @param {Array} rivers - River segment tree (from extractStreams)
 * @param {import('./Grid2D.js').Grid2D} elevation - Terrain elevation
 * @param {number} width - Grid width
 * @param {number} height - Grid height
 */
/**
 * Smooth river paths with improved meandering.
 *
 * Meander amplitude = halfWidth × 3 (in cells), wavelength = halfWidth × 12.
 * Geology-modulated: soft rock amplifies ×1.5, hard rock dampens ×0.3.
 * Transition from straight to meandering over slope 0.03-0.08.
 *
 * @param {Array} rivers - Segment tree roots
 * @param {Grid2D} elevation
 * @param {number} width
 * @param {number} height
 * @param {Grid2D} [erosionResistance] - Optional rock hardness grid (0-1)
 */
export function smoothRiverPaths(rivers, elevation, width, height, erosionResistance) {
  const occupied = new Set();

  function cellKey(gx, gz) { return gz * width + gx; }

  // Mark all existing river cells as occupied
  function markOccupied(seg) {
    for (const c of seg.cells) occupied.add(cellKey(c.gx, c.gz));
    for (const child of (seg.children || [])) markOccupied(child);
  }
  for (const root of rivers) markOccupied(root);

  function processSegment(seg) {
    const cells = seg.cells;
    if (cells.length < 4) {
      for (const child of (seg.children || [])) processSegment(child);
      return;
    }

    // Meander amplitude and wavelength scale with river width
    const maxAcc = cells[cells.length - 1].accumulation;
    const halfWidth = Math.max(2, Math.min(40, Math.sqrt(maxAcc) / 5));
    // In cells (cellSize=1 at grid level)
    const baseAmplitude = halfWidth * 3 / 50; // approximate cell conversion
    const wavelength = Math.max(6, halfWidth * 12 / 50);
    const maxDisp = Math.max(1.5, Math.min(8, baseAmplitude));

    for (let i = 1; i < cells.length - 1; i++) {
      const prev = cells[i - 1];
      const curr = cells[i];
      const next = cells[i + 1];

      // Compute local slope
      const elevDiff = Math.abs(prev.elevation - next.elevation);
      const dist = Math.sqrt((next.gx - prev.gx) ** 2 + (next.gz - prev.gz) ** 2) || 1;
      const slope = elevDiff / dist;

      // Transition: no meanders above 0.08, full meanders below 0.03
      if (slope > 0.08) continue;
      const slopeFactor = slope < 0.03 ? 1.0 : 1.0 - (slope - 0.03) / 0.05;

      // Geology modulation
      let geoMod = 1.0;
      if (erosionResistance) {
        const resist = erosionResistance.get(curr.gx, curr.gz);
        if (resist > 0.6) geoMod = 0.3;       // hard rock: dampen
        else if (resist < 0.3) geoMod = 1.5;   // soft rock: amplify
      }

      // Flow direction vector
      const dx = next.gx - prev.gx;
      const dz = next.gz - prev.gz;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;

      // Perpendicular direction
      const perpX = -dz / len;
      const perpZ = dx / len;

      // Sinusoidal displacement
      const phase = (i / wavelength) * Math.PI * 2;
      const displacement = Math.sin(phase) * maxDisp * slopeFactor * geoMod;

      const newGx = Math.round(curr.gx + perpX * displacement);
      const newGz = Math.round(curr.gz + perpZ * displacement);

      // Bounds check
      if (newGx < 0 || newGx >= width || newGz < 0 || newGz >= height) continue;

      // Skip if target cell already occupied by another segment
      const key = cellKey(newGx, newGz);
      if (occupied.has(key) && (newGx !== curr.gx || newGz !== curr.gz)) continue;

      // Update occupied tracking
      occupied.delete(cellKey(curr.gx, curr.gz));
      occupied.add(key);

      curr.gx = newGx;
      curr.gz = newGz;
      curr.elevation = elevation.get(newGx, newGz);
    }

    // Enforce monotonically decreasing elevation after displacement
    for (let i = 1; i < cells.length; i++) {
      if (cells[i].elevation > cells[i - 1].elevation) {
        cells[i].elevation = cells[i - 1].elevation - 0.01;
      }
    }

    for (const child of (seg.children || [])) processSegment(child);
  }

  for (const root of rivers) processSegment(root);
}
