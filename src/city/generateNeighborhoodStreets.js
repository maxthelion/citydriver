/**
 * C7. Neighborhood street grids.
 * Each neighborhood generates its own internal street network based on its
 * type. Streets are placed as a rotated grid within the neighborhood's
 * ownership footprint, with type-specific variations in spacing, jitter,
 * and axis ratios.
 */

import { distance2D } from '../core/math.js';

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {import('../core/rng.js').SeededRandom} rng
 */
export function generateNeighborhoodStreets(cityLayers, graph, rng) {
  const params = cityLayers.getData('params');
  const neighborhoods = cityLayers.getData('neighborhoods');
  const ownership = cityLayers.getData('ownership');
  const density = cityLayers.getGrid('density');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!params || !neighborhoods || !ownership || !density) return;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;

  const footprints = buildFootprints(ownership, neighborhoods.length, w, h);

  for (let i = 0; i < neighborhoods.length; i++) {
    const hood = neighborhoods[i];
    const footprint = footprints[i];
    if (footprint.size < 20) continue;

    const avgDensity = averageDensity(density, footprint, w);
    if (avgDensity < 0.05) continue;

    const baseSpacing = densityToSpacing(avgDensity, cs);
    const angle = getDominantDirection(hood, neighborhoods, waterMask, elevation, seaLevel, w, h, cs);
    const hoodRng = rng.fork(`hood-${i}`);

    switch (hood.streetPattern) {
      case 'irregular':
        placeGridStreets(graph, hood, footprint, angle + hoodRng.range(-0.15, 0.15),
          baseSpacing * 0.7, baseSpacing * 0.8, cs, w, h, hoodRng,
          { jitter: baseSpacing * 0.15 });
        break;
      case 'linear':
        placeGridStreets(graph, hood, footprint, angle,
          baseSpacing * 0.8, baseSpacing * 1.5, cs, w, h, hoodRng,
          { jitter: baseSpacing * 0.03 });
        break;
      case 'radial':
        placeRadialStreets(graph, hood, footprint, baseSpacing, cs, w, h, hoodRng);
        break;
      case 'organic':
        // Organic: rotated grid with large jitter, simulating contour-following
        placeGridStreets(graph, hood, footprint, angle + hoodRng.range(-0.3, 0.3),
          baseSpacing * 1.1, baseSpacing * 1.3, cs, w, h, hoodRng,
          { jitter: baseSpacing * 0.25 });
        break;
      case 'grid':
      default:
        placeGridStreets(graph, hood, footprint, angle,
          baseSpacing, baseSpacing, cs, w, h, hoodRng,
          { jitter: baseSpacing * 0.03 });
        break;
    }
  }
}

/**
 * Place a rotated grid of streets within a neighborhood footprint.
 *
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {object} hood - neighborhood nucleus
 * @param {Set<number>} footprint - set of cell indices (gz * w + gx)
 * @param {number} angle - grid rotation angle (radians)
 * @param {number} uSpacing - spacing between cross streets (world units)
 * @param {number} vSpacing - spacing between primary streets (world units)
 * @param {number} cs - cell size
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [options]
 */
function placeGridStreets(graph, hood, footprint, angle, uSpacing, vSpacing, cs, w, h, rng, options = {}) {
  const { jitter = 0 } = options;

  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const cx = hood.x;
  const cz = hood.z;

  // Find extent in rotated coordinates
  let minU = Infinity, maxU = -Infinity;
  let minV = Infinity, maxV = -Infinity;

  for (const idx of footprint) {
    const gx = idx % w;
    const gz = (idx - gx) / w;
    const wx = gx * cs;
    const wz = gz * cs;
    const dx = wx - cx;
    const dz = wz - cz;
    const u = dx * cosA + dz * sinA;
    const v = -dx * sinA + dz * cosA;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  // Generate grid intersection nodes
  const nodeMap = new Map(); // "i,j" -> nodeId

  const iMin = Math.ceil(minU / uSpacing);
  const iMax = Math.floor(maxU / uSpacing);
  const jMin = Math.ceil(minV / vSpacing);
  const jMax = Math.floor(maxV / vSpacing);

  // Safety: don't generate absurdly large grids
  if ((iMax - iMin) * (jMax - jMin) > 5000) return;

  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      let u = i * uSpacing;
      let v = j * vSpacing;

      if (jitter > 0) {
        u += rng.range(-jitter, jitter);
        v += rng.range(-jitter, jitter);
      }

      // Transform to world coordinates
      const wx = cx + u * cosA - v * sinA;
      const wz = cz + u * sinA + v * cosA;

      // Check if in footprint
      const gx = Math.round(wx / cs);
      const gz = Math.round(wz / cs);
      if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
      if (!footprint.has(gz * w + gx)) continue;

      const nodeId = findOrCreateNode(graph, wx, wz, cs * 1.0);
      nodeMap.set(`${i},${j}`, nodeId);
    }
  }

  // Connect along primary direction (same j, consecutive i)
  for (let j = jMin; j <= jMax; j++) {
    let prevI = null;
    for (let i = iMin; i <= iMax; i++) {
      const key = `${i},${j}`;
      if (!nodeMap.has(key)) { prevI = null; continue; }
      if (prevI !== null) {
        const a = nodeMap.get(`${prevI},${j}`);
        const b = nodeMap.get(key);
        addLocalEdge(graph, a, b);
      }
      prevI = i;
    }
  }

  // Connect along secondary direction (same i, consecutive j)
  for (let i = iMin; i <= iMax; i++) {
    let prevJ = null;
    for (let j = jMin; j <= jMax; j++) {
      const key = `${i},${j}`;
      if (!nodeMap.has(key)) { prevJ = null; continue; }
      if (prevJ !== null) {
        const a = nodeMap.get(`${i},${prevJ}`);
        const b = nodeMap.get(key);
        addLocalEdge(graph, a, b);
      }
      prevJ = j;
    }
  }
}

