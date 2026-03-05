/**
 * C4. Place neighborhood nuclei.
 * Scores terrain for neighborhood suitability and places nuclei with
 * spacing constraints. Each nucleus has a type derived from its geography.
 */

import { distance2D } from '../core/math.js';

const NUCLEUS_COUNT_BY_TIER = { 1: 12, 2: 6, 3: 3 };

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} roadGraph
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<{gx, gz, x, z, type, importance, radius, streetPattern}>}
 */
export function placeNeighborhoods(cityLayers, roadGraph, rng) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const slope = cityLayers.getGrid('slope');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!params || !elevation) return [];

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;
  const tier = params.settlement?.tier ?? 3;
  const maxNuclei = NUCLEUS_COUNT_BY_TIER[tier] ?? 3;

  const centerGx = Math.floor(w / 2);
  const centerGz = Math.floor(h / 2);
  const maxRadius = Math.min(w, h) * 0.45;

  // Build road proximity grid from existing anchor routes
  const roadCells = buildRoadCellSet(roadGraph, w, h, cs);

  // Build waterfront mask: land cells adjacent to water
  const waterfrontGrid = buildWaterfrontGrid(elevation, waterMask, seaLevel, w, h);

  // Score all buildable cells
  const candidates = [];
  const step = 3; // Sample every 3 cells for speed
  for (let gz = step; gz < h - step; gz += step) {
    for (let gx = step; gx < w - step; gx += step) {
      const score = scoreCell(gx, gz, {
        elevation, slope, waterMask, waterfrontGrid, roadCells,
        w, h, cs, seaLevel, centerGx, centerGz, maxRadius,
      });
      if (score > 0.1) {
        candidates.push({ gx, gz, score });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Place nuclei greedily with spacing constraints
  const nuclei = [];
  const minSpacing = Math.max(20, Math.floor(maxRadius / (maxNuclei * 0.6)));

  // First nucleus: old town at city center
  const centerScore = scoreCell(centerGx, centerGz, {
    elevation, slope, waterMask, waterfrontGrid, roadCells,
    w, h, cs, seaLevel, centerGx, centerGz, maxRadius,
  });
  nuclei.push({
    gx: centerGx, gz: centerGz,
    x: centerGx * cs, z: centerGz * cs,
    type: 'oldTown',
    importance: 1.0,
    radius: maxRadius * 0.3,
    streetPattern: 'irregular',
    score: Math.max(centerScore, 0.5),
  });

  // Place remaining nuclei
  for (const c of candidates) {
    if (nuclei.length >= maxNuclei) break;

    // Spacing check
    let tooClose = false;
    for (const n of nuclei) {
      if (distance2D(c.gx, c.gz, n.gx, n.gz) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // Don't place where center already is
    if (c.gx === centerGx && c.gz === centerGz) continue;

    const type = classifyNeighborhoodType(c.gx, c.gz, {
      elevation, slope, waterMask, waterfrontGrid, roadCells,
      w, h, cs, seaLevel, centerGx, centerGz,
    });

    const distFromCenter = distance2D(c.gx, c.gz, centerGx, centerGz);
    const importance = Math.max(0.2, 1.0 - distFromCenter / maxRadius) * 0.8;

    // Skip nuclei that are too far from center (low importance)
    if (importance < 0.25) continue;

    nuclei.push({
      gx: c.gx, gz: c.gz,
      x: c.gx * cs, z: c.gz * cs,
      type: type.name,
      importance,
      radius: maxRadius * (0.15 + importance * 0.15),
      streetPattern: type.streetPattern,
      score: c.score,
    });
  }

  return nuclei;
}

function scoreCell(gx, gz, ctx) {
  const { elevation, slope, waterMask, waterfrontGrid, roadCells,
    w, h, cs, seaLevel, centerGx, centerGz, maxRadius } = ctx;

  const elev = elevation.get(gx, gz);
  if (elev < seaLevel) return 0;
  if (waterMask && waterMask.get(gx, gz) > 0) return 0;

  const s = slope ? slope.get(gx, gz) : 0;
  if (s > 0.3) return 0; // Too steep

  let score = 0;

  // Flat terrain (primary)
  score += Math.max(0, 0.3 - s) * 2.0;

  // Near city center
  const distFromCenter = distance2D(gx, gz, centerGx, centerGz);
  score += Math.max(0, 1.0 - distFromCenter / maxRadius) * 0.5;

  // Near inherited road
  if (roadCells.has(gz * w + gx)) {
    score += 0.6;
  } else {
    // Check within a few cells
    let nearRoad = false;
    for (let dz = -3; dz <= 3 && !nearRoad; dz++) {
      for (let dx = -3; dx <= 3 && !nearRoad; dx++) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadCells.has(nz * w + nx)) {
          nearRoad = true;
        }
      }
    }
    if (nearRoad) score += 0.3;
  }

  // Waterfront bonus
  if (waterfrontGrid[gz * w + gx]) score += 0.4;

  // Edge avoidance
  const edgeDist = Math.min(gx, gz, w - 1 - gx, h - 1 - gz);
  if (edgeDist < 5) score *= 0.2;
  else if (edgeDist < 10) score *= 0.6;

  // Neighborhood ruggedness — average slope in a small radius
  let slopeSum = 0, slopeCount = 0;
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      const nx = gx + dx, nz = gz + dz;
      if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
        slopeSum += slope.get(nx, nz);
        slopeCount++;
      }
    }
  }
  const avgSlope = slopeSum / slopeCount;
  if (avgSlope > 0.2) score *= 0.3;

  return score;
}

