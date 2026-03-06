/**
 * C0e. Seed growth nuclei from regional settlements and geography.
 *
 * Finds all regional settlements within city bounds (primary + satellites),
 * classifies each by geography, assigns population targets, and returns
 * nucleus objects ready for the growth loop.
 */

import { distance2D } from '../core/math.js';

/** Population allocation by settlement tier. */
const TIER_POP_WEIGHT = { 1: 0.50, 2: 0.30, 3: 0.10, 4: 0.05, 5: 0.02 };

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} roadGraph
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<Nucleus>}
 *
 * @typedef {{
 *   id: number, gx: number, gz: number, x: number, z: number,
 *   type: string, tier: number, population: number, targetPopulation: number,
 *   connected: boolean, streetPattern: string, plotConfig: PlotConfig,
 *   growthFront: Map
 * }} Nucleus
 *
 * @typedef {{
 *   frontageWidth: number, plotDepth: number,
 *   setback: number, crossStreetSpacing: number
 * }} PlotConfig
 */
export function seedNuclei(cityLayers, roadGraph, rng) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const slope = cityLayers.getGrid('slope');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!params || !elevation) return [];

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;
  const settlement = params.settlement;

  const centerGx = Math.floor(w / 2);
  const centerGz = Math.floor(h / 2);

  const totalTargetPop = cityLayers.getData('targetPopulation') || 2000;

  // --- 1. Gather settlements from regional layer ---
  const regionalLayers = cityLayers.getData('regionalLayers');
  const allSettlements = regionalLayers?.getData('settlements') || [];
  const rcs = params.regionalCellSize || 50;
  const minGx = params.regionalMinGx || 0;
  const minGz = params.regionalMinGz || 0;

  // Convert regional coords to city-local coords
  const inBounds = (s) => {
    const localX = (s.gx - minGx) * rcs;
    const localZ = (s.gz - minGz) * rcs;
    return localX >= 0 && localX <= (w - 1) * cs &&
           localZ >= 0 && localZ <= (h - 1) * cs;
  };

  // Build waterfront mask for classification
  const waterfrontGrid = buildWaterfrontGrid(elevation, waterMask, seaLevel, w, h);

  // Build road proximity set
  const roadCells = buildRoadCellSet(roadGraph, w, h, cs);

  const nuclei = [];
  let nextId = 0;

  // --- 2. Primary settlement (always the first nucleus, at center) ---
  const primaryType = classifyType(centerGx, centerGz, {
    elevation, slope, waterMask, waterfrontGrid, roadCells, w, h, cs, seaLevel,
  });
  // Override: primary is always oldTown
  nuclei.push(makeNucleus(nextId++, centerGx, centerGz, cs, 'oldTown', settlement?.tier ?? 2, {
    frontageWidth: 8, plotDepth: 25, setback: 2, crossStreetSpacing: 55,
  }));

  // Cap total nuclei by tier
  const tier = settlement?.tier ?? 3;
  const maxNuclei = tier <= 1 ? 12 : tier <= 2 ? 8 : 6;

  // --- 3. Regional satellites within city bounds ---
  // Sort by tier (more important settlements first)
  const inBoundsSatellites = allSettlements
    .filter(s => s !== settlement && inBounds(s))
    .sort((a, b) => (a.tier ?? 5) - (b.tier ?? 5));

  for (const s of inBoundsSatellites) {
    if (nuclei.length >= maxNuclei) break;

    const localX = (s.gx - minGx) * rcs;
    const localZ = (s.gz - minGz) * rcs;
    const gx = Math.round(localX / cs);
    const gz = Math.round(localZ / cs);

    if (gx < 1 || gx >= w - 1 || gz < 1 || gz >= h - 1) continue;
    if (elevation.get(gx, gz) < seaLevel) continue;
    if (waterMask && waterMask.get(gx, gz) > 0) continue;

    // Don't place too close to existing nuclei
    const tooClose = nuclei.some(n => distance2D(gx, gz, n.gx, n.gz) < 8);
    if (tooClose) continue;

    const type = classifyType(gx, gz, {
      elevation, slope, waterMask, waterfrontGrid, roadCells, w, h, cs, seaLevel,
    });

    const config = plotConfigForType(type);
    nuclei.push(makeNucleus(nextId++, gx, gz, cs, type, s.tier ?? 4, config));
  }

  // --- 4. Fill geographic niches if needed ---
  // Try placing more nuclei at good terrain sites to reach the target count.
  if (nuclei.length < maxNuclei) {
    const candidates = findNichesSites(centerGx, centerGz, {
      elevation, slope, waterMask, waterfrontGrid, roadCells, w, h, cs, seaLevel,
    });
    for (const c of candidates) {
      if (nuclei.length >= maxNuclei) break;
      const tooClose = nuclei.some(n => distance2D(c.gx, c.gz, n.gx, n.gz) < 8);
      if (tooClose) continue;

      const type = classifyType(c.gx, c.gz, {
        elevation, slope, waterMask, waterfrontGrid, roadCells, w, h, cs, seaLevel,
      });
      const config = plotConfigForType(type);
      nuclei.push(makeNucleus(nextId++, c.gx, c.gz, cs, type, 4, config));
    }
  }

  // --- 5. Distribute population targets ---
  distributePopulation(nuclei, totalTargetPop);

  // --- 6. Mark connectivity ---
  for (const n of nuclei) {
    n.connected = isNearRoad(n.gx, n.gz, roadCells, w, 5);
  }

  return nuclei;
}

