/**
 * D8 flow routing and drainage network extraction.
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