/**
 * Place radial streets (spokes + rings) for market neighborhoods.
 */
function placeRadialStreets(graph, hood, footprint, spacing, cs, w, h, rng) {
  const cx = hood.x;
  const cz = hood.z;

  // Find max radius of footprint
  let maxR = 0;
  for (const idx of footprint) {
    const gx = idx % w;
    const gz = (idx - gx) / w;
    const dx = gx * cs - cx;
    const dz = gz * cs - cz;
    const r = Math.sqrt(dx * dx + dz * dz);
    if (r > maxR) maxR = r;
  }

  const numSpokes = rng.int(5, 8);
  const baseAngle = rng.range(0, Math.PI * 2);
  const numRings = Math.max(1, Math.floor(maxR / spacing));

  const centerNode = findOrCreateNode(graph, cx, cz, cs * 1.0);

  // Create nodes at spoke/ring intersections
  const ringNodes = []; // ringNodes[ring][spoke] = nodeId | null

  for (let r = 0; r < numRings; r++) {
    const radius = (r + 1) * spacing;
    const ring = [];

    for (let s = 0; s < numSpokes; s++) {
      const angle = baseAngle + (s / numSpokes) * Math.PI * 2;
      const wx = cx + Math.cos(angle) * radius;
      const wz = cz + Math.sin(angle) * radius;

      const gx = Math.round(wx / cs);
      const gz = Math.round(wz / cs);
      if (gx < 0 || gx >= w || gz < 0 || gz >= h || !footprint.has(gz * w + gx)) {
        ring.push(null);
        continue;
      }

      ring.push(findOrCreateNode(graph, wx, wz, cs * 1.0));
    }

    ringNodes.push(ring);
  }

  // Connect spokes (center → first ring, ring → next ring)
  for (let s = 0; s < numSpokes; s++) {
    if (ringNodes[0] && ringNodes[0][s] !== null) {
      addLocalEdge(graph, centerNode, ringNodes[0][s]);
    }

    for (let r = 0; r < numRings - 1; r++) {
      const a = ringNodes[r][s];
      const b = ringNodes[r + 1][s];
      if (a !== null && b !== null) {
        addLocalEdge(graph, a, b);
      }
    }
  }

  // Connect rings (consecutive spokes on same ring)
  for (let r = 0; r < numRings; r++) {
    for (let s = 0; s < numSpokes; s++) {
      const next = (s + 1) % numSpokes;
      const a = ringNodes[r][s];
      const b = ringNodes[r][next];
      if (a !== null && b !== null) {
        addLocalEdge(graph, a, b);
      }
    }
  }
}

// --- Helpers ---

function buildFootprints(ownership, numNeighborhoods, w, h) {
  const footprints = [];
  for (let i = 0; i < numNeighborhoods; i++) {
    footprints.push(new Set());
  }

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const owner = ownership.get(gx, gz);
      if (owner >= 0 && owner < numNeighborhoods) {
        footprints[owner].add(gz * w + gx);
      }
    }
  }

  return footprints;
}

function averageDensity(densityGrid, footprint, w) {
  let sum = 0;
  for (const idx of footprint) {
    const gx = idx % w;
    const gz = (idx - gx) / w;
    sum += densityGrid.get(gx, gz);
  }
  return footprint.size > 0 ? sum / footprint.size : 0;
}

function densityToSpacing(density, cs) {
  // density 1.0 → 4*cs (40m), density 0.0 → 16*cs (160m)
  const t = Math.max(0, Math.min(1, density));
  return cs * (16 - 12 * t);
}

function getDominantDirection(hood, neighborhoods, waterMask, elevation, seaLevel, w, h, cs) {
  // For waterfront/valley: align along the water feature
  if (hood.streetPattern === 'linear') {
    const waterDir = getWaterfrontDirection(hood.gx, hood.gz, waterMask, elevation, seaLevel, w, h, 15);
    if (waterDir !== null) return waterDir;
  }

  // Default: angle from old town to this nucleus
  const oldTown = neighborhoods[0];
  if (hood === oldTown) return 0;
  return Math.atan2(hood.x - oldTown.x, hood.z - oldTown.z);
}

function getWaterfrontDirection(gx, gz, waterMask, elevation, seaLevel, w, h, radius) {
  let sumDx = 0, sumDz = 0, count = 0;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = gx + dx, nz = gz + dz;
      if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
      const isWater = elevation.get(nx, nz) < seaLevel ||
        (waterMask && waterMask.get(nx, nz) > 0);
      if (isWater) {
        sumDx += dx;
        sumDz += dz;
        count++;
      }
    }
  }
  if (count === 0) return null;
  // Direction toward water; streets run perpendicular (along the coast)
  return Math.atan2(sumDx / count, sumDz / count) + Math.PI / 2;
}

function findOrCreateNode(graph, x, z, threshold) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < threshold) {
    return nearest.id;
  }
  return graph.addNode(x, z, { type: 'street' });
}

function addLocalEdge(graph, a, b) {
  if (a === b) return;
  const neighbors = graph.neighbors(a);
  if (neighbors.includes(b)) return;
  graph.addEdge(a, b, { width: 6, hierarchy: 'local' });
}
