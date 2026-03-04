/**
 * Flow accumulation and drainage network extraction.
 *
 * Standard GIS hydrological algorithms that derive a river network from a
 * heightmap.  Pipeline:
 *   1. fillSinks()        — remove depressions so water always reaches an edge
 *   2. flowDirections()   — D8 steepest-descent direction for every cell
 *   3. flowAccumulation() — count upstream contributing cells
 *   4. extractStreams()    — trace stream segments into a drainage tree
 *
 * Depends on a Heightmap with: .width, .height, .get(gx,gz), .set(gx,gz,v)
 */

// ---------------------------------------------------------------------------
// Direction encoding (D8)
//   0=E  1=SE  2=S  3=SW  4=W  5=NW  6=N  7=NE
// ---------------------------------------------------------------------------
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1];
const DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

// Sentinel for cells that drain off the edge (or have no downhill neighbor).
const NO_DIR = -1;

// ---------------------------------------------------------------------------
// MinHeap — lightweight priority queue keyed by a numeric priority.
// ---------------------------------------------------------------------------
class MinHeap {
  constructor() {
    this._data = [];  // [{priority, value}]
  }

  get size() {
    return this._data.length;
  }

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

// ---------------------------------------------------------------------------
// fillSinks
// ---------------------------------------------------------------------------

/**
 * Fill sinks (depressions) in the heightmap so water can always flow to an
 * edge.  Uses a priority-flood algorithm (variant of Planchon-Darboux).
 * Modifies heightmap in place.  Only raises cells, never lowers them.
 * Edge cells are never modified (they drain off-map).
 */
export function fillSinks(heightmap) {
  const W = heightmap.width;
  const H = heightmap.height;
  const total = W * H;

  // Tiny increment added when raising cells so that filled flats have a
  // slight gradient toward their pour point.  This lets D8 route flow
  // across filled areas without needing a separate flat-resolution pass.
  // We use the smallest float32 increment that is reliably distinguishable
  // at typical terrain elevations (order 1-100).
  const EPS = 1e-5;

  const processed = new Uint8Array(total);
  const heap = new MinHeap();

  // Seed the heap with all edge cells.
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      if (gx === 0 || gx === W - 1 || gz === 0 || gz === H - 1) {
        const idx = gz * W + gx;
        processed[idx] = 1;
        heap.push(heightmap.get(gx, gz), idx);
      }
    }
  }

  // Process cells lowest-first.
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

      let nElev = heightmap.get(nx, nz);
      if (nElev <= elev) {
        // Raise the neighbor so it can drain through us.
        // Add EPS to avoid perfect flats in the filled region.
        const raised = elev + EPS;
        if (nElev < raised) {
          heightmap.set(nx, nz, raised);
          nElev = raised;
        }
      }
      heap.push(nElev, nIdx);
    }
  }
}

// ---------------------------------------------------------------------------
// flowDirections
// ---------------------------------------------------------------------------

/**
 * Compute D8 flow direction for each cell.
 * Each cell flows to its lowest neighbor (steepest downhill gradient).
 * Edge cells that have no lower neighbor flow off-map (direction = -1).
 *
 * Returns a flat Int8Array of size width*height.
 * Values 0-7 encode direction per the D8 convention; -1 = off-edge / flat.
 *
 * IMPORTANT: call fillSinks first, otherwise interior cells may have no
 * valid flow direction.
 */
