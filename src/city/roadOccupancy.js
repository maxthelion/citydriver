/**
 * Shared road occupancy grid utilities.
 *
 * A persistent 3m-resolution grid marking cells as:
 *   0 = empty
 *   1 = road corridor
 *   2 = plot
 *   3 = junction clearing
 *
 * All road-adding stages read from and stamp onto this grid to prevent
 * overlapping roads and route around plots.
 *
 * When derived grids are attached (via attachGrids), stamping
 * incrementally updates buildability (zeroed) and bridgeGrid (marked
 * where roads cross water) — no expensive full recompute needed.
 */

const RES = 3; // metres per occupancy cell

// Cell values
export const OCCUPANCY_EMPTY = 0;
export const OCCUPANCY_ROAD = 1;
export const OCCUPANCY_PLOT = 2;
export const OCCUPANCY_JUNCTION = 3;

/**
 * Create a new occupancy grid sized for the city.
 * @param {object} params - city params with width, height, cellSize
 * @returns {{ data: Uint8Array, width: number, height: number, res: number }}
 */
export function createOccupancyGrid(params) {
  const w = Math.ceil((params.width * params.cellSize) / RES);
  const h = Math.ceil((params.height * params.cellSize) / RES);
  return { data: new Uint8Array(w * h), width: w, height: h, res: RES, buildability: null, cityCS: params.cellSize };
}

/**
 * Attach derived grids so stamp operations incrementally update them.
 * Call after computeBuildability() and identifyRiverCrossings().
 *
 * @param {object} occupancy
 * @param {object} grids
 * @param {import('../core/Grid2D.js').Grid2D} grids.buildability
 * @param {import('../core/Grid2D.js').Grid2D} [grids.bridgeGrid]
 * @param {import('../core/Grid2D.js').Grid2D} [grids.waterMask]
 * @param {Array} [grids.bridges] - mutable array to append new bridges to
 */
export function attachGrids(occupancy, grids) {
  occupancy.buildability = grids.buildability;
  occupancy.bridgeGrid = grids.bridgeGrid || null;
  occupancy.waterMask = grids.waterMask || null;
  occupancy.bridges = grids.bridges || null;
}

/**
 * Stamp a road edge's polyline corridor onto the occupancy grid.
 * Also detects water crossings and incrementally updates bridgeGrid.
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {number} edgeId
 * @param {object} occupancy - { data, width, height, res }
 */
export function stampEdge(graph, edgeId, occupancy) {
  const edge = graph.getEdge(edgeId);
  if (!edge) return;
  const polyline = graph.edgePolyline(edgeId);
  const halfW = ((edge.width || 12) / 2) + 2;
  stampPolylineOnGrid(polyline, halfW, occupancy, OCCUPANCY_ROAD);

  // Detect water crossings and mark bridgeGrid
  if (occupancy.bridgeGrid && occupancy.waterMask) {
    detectBridgeCells(polyline, occupancy);
  }
}

/**
 * Stamp a junction clearing circle onto the occupancy grid.
 */
export function stampJunction(x, z, radius, occupancy) {
  stampCircleOnGrid(x, z, radius, occupancy, OCCUPANCY_JUNCTION);
}

/**
 * Stamp a plot polygon onto the occupancy grid.
 */
export function stampPlot(vertices, occupancy) {
  stampPolyOnGrid(vertices, occupancy, OCCUPANCY_PLOT);
}

/**
 * Wrap a base cost function with occupancy awareness.
 * - Road cells: 0.15x cost (reuse discount)
 * - Plot cells: 5x cost (avoid)
 * @param {Function} baseCost - (fromGx, fromGz, toGx, toGz) => number
 * @param {object} occupancy - { data, width, height, res }
 * @param {number} cs - city cellSize
 * @returns {Function}
 */
