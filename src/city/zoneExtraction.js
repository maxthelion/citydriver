import { Grid2D } from '../core/Grid2D.js';
import { ZONE_SLOPE_BASE, ZONE_SLOPE_LV_BONUS } from './constants.js';

// Zone extraction thresholds
const ZONE_LV_THRESHOLD = 0.3;
const ZONE_BUILD_THRESHOLD = 0.2;
const ZONE_MORPH_RADIUS_M = 10;     // 2 cells at 5m
const ZONE_MIN_SIZE = 30;            // cells (~750m² at 5m)

function effectiveSlopeMax(landValue) {
  return ZONE_SLOPE_BASE + landValue * ZONE_SLOPE_LV_BONUS;
}

/**
 * Morphological close (dilate then erode) on a binary grid.
 * Fills holes up to ~2*radius cells across without expanding the outer boundary.
 *
 * @param {Grid2D} mask - Binary grid (0 or 1)
 * @param {number} radius - Dilation/erosion radius in cells
 * @returns {Grid2D} New closed mask
 */
export function morphClose(mask, radius) {
  const { width, height } = mask;

  // Dilate: cell is 1 if any cell within radius is 1
  const dilated = new Grid2D(width, height, { type: 'uint8' });
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (mask.get(gx, gz) > 0) { dilated.set(gx, gz, 1); continue; }
      let found = false;
      const x0 = Math.max(0, gx - radius), x1 = Math.min(width - 1, gx + radius);
      const z0 = Math.max(0, gz - radius), z1 = Math.min(height - 1, gz + radius);
      for (let zz = z0; zz <= z1 && !found; zz++) {
        for (let xx = x0; xx <= x1 && !found; xx++) {
          if (mask.get(xx, zz) > 0) found = true;
        }
      }
      if (found) dilated.set(gx, gz, 1);
    }
  }

  // Erode: cell is 1 only if all cells within radius are 1
  const eroded = new Grid2D(width, height, { type: 'uint8' });
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (dilated.get(gx, gz) === 0) continue;
      let allSet = true;
      const x0 = Math.max(0, gx - radius), x1 = Math.min(width - 1, gx + radius);
      const z0 = Math.max(0, gz - radius), z1 = Math.min(height - 1, gz + radius);
      for (let zz = z0; zz <= z1 && allSet; zz++) {
        for (let xx = x0; xx <= x1 && allSet; xx++) {
          if (dilated.get(xx, zz) === 0) allSet = false;
        }
      }
      if (allSet) eroded.set(gx, gz, 1);
    }
  }

  return eroded;
}

/**
 * Flood-fill connected components on a binary mask.
 * Returns array of zones, each with cells list and centroid.
 *
 * @param {Grid2D} mask - Binary grid
 * @param {number} minSize - Minimum zone size in cells
 * @returns {Array<{id: number, cells: Array<{gx: number, gz: number}>, centroidGx: number, centroidGz: number}>}
 */
export function floodFillZones(mask, minSize) {
  const { width, height } = mask;
  const visited = new Grid2D(width, height, { type: 'uint8' });
  const zones = [];
  let nextId = 1;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (mask.get(gx, gz) === 0 || visited.get(gx, gz) > 0) continue;

      // BFS flood fill
      const cells = [];
      const queue = [{ gx, gz }];
      visited.set(gx, gz, 1);

      while (queue.length > 0) {
        const cell = queue.shift();
        cells.push(cell);

        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cell.gx + dx, nz = cell.gz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
          if (visited.get(nx, nz) > 0 || mask.get(nx, nz) === 0) continue;
          visited.set(nx, nz, 1);
          queue.push({ gx: nx, gz: nz });
        }
      }

      if (cells.length < minSize) continue;

      let sumGx = 0, sumGz = 0;
      for (const c of cells) { sumGx += c.gx; sumGz += c.gz; }

      zones.push({
        id: nextId++,
        cells,
        centroidGx: sumGx / cells.length,
        centroidGz: sumGz / cells.length,
      });
    }
  }

  return zones;
}

/**
 * Extract the outer boundary of a zone's cells as a world-coordinate polygon.
 * Uses cell-edge tracing: walks the boundary cells and emits vertices at cell corners.
 * Simplifies with Douglas-Peucker.
 *
 * @param {Array<{gx: number, gz: number}>} cells
 * @param {number} cellSize
 * @param {number} originX - World X origin of grid
 * @param {number} originZ - World Z origin of grid
 * @returns {Array<{x: number, z: number}>} Closed polygon in world coordinates
 */