function classifyNeighborhoodType(gx, gz, ctx) {
  const { elevation, slope, waterfrontGrid, roadCells,
    w, h, cs, seaLevel, centerGx, centerGz } = ctx;

  // Waterfront: must be directly adjacent to water (within 1 cell)
  const isWaterfront = waterfrontGrid[gz * w + gx] === 1;
  const onRoad = roadCells.has(gz * w + gx);
  const elev = elevation.get(gx, gz);
  const s = slope ? slope.get(gx, gz) : 0;

  // Check if at a road junction (multiple road cells nearby in different directions)
  let roadDirs = 0;
  const checkRadius = 5;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [ddx, ddz] of dirs) {
    for (let r = 1; r <= checkRadius; r++) {
      const nx = gx + ddx * r, nz = gz + ddz * r;
      if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadCells.has(nz * w + nx)) {
        roadDirs++;
        break;
      }
    }
  }
  const atJunction = roadDirs >= 3;

  // Check if elevated relative to surroundings
  let lowerNeighbors = 0, totalNeighbors = 0;
  for (let dz = -5; dz <= 5; dz++) {
    for (let dx = -5; dx <= 5; dx++) {
      const nx = gx + dx, nz = gz + dz;
      if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
        totalNeighbors++;
        if (elevation.get(nx, nz) < elev - 2) lowerNeighbors++;
      }
    }
  }
  const isElevated = lowerNeighbors / totalNeighbors > 0.6;

  // Check if in a valley (lower than surroundings, gentle slope)
  const isValley = lowerNeighbors / totalNeighbors < 0.3 && s < 0.08;

  if (isWaterfront) return { name: 'waterfront', streetPattern: 'linear' };
  if (atJunction) return { name: 'market', streetPattern: 'radial' };
  if (isElevated && s > 0.05) return { name: 'hilltop', streetPattern: 'organic' };
  if (isValley) return { name: 'valley', streetPattern: 'linear' };
  if (onRoad) return { name: 'roadside', streetPattern: 'grid' };
  return { name: 'suburban', streetPattern: 'grid' };
}

function buildRoadCellSet(roadGraph, w, h, cs) {
  const cells = new Set();
  for (const [, edge] of roadGraph.edges) {
    const fromNode = roadGraph.getNode(edge.from);
    const toNode = roadGraph.getNode(edge.to);
    if (!fromNode || !toNode) continue;

    // Rasterize edge (including intermediates)
    const points = [
      { x: fromNode.x, z: fromNode.z },
      ...(edge.points || []),
      { x: toNode.x, z: toNode.z },
    ];

    for (let i = 0; i < points.length - 1; i++) {
      const ax = points[i].x / cs, az = points[i].z / cs;
      const bx = points[i + 1].x / cs, bz = points[i + 1].z / cs;
      const segLen = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
      const steps = Math.max(1, Math.ceil(segLen));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const gx = Math.round(ax + (bx - ax) * t);
        const gz = Math.round(az + (bz - az) * t);
        if (gx >= 0 && gx < w && gz >= 0 && gz < h) {
          cells.add(gz * w + gx);
        }
      }
    }
  }
  return cells;
}

function buildWaterfrontGrid(elevation, waterMask, seaLevel, w, h) {
  const grid = new Uint8Array(w * h);
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      if (elevation.get(gx, gz) < seaLevel) continue;
      if (waterMask && waterMask.get(gx, gz) > 0) continue;

      let adjacentWater = false;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (elevation.get(nx, nz) < seaLevel ||
            (waterMask && waterMask.get(nx, nz) > 0)) {
          adjacentWater = true;
          break;
        }
      }
      if (adjacentWater) grid[gz * w + gx] = 1;
    }
  }
  return grid;
}