export function wrapCostWithOccupancy(baseCost, occupancy, cs) {
  const { data, width: aw, res } = occupancy;
  return (fromGx, fromGz, toGx, toGz) => {
    let c = baseCost(fromGx, fromGz, toGx, toGz);
    if (!isFinite(c)) return c;

    // Scan all occupancy cells within this city cell (10m → 3m resolution)
    const axMin = Math.floor((toGx * cs) / res);
    const axMax = Math.min(aw - 1, Math.floor(((toGx + 1) * cs - 1) / res));
    const azMin = Math.floor((toGz * cs) / res);
    const azMax = Math.min(occupancy.height - 1, Math.floor(((toGz + 1) * cs - 1) / res));
    let hasRoad = false, hasPlot = false;
    for (let az = azMin; az <= azMax && !hasRoad; az++) {
      for (let ax = axMin; ax <= axMax && !hasRoad; ax++) {
        if (ax < 0 || az < 0) continue;
        const val = data[az * aw + ax];
        if (val === OCCUPANCY_ROAD || val === OCCUPANCY_JUNCTION) hasRoad = true;
        else if (val === OCCUPANCY_PLOT) hasPlot = true;
      }
    }
    if (hasRoad) c *= 0.15;
    else if (hasPlot) c *= 5;
    return c;
  };
}

// --- Internal grid-stamp helpers ---

/** Stamp a polygon onto the grid using scanline fill. */
export function stampPolyOnGrid(verts, occupancy, value) {
  if (verts.length < 3) return;
  const { data, width: aw, height: ah, res, buildability, cityCS } = occupancy;
  const xs = verts.map(v => v.x);
  const zs = verts.map(v => v.z);
  const minAx = Math.max(0, Math.floor(Math.min(...xs) / res));
  const maxAx = Math.min(aw - 1, Math.ceil(Math.max(...xs) / res));
  const minAz = Math.max(0, Math.floor(Math.min(...zs) / res));
  const maxAz = Math.min(ah - 1, Math.ceil(Math.max(...zs) / res));

  for (let az = minAz; az <= maxAz; az++) {
    const wz = az * res;
    const intersections = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if ((a.z <= wz && b.z > wz) || (b.z <= wz && a.z > wz)) {
        const t = (wz - a.z) / (b.z - a.z);
        intersections.push(a.x + t * (b.x - a.x));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(minAx, Math.ceil(intersections[i] / res));
      const xEnd = Math.min(maxAx, Math.floor(intersections[i + 1] / res));
      for (let ax = xStart; ax <= xEnd; ax++) {
        data[az * aw + ax] = value;
        // Incrementally zero buildability for this cell
        if (buildability) {
          const bgx = Math.floor((ax * res) / cityCS);
          const bgz = Math.floor((az * res) / cityCS);
          if (bgx >= 0 && bgx < buildability.width && bgz >= 0 && bgz < buildability.height) {
            buildability.set(bgx, bgz, 0);
          }
        }
      }
    }
  }
}

/** Stamp a polyline corridor (line with half-width) onto the grid. */
export function stampPolylineOnGrid(polyline, halfWidth, occupancy, value) {
  for (let i = 0; i < polyline.length - 1; i++) {
    const p0 = polyline[i], p1 = polyline[i + 1];
    const dx = p1.x - p0.x, dz = p1.z - p0.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.1) continue;
    const nx = -dz / len, nz = dx / len;
    const verts = [
      { x: p0.x + nx * halfWidth, z: p0.z + nz * halfWidth },
      { x: p1.x + nx * halfWidth, z: p1.z + nz * halfWidth },
      { x: p1.x - nx * halfWidth, z: p1.z - nz * halfWidth },
      { x: p0.x - nx * halfWidth, z: p0.z - nz * halfWidth },
    ];
    stampPolyOnGrid(verts, occupancy, value);
  }
}

/** Stamp a circle onto the grid. */
export function stampCircleOnGrid(cx, cz, radius, occupancy, value) {
  const { data, width: aw, height: ah, res, buildability, cityCS } = occupancy;
  const minAx = Math.max(0, Math.floor((cx - radius) / res));
  const maxAx = Math.min(aw - 1, Math.ceil((cx + radius) / res));
  const minAz = Math.max(0, Math.floor((cz - radius) / res));
  const maxAz = Math.min(ah - 1, Math.ceil((cz + radius) / res));
  const r2 = radius * radius;

  for (let az = minAz; az <= maxAz; az++) {
    for (let ax = minAx; ax <= maxAx; ax++) {
      const dx = ax * res - cx, dz = az * res - cz;
      if (dx * dx + dz * dz <= r2) {
        data[az * aw + ax] = value;
        if (buildability) {
          const bgx = Math.floor((ax * res) / cityCS);
          const bgz = Math.floor((az * res) / cityCS);
          if (bgx >= 0 && bgx < buildability.width && bgz >= 0 && bgz < buildability.height) {
            buildability.set(bgx, bgz, 0);
          }
        }
      }
    }
  }
}