function makeNucleus(id, gx, gz, cs, type, tier, plotConfig) {
  return {
    id, gx, gz,
    x: gx * cs, z: gz * cs,
    type, tier,
    population: 0,
    targetPopulation: 0, // set by distributePopulation
    connected: false,
    streetPattern: patternForType(type),
    plotConfig,
    growthFront: new Map(), // edgeId -> { distance along edge }
  };
}

function distributePopulation(nuclei, totalTarget) {
  // Weight by tier
  let totalWeight = 0;
  for (const n of nuclei) {
    n._weight = TIER_POP_WEIGHT[n.tier] ?? 0.02;
    totalWeight += n._weight;
  }
  for (const n of nuclei) {
    n.targetPopulation = Math.round((n._weight / totalWeight) * totalTarget);
    delete n._weight;
  }
}

function patternForType(type) {
  switch (type) {
    case 'oldTown': return 'irregular';
    case 'waterfront': return 'linear';
    case 'market': return 'radial';
    case 'hilltop': return 'organic';
    case 'valley': return 'linear';
    case 'roadside': return 'grid';
    default: return 'grid';
  }
}

function plotConfigForType(type) {
  switch (type) {
    case 'oldTown':
      return { frontageWidth: 8, plotDepth: 25, setback: 2, crossStreetSpacing: 55 };
    case 'waterfront':
      return { frontageWidth: 10, plotDepth: 20, setback: 3, crossStreetSpacing: 65 };
    case 'market':
      return { frontageWidth: 12, plotDepth: 30, setback: 3, crossStreetSpacing: 60 };
    case 'hilltop':
      return { frontageWidth: 14, plotDepth: 30, setback: 4, crossStreetSpacing: 70 };
    case 'valley':
      return { frontageWidth: 12, plotDepth: 28, setback: 3, crossStreetSpacing: 60 };
    case 'roadside':
      return { frontageWidth: 10, plotDepth: 25, setback: 3, crossStreetSpacing: 60 };
    case 'suburban':
    default:
      return { frontageWidth: 16, plotDepth: 35, setback: 5, crossStreetSpacing: 80 };
  }
}

function classifyType(gx, gz, ctx) {
  const { elevation, slope, waterMask, waterfrontGrid, roadCells, w, h, cs, seaLevel } = ctx;

  const isWaterfront = waterfrontGrid[gz * w + gx] === 1;
  const onRoad = roadCells.has(gz * w + gx);
  const elev = elevation.get(gx, gz);
  const s = slope ? slope.get(gx, gz) : 0;

  // Road junction check
  let roadDirs = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of dirs) {
    for (let r = 1; r <= 5; r++) {
      const nx = gx + dx * r, nz = gz + dz * r;
      if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadCells.has(nz * w + nx)) {
        roadDirs++;
        break;
      }
    }
  }

  // Elevated check
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
  const isElevated = totalNeighbors > 0 && lowerNeighbors / totalNeighbors > 0.6;
  const isValley = totalNeighbors > 0 && lowerNeighbors / totalNeighbors < 0.3 && s < 0.08;

  if (isWaterfront) return 'waterfront';
  if (roadDirs >= 3) return 'market';
  if (isElevated && s > 0.05) return 'hilltop';
  if (isValley) return 'valley';
  if (onRoad) return 'roadside';
  return 'suburban';
}

function findNichesSites(centerGx, centerGz, ctx) {
  const { elevation, slope, waterMask, w, h, seaLevel } = ctx;
  const candidates = [];
  const maxR = Math.min(w, h) * 0.35;
  const step = 5;

  for (let gz = step; gz < h - step; gz += step) {
    for (let gx = step; gx < w - step; gx += step) {
      if (elevation.get(gx, gz) < seaLevel) continue;
      if (waterMask && waterMask.get(gx, gz) > 0) continue;
      const s = slope ? slope.get(gx, gz) : 0;
      if (s > 0.3) continue;

      const dist = distance2D(gx, gz, centerGx, centerGz);
      if (dist > maxR || dist < 8) continue;

      // Score: prefer flat land near center, but accept moderate slopes
      const slopeFactor = Math.max(0, 1 - s / 0.3);
      const score = (1 - dist / maxR) * 0.5 + slopeFactor * 0.5;
      candidates.push({ gx, gz, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 8);
}

function isNearRoad(gx, gz, roadCells, w, radius) {
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (roadCells.has((gz + dz) * w + (gx + dx))) return true;
    }
  }
  return false;
}

function buildRoadCellSet(roadGraph, w, h, cs) {
  const cells = new Set();
  for (const [, edge] of roadGraph.edges) {
    const fromNode = roadGraph.getNode(edge.from);
    const toNode = roadGraph.getNode(edge.to);
    if (!fromNode || !toNode) continue;

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
        const gxi = Math.round(ax + (bx - ax) * t);
        const gzi = Math.round(az + (bz - az) * t);
        if (gxi >= 0 && gxi < w && gzi >= 0 && gzi < h) {
          cells.add(gzi * w + gxi);
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

      let adj = false;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (elevation.get(nx, nz) < seaLevel ||
            (waterMask && waterMask.get(nx, nz) > 0)) {
          adj = true;
          break;
        }
      }
      if (adj) grid[gz * w + gx] = 1;
    }
  }
  return grid;
}