export function flowDirections(heightmap) {
  const W = heightmap.width;
  const H = heightmap.height;
  const dirs = new Int8Array(W * H);

  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const elev = heightmap.get(gx, gz);
      let bestDir = NO_DIR;
      let bestGrad = 0; // steepest gradient seen so far

      for (let d = 0; d < 8; d++) {
        const nx = gx + DX[d];
        const nz = gz + DZ[d];
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;

        const nElev = heightmap.get(nx, nz);
        const drop = elev - nElev;
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

// ---------------------------------------------------------------------------
// flowAccumulation
// ---------------------------------------------------------------------------

/**
 * Compute flow accumulation: for each cell, count how many upstream cells
 * drain through it (including itself).
 *
 * Uses a topological sort by elevation (highest first).  Each cell's
 * accumulation is passed downstream.
 *
 * Returns a Float32Array of size width*height.  Minimum value is 1.
 */
export function flowAccumulation(heightmap, directions) {
  const W = heightmap.width;
  const H = heightmap.height;
  const total = W * H;

  // Build an array of indices sorted by elevation (highest first).
  const indices = new Uint32Array(total);
  for (let i = 0; i < total; i++) indices[i] = i;

  // Extract elevations into a contiguous array for fast sorting.
  const elevations = new Float32Array(total);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      elevations[gz * W + gx] = heightmap.get(gx, gz);
    }
  }

  indices.sort((a, b) => elevations[b] - elevations[a]);

  // Initialize every cell's accumulation to 1 (itself).
  const acc = new Float32Array(total);
  for (let i = 0; i < total; i++) acc[i] = 1;

  // Process highest first — push accumulation downstream.
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

// ---------------------------------------------------------------------------
// extractStreams
// ---------------------------------------------------------------------------

/**
 * Extract stream/river network from flow accumulation data.
 *
 * @param {Float32Array} accumulation — from flowAccumulation()
 * @param {Int8Array} directions — from flowDirections()
 * @param {object} heightmap — heightmap with get(gx,gz)
 * @param {object} thresholds — { stream, river, majorRiver } cell counts
 * @param {number} [seaLevel=-Infinity] — sea level for headwater filtering
 * @returns {object[]} Array of root DrainageNode objects (one per outlet).
 */
export function extractStreams(accumulation, directions, heightmap, thresholds = { stream: 50, river: 500, majorRiver: 5000 }, seaLevel = -Infinity) {
  const W = heightmap.width;
  const H = heightmap.height;
  const total = W * H;
  const streamThreshold = thresholds.stream;

  // ---- 1. Identify stream cells ----
  const isStream = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (accumulation[i] >= streamThreshold) isStream[i] = 1;
  }

  // ---- 2. Count how many upstream stream-cell neighbors flow INTO each cell ----
  const upstreamStreamCount = new Uint8Array(total);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (!isStream[idx]) continue;
      const dir = directions[idx];
      if (dir === NO_DIR) continue;
      const nx = gx + DX[dir];
      const nz = gz + DZ[dir];
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
      const nIdx = nz * W + nx;
      if (isStream[nIdx]) {
        upstreamStreamCount[nIdx]++;
      }
    }
  }

  // ---- 3. Identify headwater cells ----
  // A headwater is a stream cell with zero upstream stream-cell contributors.
  const rawHeadwaters = [];
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (isStream[idx] && upstreamStreamCount[idx] === 0) {
        rawHeadwaters.push({ gx, gz });
      }
    }
  }

  // Filter headwaters: only keep those at plausible source locations.
  // A headwater is valid if it satisfies at least one of:
  //   1. Elevation ≥ 50th percentile of the heightmap
  //   2. Within 1 cell of the map edge
  //   3. Adjacent (±1) to a cell below seaLevel
  // Build elevation array from heightmap (works with both real Heightmap and test mocks)
  let data = heightmap._data;
  if (!data) {
    data = new Float32Array(total);
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        data[gz * W + gx] = heightmap.get(gx, gz);
      }
    }
  }
  const sorted = Float32Array.from(data).sort();
  const medianElev = sorted[Math.floor(sorted.length / 2)];

  const headwaters = rawHeadwaters.filter(({ gx, gz }) => {
    // Condition 1: high elevation
    if (heightmap.get(gx, gz) >= medianElev) return true;

    // Condition 2: near map edge
    if (gx <= 1 || gx >= W - 2 || gz <= 1 || gz >= H - 2) return true;

    // Condition 3: adjacent to a cell below seaLevel
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = gx + dx;
        const nz = gz + dz;
        if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
          if (heightmap.get(nx, nz) < seaLevel) return true;
        }
      }
    }

    return false;
  });

  // ---- 4. Trace from each headwater downstream, building segments ----
  // A segment ends when:
  //   - we reach a confluence (a cell that has 2+ upstream stream neighbors), OR
  //   - we step off the stream network / reach edge / hit -1 direction
  //
  // We build segments in a first pass, then assemble into a tree.

  // Map from cell index to the segment that *ends* at that cell's mouth.
  // Multiple segments may share a mouth (confluence).  We track which
  // segments feed into a given cell so we can parent them later.

  const segmentOf = new Int32Array(total).fill(-1); // cell -> segment id that OWNS this cell
  const segments = []; // [{cells, mouthIdx, rank, flowVolume}]

  // To build the tree we need to know, for each confluence cell, which
  // segments flow INTO it.  We'll record that after tracing.

  const visited = new Uint8Array(total);

  for (const hw of headwaters) {
    let gx = hw.gx;
    let gz = hw.gz;
    let cells = [];

    while (true) {
      const idx = gz * W + gx;
      if (!isStream[idx]) break; // left the stream network
      if (visited[idx]) break;   // already part of another trace

      // If this cell is a confluence AND we already have cells in this
      // segment, end the current segment before this cell (the confluence
      // will be the start of a new segment assembled later).
      if (upstreamStreamCount[idx] >= 2 && cells.length > 0) {
        break;
      }

      visited[idx] = 1;
      cells.push({
        gx, gz,
        elevation: heightmap.get(gx, gz),
        accumulation: accumulation[idx],
      });

      segmentOf[idx] = segments.length; // preliminary; fixed after push

      const dir = directions[idx];
      if (dir === NO_DIR) break;

      const nx = gx + DX[dir];
      const nz = gz + DZ[dir];
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) break;

      gx = nx;
      gz = nz;
    }

    if (cells.length === 0) continue;

    const segId = segments.length;
    for (const c of cells) segmentOf[c.gz * W + c.gx] = segId;

    const maxAcc = cells[cells.length - 1].accumulation;
    const rank = maxAcc >= thresholds.majorRiver ? 'majorRiver'
      : maxAcc >= thresholds.river ? 'river'
        : 'stream';

    segments.push({
      cells,
      flowVolume: maxAcc,
      rank,
      children: [],
      mouth: { gx: cells[cells.length - 1].gx, gz: cells[cells.length - 1].gz },
      _mouthDownstream: null, // index of the cell our mouth flows into
    });

    // Determine the downstream cell from our mouth.
    const mouthCell = cells[cells.length - 1];
    const mouthDir = directions[mouthCell.gz * W + mouthCell.gx];
    if (mouthDir !== NO_DIR) {
      const dnx = mouthCell.gx + DX[mouthDir];
      const dnz = mouthCell.gz + DZ[mouthDir];
      if (dnx >= 0 && dnx < W && dnz >= 0 && dnz < H) {
        segments[segId]._mouthDownstream = dnz * W + dnx;
      }
    }
  }

  // ---- 5. Now trace confluence-to-confluence (or confluence-to-outlet) segments ----
  // Confluences are stream cells with upstreamStreamCount >= 2 that haven't
  // been fully traced yet.
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (!isStream[idx] || visited[idx]) continue;
      if (upstreamStreamCount[idx] < 2) continue;

      // Start a new segment at this confluence.
      let cx = gx;
      let cz = gz;
      let cells = [];

      while (true) {
        const cIdx = cz * W + cx;
        if (!isStream[cIdx]) break;
        if (visited[cIdx]) break;
        if (upstreamStreamCount[cIdx] >= 2 && cells.length > 0) break;

        visited[cIdx] = 1;
        cells.push({
          gx: cx, gz: cz,
          elevation: heightmap.get(cx, cz),
          accumulation: accumulation[cIdx],
        });

        const dir = directions[cIdx];
        if (dir === NO_DIR) break;
        const nx = cx + DX[dir];
        const nz = cz + DZ[dir];
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) break;
        cx = nx;
        cz = nz;
      }

      if (cells.length === 0) continue;

      const segId = segments.length;
      for (const c of cells) segmentOf[c.gz * W + c.gx] = segId;

      const maxAcc = cells[cells.length - 1].accumulation;
      const rank = maxAcc >= thresholds.majorRiver ? 'majorRiver'
        : maxAcc >= thresholds.river ? 'river'
          : 'stream';

      segments.push({
        cells,
        flowVolume: maxAcc,
        rank,
        children: [],
        mouth: { gx: cells[cells.length - 1].gx, gz: cells[cells.length - 1].gz },
        _mouthDownstream: null,
      });

      const mouthCell = cells[cells.length - 1];
      const mouthDir = directions[mouthCell.gz * W + mouthCell.gx];
      if (mouthDir !== NO_DIR) {
        const dnx = mouthCell.gx + DX[mouthDir];
        const dnz = mouthCell.gz + DZ[mouthDir];
        if (dnx >= 0 && dnx < W && dnz >= 0 && dnz < H) {
          segments[segId]._mouthDownstream = dnz * W + dnx;
        }
      }
    }
  }

  // ---- 6. Assemble tree: connect child segments to parent segments ----
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

  // Clean up internal bookkeeping properties.
  for (const seg of segments) {
    delete seg._mouthDownstream;
  }

  return roots;
}

