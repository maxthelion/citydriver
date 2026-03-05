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
  return { data: new Uint8Array(w * h), width: w, height: h, res: RES };
}

/**
 * Stamp a road edge's polyline corridor onto the occupancy grid.
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

    // Sample the occupancy cell at the target position
    const wx = toGx * cs, wz = toGz * cs;
    const ax = Math.floor(wx / res), az = Math.floor(wz / res);
    if (ax >= 0 && ax < occupancy.width && az >= 0 && az < occupancy.height) {
      const val = data[az * aw + ax];
      if (val === OCCUPANCY_ROAD || val === OCCUPANCY_JUNCTION) {
        c *= 0.15;
      } else if (val === OCCUPANCY_PLOT) {
        c *= 5;
      }
    }
    return c;
  };
}

// --- Internal grid-stamp helpers ---

/** Stamp a polygon onto the grid using scanline fill. */
export function stampPolyOnGrid(verts, occupancy, value) {
  if (verts.length < 3) return;
  const { data, width: aw, height: ah, res } = occupancy;
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
  const { data, width: aw, height: ah, res } = occupancy;
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
      }
    }
  }
}
