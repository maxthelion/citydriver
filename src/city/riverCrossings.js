/**
 * C3b. River crossings.
 * Identifies bridge points along rivers within the city, creating a bridge
 * grid that allows pathfinding to cross water at specific locations.
 *
 * Runs after terrain refinement (C2) and before neighborhood placement (C4)
 * so that both neighborhood scoring and road connections can use bridges.
 */

import { Grid2D } from '../core/Grid2D.js';
import { distance2D } from '../core/math.js';

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @returns {{ bridgeGrid: Grid2D, bridges: Array<{gx, gz, x, z, width, heading, importance}> }}
 */
export function identifyRiverCrossings(cityLayers) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  const slope = cityLayers.getGrid('slope');

  if (!params || !elevation || !waterMask) {
    const w = params?.width ?? 1;
    const h = params?.height ?? 1;
    return {
      bridgeGrid: new Grid2D(w, h, { type: 'uint8' }),
      bridges: [],
    };
  }

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;
  const tier = params.settlement?.tier ?? 3;

  const bridgeGrid = new Grid2D(w, h, { type: 'uint8', cellSize: cs });

  // Find river cells: water mask > 0 AND elevation >= seaLevel (not ocean)
  const riverCells = new Set();
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (waterMask.get(gx, gz) > 0 && elevation.get(gx, gz) >= seaLevel) {
        riverCells.add(gz * w + gx);
      }
    }
  }

  if (riverCells.size === 0) {
    return { bridgeGrid, bridges: [] };
  }

  // Build road proximity from anchor routes (if available)
  const roadGraph = cityLayers.getData('roadGraph');

  // Score candidate crossing points
  const candidates = scoreCrossingCandidates(
    riverCells, elevation, waterMask, slope, seaLevel, w, h, cs, tier
  );

  // Select bridges with spacing constraints
  const maxBridges = { 1: 5, 2: 3, 3: 2 }[tier] ?? 2;
  const minSpacing = { 1: 60, 2: 80, 3: 100 }[tier] ?? 80;

  const bridges = selectBridges(candidates, maxBridges, minSpacing);

  // Mark bridge cells in the grid
  for (const bridge of bridges) {
    markBridgeCells(bridgeGrid, bridge, waterMask, seaLevel, elevation, w, h);
  }

  // Convert grid coords to world coords
  for (const bridge of bridges) {
    bridge.x = bridge.gx * cs;
    bridge.z = bridge.gz * cs;
  }

  return { bridgeGrid, bridges };
}

/**
 * Score every potential crossing point along rivers.
 * A crossing point is a land cell adjacent to water, where a bridge could start.
 */