/**
 * Rasterize a road polyline into grid cells (Bresenham between vertices),
 * detect water crossings, and mark bridgeGrid cells.
 * Also appends bridge records for debug rendering.
 */
function detectBridgeCells(polyline, occupancy) {
  const { bridgeGrid, waterMask, bridges, cityCS } = occupancy;
  const w = bridgeGrid.width;
  const h = bridgeGrid.height;

  // Rasterize polyline into grid cells via Bresenham
  const cells = rasterizePolylineToGrid(polyline, cityCS, w, h);

  let inWater = false;
  let seenLand = false;
  let entryGx = 0, entryGz = 0;
  let lastLandGx = 0, lastLandGz = 0;

  for (let i = 0; i < cells.length; i++) {
    const { gx, gz } = cells[i];
    const isWater = waterMask.get(gx, gz) > 0;

    if (!inWater && isWater) {
      inWater = true;
      entryGx = lastLandGx;
      entryGz = lastLandGz;
    } else if (inWater && !isWater) {
      inWater = false;
      // Only create bridge if we had a valid land cell before entering water
      if (seenLand) {
        markBridgeLine(bridgeGrid, entryGx, entryGz, gx, gz, w, h);
        if (bridges) {
          const dx = gx - entryGx, dz = gz - entryGz;
          const bWidth = Math.round(Math.sqrt(dx * dx + dz * dz));
          if (bWidth >= 1 && bWidth <= 25) {
            bridges.push({
              startGx: entryGx, startGz: entryGz,
              endGx: gx, endGz: gz,
              gx: Math.round((entryGx + gx) / 2),
              gz: Math.round((entryGz + gz) / 2),
              x: Math.round((entryGx + gx) / 2) * cityCS,
              z: Math.round((entryGz + gz) / 2) * cityCS,
              width: bWidth,
              heading: Math.atan2(dx, dz),
              importance: 0.4,
            });
          }
        }
      }
    }

    if (!isWater) {
      lastLandGx = gx;
      lastLandGz = gz;
      seenLand = true;
    } else {
      // Mark water cells under road as bridge-passable
      bridgeGrid.set(gx, gz, 1);
    }
  }
}

/**
 * Rasterize a world-coord polyline into unique grid cells via Bresenham.
 */
function rasterizePolylineToGrid(polyline, cs, w, h) {
  const cells = [];
  const seen = new Set();

  for (let i = 0; i < polyline.length - 1; i++) {
    const x0 = Math.round(polyline[i].x / cs);
    const z0 = Math.round(polyline[i].z / cs);
    const x1 = Math.round(polyline[i + 1].x / cs);
    const z1 = Math.round(polyline[i + 1].z / cs);

    let gx = x0, gz = z0;
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;

    while (true) {
      if (gx >= 0 && gx < w && gz >= 0 && gz < h) {
        const key = gz * w + gx;
        if (!seen.has(key)) {
          seen.add(key);
          cells.push({ gx, gz });
        }
      }
      if (gx === x1 && gz === z1) break;
      const e2 = 2 * err;
      if (e2 > -dz) { err -= dz; gx += sx; }
      if (e2 < dx) { err += dx; gz += sz; }
    }
  }

  return cells;
}

/**
 * Mark cells along a bridge line (Bresenham) plus 1-cell margin.
 */
function markBridgeLine(bridgeGrid, x0, z0, x1, z1, w, h) {
  const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
  let gx = x0, gz = z0, err = dx - dz;

  while (true) {
    // Mark cell and 1-cell margin
    for (let ddz = -1; ddz <= 1; ddz++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        const nx = gx + ddx, nz = gz + ddz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
          bridgeGrid.set(nx, nz, 1);
        }
      }
    }
    if (gx === x1 && gz === z1) break;
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; gx += sx; }
    if (e2 < dx) { err += dx; gz += sz; }
  }
}
