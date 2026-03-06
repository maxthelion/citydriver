/**
 * C3b. River crossings.
 * Detects bridges where road edges cross water, creating a bridge grid
 * that allows pathfinding to cross water at those locations.
 *
 * Runs after anchor routes so we know where roads actually are.
 */

import { Grid2D } from '../core/Grid2D.js';
import { distance2D } from '../core/math.js';

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @returns {{ bridgeGrid: Grid2D, bridges: Array<{startGx, startGz, endGx, endGz, gx, gz, x, z, width, heading, importance}> }}
 */
export function identifyRiverCrossings(cityLayers) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  const roadGraph = cityLayers.getData('roadGraph');

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

  const bridgeGrid = new Grid2D(w, h, { type: 'uint8', cellSize: cs });

  if (!roadGraph || roadGraph.edges.size === 0) {
    return { bridgeGrid, bridges: [] };
  }

  // Walk each road edge polyline and detect water crossings
  const rawBridges = [];

  for (const [edgeId, edge] of roadGraph.edges) {
    const polyline = roadGraph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;

    const hierarchy = edge.hierarchy || 'local';
    const importance = hierarchy === 'arterial' ? 1.0 : hierarchy === 'collector' ? 0.7 : 0.4;

    // Walk polyline cell by cell, detect land→water and water→land transitions
    let inWater = false;
    let waterEntryGx = 0, waterEntryGz = 0; // last land cell before water
    let lastLandGx = 0, lastLandGz = 0;

    // Rasterize the polyline into grid cells
    const cells = rasterizePolyline(polyline, cs, w, h);

    for (let i = 0; i < cells.length; i++) {
      const { gx, gz } = cells[i];
      const isWater = waterMask.get(gx, gz) > 0 && elevation.get(gx, gz) >= seaLevel;

      if (!inWater && isWater) {
        // Land → water transition: start of a bridge
        inWater = true;
        waterEntryGx = lastLandGx;
        waterEntryGz = lastLandGz;
      } else if (inWater && !isWater) {
        // Water → land transition: end of a bridge
        inWater = false;
        const waterWidth = distance2D(waterEntryGx, waterEntryGz, gx, gz);

        if (waterWidth >= 1 && waterWidth <= 25) {
          const midGx = Math.round((waterEntryGx + gx) / 2);
          const midGz = Math.round((waterEntryGz + gz) / 2);
          const heading = Math.atan2(gx - waterEntryGx, gz - waterEntryGz);

          rawBridges.push({
            startGx: waterEntryGx,
            startGz: waterEntryGz,
            endGx: gx,
            endGz: gz,
            gx: midGx,
            gz: midGz,
            width: Math.round(waterWidth),
            heading,
            importance,
            edgeId,
          });
        }
      }

      if (!isWater) {
        lastLandGx = gx;
        lastLandGz = gz;
      }
    }
  }

  // Deduplicate bridges that are very close (from overlapping edges)
  const bridges = deduplicateBridges(rawBridges, 5);

  // Mark bridge cells in the grid and convert to world coords
  for (const bridge of bridges) {
    markBridgeCells(bridgeGrid, bridge, w, h);
    bridge.x = bridge.gx * cs;
    bridge.z = bridge.gz * cs;
  }

  return { bridgeGrid, bridges };
}

/**
 * Rasterize a world-coord polyline into grid cells (Bresenham).
 */
function rasterizePolyline(polyline, cs, w, h) {
  const cells = [];
  const seen = new Set();

  for (let i = 0; i < polyline.length - 1; i++) {
    const x0 = Math.round(polyline[i].x / cs);
    const z0 = Math.round(polyline[i].z / cs);
    const x1 = Math.round(polyline[i + 1].x / cs);
    const z1 = Math.round(polyline[i + 1].z / cs);

    // Bresenham
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
 * Remove duplicate bridges within minDist grid cells of each other.
 * Keeps the one with higher importance.
 */
function deduplicateBridges(bridges, minDist) {
  bridges.sort((a, b) => b.importance - a.importance);
  const selected = [];

  for (const b of bridges) {
    let tooClose = false;
    for (const s of selected) {
      if (distance2D(b.gx, b.gz, s.gx, s.gz) < minDist) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) selected.push(b);
  }

  return selected;
}

/**
 * Mark cells along a bridge crossing as passable in the bridge grid.
 */
function markBridgeCells(bridgeGrid, bridge, w, h) {
  const { startGx, startGz, endGx, endGz } = bridge;
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