function scoreCrossingCandidates(riverCells, elevation, waterMask, slope, seaLevel, w, h, cs, tier) {
  const candidates = [];
  const centerGx = Math.floor(w / 2);
  const centerGz = Math.floor(h / 2);
  const maxRadius = Math.min(w, h) * 0.45;

  // For each river cell, measure crossing width in 4 directions
  const directions = [
    [1, 0],   // E-W crossing
    [0, 1],   // N-S crossing
    [1, 1],   // diagonal
    [1, -1],  // other diagonal
  ];

  // Sample every few cells along rivers (don't need to check every cell)
  const step = 3;
  const checked = new Set();

  for (const idx of riverCells) {
    const gx = idx % w;
    const gz = (idx - gx) / w;
    if (gx % step !== 0 || gz % step !== 0) continue;

    for (const [ddx, ddz] of directions) {
      // Find river width in this direction
      const crossing = measureCrossing(gx, gz, ddx, ddz, waterMask, elevation, seaLevel, w, h);
      if (!crossing) continue;

      // Deduplicate: use midpoint of crossing as key
      const midGx = Math.round((crossing.startGx + crossing.endGx) / 2);
      const midGz = Math.round((crossing.startGz + crossing.endGz) / 2);
      const key = midGz * w + midGx;
      if (checked.has(key)) continue;
      checked.add(key);

      // Score this crossing point
      let score = 0;

      // Prefer narrow crossings (fewer cells of water to bridge)
      const width = crossing.waterWidth;
      if (width > 15) continue; // Too wide to bridge
      score += Math.max(0, 10 - width) * 2; // narrower = much better

      // Prefer flat banks on both sides
      const startSlope = slope ? slope.get(crossing.startGx, crossing.startGz) : 0;
      const endSlope = slope ? slope.get(crossing.endGx, crossing.endGz) : 0;
      const bankSlope = Math.max(startSlope, endSlope);
      if (bankSlope > 0.25) continue; // Too steep for bridge abutment
      score += Math.max(0, 0.2 - bankSlope) * 20;

      // Prefer crossings near city center (higher demand)
      const distFromCenter = distance2D(midGx, midGz, centerGx, centerGz);
      score += Math.max(0, 1.0 - distFromCenter / maxRadius) * 5;

      // Avoid map edges
      const edgeDist = Math.min(midGx, midGz, w - 1 - midGx, h - 1 - midGz);
      if (edgeDist < 10) score *= 0.2;

      if (score > 1) {
        candidates.push({
          gx: midGx,
          gz: midGz,
          score,
          width,
          heading: Math.atan2(ddx, ddz),
          startGx: crossing.startGx,
          startGz: crossing.startGz,
          endGx: crossing.endGx,
          endGz: crossing.endGz,
          importance: Math.max(0.2, 1.0 - distFromCenter / maxRadius),
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * Measure crossing width at a river cell in a given direction.
 * Walks outward from the cell in both directions (+/-) to find land on each side.
 * Returns null if no valid crossing found within max search distance.
 */
function measureCrossing(gx, gz, ddx, ddz, waterMask, elevation, seaLevel, w, h) {
  const maxSearch = 20;

  // Walk in +direction to find the far bank
  let endGx = gx, endGz = gz;
  let waterWidth = 0;
  let inWater = true;

  for (let i = 1; i <= maxSearch; i++) {
    const nx = gx + ddx * i;
    const nz = gz + ddz * i;
    if (nx < 0 || nx >= w || nz < 0 || nz >= h) return null;

    const isWater = waterMask.get(nx, nz) > 0 || elevation.get(nx, nz) < seaLevel;
    if (isWater) {
      waterWidth++;
    } else {
      endGx = nx;
      endGz = nz;
      inWater = false;
      break;
    }
  }
  if (inWater) return null; // No far bank found

  // Walk in -direction to find the near bank
  let startGx = gx, startGz = gz;
  inWater = true;

  for (let i = 1; i <= maxSearch; i++) {
    const nx = gx - ddx * i;
    const nz = gz - ddz * i;
    if (nx < 0 || nx >= w || nz < 0 || nz >= h) return null;

    const isWater = waterMask.get(nx, nz) > 0 || elevation.get(nx, nz) < seaLevel;
    if (isWater) {
      waterWidth++;
    } else {
      startGx = nx;
      startGz = nz;
      inWater = false;
      break;
    }
  }
  if (inWater) return null; // No near bank found

  if (waterWidth < 1) return null; // Not actually a river
  return { startGx, startGz, endGx, endGz, waterWidth };
}

/**
 * Select bridges greedily with spacing constraints.
 */
function selectBridges(candidates, maxBridges, minSpacing) {
  const selected = [];

  for (const c of candidates) {
    if (selected.length >= maxBridges) break;

    let tooClose = false;
    for (const s of selected) {
      if (distance2D(c.gx, c.gz, s.gx, s.gz) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    selected.push(c);
  }

  return selected;
}

/**
 * Mark cells along a bridge crossing as passable in the bridge grid.
 * Walks from the start bank to the end bank, marking water cells.
 */
function markBridgeCells(bridgeGrid, bridge, waterMask, seaLevel, elevation, w, h) {
  const { startGx, startGz, endGx, endGz } = bridge;

  // Bresenham-like walk from start to end, marking water cells
  const dx = endGx - startGx;
  const dz = endGz - startGz;
  const steps = Math.max(Math.abs(dx), Math.abs(dz));
  if (steps === 0) return;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gx = Math.round(startGx + dx * t);
    const gz = Math.round(startGz + dz * t);
    if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;

    // Mark this cell and adjacent cells (bridge has some width)
    for (let dz2 = -1; dz2 <= 1; dz2++) {
      for (let dx2 = -1; dx2 <= 1; dx2++) {
        const nx = gx + dx2, nz = gz + dz2;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
          bridgeGrid.set(nx, nz, 1);
        }
      }
    }
  }
}