// ---------------------------------------------------------------------------
// findConfluences
// ---------------------------------------------------------------------------

/**
 * Find confluences — points where two or more significant streams meet.
 * These are prime settlement locations.
 *
 * @param {Float32Array} accumulation
 * @param {Int8Array} directions
 * @param {object} heightmap
 * @param {number} threshold — minimum accumulation for a stream cell
 * @returns {object[]} Array of {gx, gz, flowVolume, tributaryCount}
 */
export function findConfluences(accumulation, directions, heightmap, threshold = 50) {
  const W = heightmap.width;
  const H = heightmap.height;
  const total = W * H;

  // For each cell, count how many stream-cell neighbors flow INTO it.
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
      const nIdx = nz * W + nx;
      if (accumulation[nIdx] >= threshold) {
        incomingStream[nIdx]++;
      }
    }
  }

  const results = [];
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (incomingStream[idx] >= 2) {
        results.push({
          gx, gz,
          flowVolume: accumulation[idx],
          tributaryCount: incomingStream[idx],
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// findNarrowCrossings
// ---------------------------------------------------------------------------

/**
 * Find the narrowest river crossing points for a given stream.
 * Looks for where the river valley is narrowest (terrain rises steeply
 * on both sides perpendicular to the flow direction).
 *
 * @param {object[]} streamCells — array of {gx, gz} along a stream
 * @param {object} heightmap
 * @returns {object[]} [{gx, gz, valleyWidth}] sorted by valleyWidth ascending
 */
export function findNarrowCrossings(streamCells, heightmap) {
  if (streamCells.length < 3) return [];

  const W = heightmap.width;
  const H = heightmap.height;
  const results = [];

  for (let i = 1; i < streamCells.length - 1; i++) {
    const prev = streamCells[i - 1];
    const curr = streamCells[i];
    const next = streamCells[i + 1];

    // Flow direction vector
    const fdx = next.gx - prev.gx;
    const fdz = next.gz - prev.gz;
    const fLen = Math.sqrt(fdx * fdx + fdz * fdz);
    if (fLen === 0) continue;

    // Perpendicular direction (rotate 90 degrees)
    const pdx = -fdz / fLen;
    const pdz = fdx / fLen;

    const baseElev = heightmap.get(curr.gx, curr.gz);

    // Walk perpendicular in both directions until terrain rises significantly
    // or we hit the edge.  "Valley" width is the distance between the two
    // points where the terrain first rises by >= riseThreshold above the
    // stream bed.
    const riseThreshold = 2.0; // elevation units above stream bed
    const maxProbe = 20;       // max cells to probe in each direction

    let leftDist = maxProbe;
    let rightDist = maxProbe;

    for (let step = 1; step <= maxProbe; step++) {
      const sx = Math.round(curr.gx + pdx * step);
      const sz = Math.round(curr.gz + pdz * step);
      if (sx < 0 || sx >= W || sz < 0 || sz >= H) { leftDist = step; break; }
      if (heightmap.get(sx, sz) - baseElev >= riseThreshold) { leftDist = step; break; }
    }

    for (let step = 1; step <= maxProbe; step++) {
      const sx = Math.round(curr.gx - pdx * step);
      const sz = Math.round(curr.gz - pdz * step);
      if (sx < 0 || sx >= W || sz < 0 || sz >= H) { rightDist = step; break; }
      if (heightmap.get(sx, sz) - baseElev >= riseThreshold) { rightDist = step; break; }
    }

    const valleyWidth = leftDist + rightDist;
    results.push({ gx: curr.gx, gz: curr.gz, valleyWidth });
  }

  results.sort((a, b) => a.valleyWidth - b.valleyWidth);
  return results;
}