export function extractZoneBoundary(cells, cellSize, originX, originZ) {
  const cellSet = new Set();
  for (const c of cells) cellSet.add(`${c.gx},${c.gz}`);

  // Find boundary edges: cell edges where one side is in the zone and the other isn't
  const edges = [];

  for (const c of cells) {
    const { gx, gz } = c;
    if (!cellSet.has(`${gx},${gz - 1}`)) {
      edges.push({ x1: gx, z1: gz, x2: gx + 1, z2: gz });
    }
    if (!cellSet.has(`${gx},${gz + 1}`)) {
      edges.push({ x1: gx + 1, z1: gz + 1, x2: gx, z2: gz + 1 });
    }
    if (!cellSet.has(`${gx - 1},${gz}`)) {
      edges.push({ x1: gx, z1: gz + 1, x2: gx, z2: gz });
    }
    if (!cellSet.has(`${gx + 1},${gz}`)) {
      edges.push({ x1: gx + 1, z1: gz, x2: gx + 1, z2: gz + 1 });
    }
  }

  if (edges.length === 0) return [];

  // Chain edges into a polygon by matching endpoints
  const edgeMap = new Map();
  for (const e of edges) {
    const key = `${e.x1},${e.z1}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push(e);
  }

  const polygon = [];
  const startEdge = edges[0];
  let cx = startEdge.x1, cz = startEdge.z1;
  const used = new Set();

  for (let i = 0; i < edges.length; i++) {
    polygon.push({
      x: originX + cx * cellSize,
      z: originZ + cz * cellSize,
    });

    const key = `${cx},${cz}`;
    const candidates = edgeMap.get(key) || [];
    let found = false;
    for (const e of candidates) {
      const eKey = `${e.x1},${e.z1},${e.x2},${e.z2}`;
      if (used.has(eKey)) continue;
      used.add(eKey);
      cx = e.x2;
      cz = e.z2;
      found = true;
      break;
    }
    if (!found) break;
  }

  return douglasPeucker(polygon, cellSize);
}

/**
 * Douglas-Peucker polyline simplification.
 */
function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points;

  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToLineDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function pointToLineDist(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.z - a.z) ** 2);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq));
  const projX = a.x + t * dx, projZ = a.z + t * dz;
  return Math.sqrt((p.x - projX) ** 2 + (p.z - projZ) ** 2);
}

/**
 * Full zone extraction pipeline: Voronoi assign → threshold → morph close → flood fill → metadata.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @returns {Array<Object>} Development zones sorted by priority
 */
export function extractDevelopmentZones(map) {
  const { width, height, cellSize, nuclei } = map;
  if (!nuclei || nuclei.length === 0) return [];

  const morphRadius = Math.max(1, Math.round(ZONE_MORPH_RADIUS_M / cellSize));

  // Step 1: Voronoi assignment — each cell → nearest nucleus index
  const assignment = new Grid2D(width, height, { type: 'int32', fill: -1 });
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      let bestDist = Infinity, bestIdx = -1;
      for (let i = 0; i < nuclei.length; i++) {
        const dx = gx - nuclei[i].gx, dz = gz - nuclei[i].gz;
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      assignment.set(gx, gz, bestIdx);
    }
  }

  // Step 2: Per-nucleus candidate masks → morph close → flood fill
  const allZones = [];

  for (let ni = 0; ni < nuclei.length; ni++) {
    const mask = new Grid2D(width, height, { type: 'uint8' });
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        if (assignment.get(gx, gz) !== ni) continue;
        if (map.waterMask.get(gx, gz) > 0) continue;
        if (map.landValue.get(gx, gz) < ZONE_LV_THRESHOLD) continue;
        if (map.buildability.get(gx, gz) < ZONE_BUILD_THRESHOLD) continue;
        if (map.slope && map.slope.get(gx, gz) >= effectiveSlopeMax(map.landValue.get(gx, gz))) continue;
        mask.set(gx, gz, 1);
      }
    }

    // Step 3: Morphological close
    const closed = morphClose(mask, morphRadius);

    // Remove cells that were added by dilation but are unbuildable.
    // This ensures rivers and roads split zones into separate parcels.
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        if (closed.get(gx, gz) === 0) continue;
        // Water cells must never be in a zone
        if (map.waterMask.get(gx, gz) > 0) { closed.set(gx, gz, 0); continue; }
        // Road cells split zones (roads are barriers)
        if (map.roadGrid && map.roadGrid.get(gx, gz) > 0) { closed.set(gx, gz, 0); continue; }
        // Cells added by dilation that fail slope check
        if (mask.get(gx, gz) === 0 && map.slope && map.slope.get(gx, gz) >= effectiveSlopeMax(map.landValue.get(gx, gz))) {
          closed.set(gx, gz, 0);
        }
      }
    }

    // Step 4: Flood fill
    const zones = floodFillZones(closed, ZONE_MIN_SIZE);

    // Step 5: Compute metadata per zone
    const n = nuclei[ni];
    const nwx = map.originX + n.gx * cellSize;
    const nwz = map.originZ + n.gz * cellSize;

    for (const zone of zones) {
      let slopeSum = 0, gradX = 0, gradZ = 0, lvSum = 0;
      for (const c of zone.cells) {
        if (map.slope) slopeSum += map.slope.get(c.gx, c.gz);
        lvSum += map.landValue.get(c.gx, c.gz);

        if (map.elevation) {
          const e = map.elevation.get(c.gx, c.gz);
          if (c.gx > 0) gradX += e - map.elevation.get(c.gx - 1, c.gz);
          if (c.gz > 0) gradZ += e - map.elevation.get(c.gx, c.gz - 1);
        }
      }

      const avgSlope = map.slope ? slopeSum / zone.cells.length : 0;
      const avgLandValue = lvSum / zone.cells.length;
      const gradLen = Math.sqrt(gradX * gradX + gradZ * gradZ);
      const slopeDir = gradLen > 0.01
        ? { x: gradX / gradLen, z: gradZ / gradLen }
        : { x: 0, z: 0 };

      const cwx = map.originX + zone.centroidGx * cellSize;
      const cwz = map.originZ + zone.centroidGz * cellSize;
      const distFromNucleus = Math.sqrt((cwx - nwx) ** 2 + (cwz - nwz) ** 2);

      const boundary = extractZoneBoundary(zone.cells, cellSize, map.originX, map.originZ);

      const gradingCost = avgSlope > 0.15 ? (avgSlope - 0.15) * 2 : 0;
      const priority = (lvSum / Math.max(1, distFromNucleus)) * (1 - gradingCost);

      allZones.push({
        ...zone,
        nucleusIdx: ni,
        avgSlope,
        avgLandValue,
        slopeDir,
        totalLandValue: lvSum,
        distFromNucleus,
        priority,
        boundary,
      });
    }
  }

  // Sort by priority (highest first)
  allZones.sort((a, b) => b.priority - a.priority);
  return allZones;
}
