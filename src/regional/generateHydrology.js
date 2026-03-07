/**
 * A3. Hydrology generation.
 * Derives river network from flow accumulation on the heightmap.
 * Rivers emerge in valleys, gather tributaries, widen downstream.
 * Geology-aware: impermeable rock produces more streams,
 * hard rock creates gorges, soft rock creates meanders and floodplains.
 */

import { Grid2D } from '../core/Grid2D.js';
import { clamp } from '../core/math.js';
import { PerlinNoise } from '../core/noise.js';
import { fillSinks, flowDirections, flowAccumulation, extractStreams, findConfluences, smoothRiverPaths } from '../core/flowAccumulation.js';
import { segmentsToVectorPaths, paintPathsOntoWaterMask, riverHalfWidth, channelProfile } from '../core/riverGeometry.js';

/**
 * Generate hydrology layers.
 *
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.cellSize=50]
 * @param {number} [params.seaLevel=0]
 * @param {number} [params.riverThreshold=80] - Min accumulation for a stream
 * @param {number} [params.riverMajorThreshold=800] - Min accumulation for major river
 * @param {Grid2D} elevation - Terrain elevation grid (will be modified by sink filling)
 * @param {Grid2D} permeability - Rock permeability grid
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{ rivers: Array, confluences: Array, flowDirs: Int8Array, accumulation: Float32Array, waterMask: Grid2D }}
 */
export function generateHydrology(params, elevation, permeability, rng) {
  const {
    width,
    height,
    cellSize = 50,
    seaLevel = 0,
    riverThreshold = 80,
    riverMajorThreshold = 800,
  } = params;

  // Work on a clone so we don't destroy the original elevation
  const filledElev = elevation.clone();

  // Add high-frequency low-amplitude noise to deflect flow routing and create meanders
  // (only affects the clone used for flow routing, not visible terrain)
  const hydroNoise = new PerlinNoise(rng.fork('hydroMeander'));
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const h = filledElev.get(gx, gz);
      if (h < seaLevel - 5) continue;
      const nx = gx / width, nz = gz / height;
      const micro = hydroNoise.fbm(nx * 40, nz * 40, { octaves: 2, persistence: 0.5, amplitude: 0.8 });
      filledElev.set(gx, gz, h + micro);
    }
  }

  // Fill sinks so water can always reach an edge
  fillSinks(filledElev);

  // Compute flow directions
  const flowDirs = flowDirections(filledElev);

  // Compute flow accumulation
  const accumulation = flowAccumulation(filledElev, flowDirs);

  // --- Geology-aware flow thresholds ---
  // On impermeable rock (low permeability), lower the threshold so more
  // streams form (water runs off instead of soaking in).
  // Compute per-cell effective threshold: base * (0.5 + permeability * 0.5)
  // For stream extraction we use a single global threshold but adjust accumulation
  // values to simulate the effect. We use the minimum permeability along each
  // cell's location to determine a local adjustment.
  const adjustedAccumulation = new Float32Array(accumulation.length);
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const idx = gz * width + gx;
      const perm = permeability.get(gx, gz);
      // On impermeable rock, boost effective accumulation (more surface runoff)
      // permBoost: 1.0 on impermeable (perm=0) to 0.0 on highly permeable (perm=1)
      const permBoost = 1.0 + (1.0 - perm) * 0.6;
      adjustedAccumulation[idx] = accumulation[idx] * permBoost;
    }
  }

  // Extract stream network using adjusted accumulation
  const thresholds = {
    stream: riverThreshold,
    river: riverThreshold * 5,
    majorRiver: riverMajorThreshold,
  };
  const rivers = extractStreams(adjustedAccumulation, flowDirs, filledElev, thresholds, seaLevel);

  // Find confluences using adjusted accumulation
  const confluences = findConfluences(adjustedAccumulation, flowDirs, filledElev, riverThreshold);

  // Smooth river paths: add sinusoidal meanders on gentle terrain
  smoothRiverPaths(rivers, elevation, width, height);

  // --- Floodplain carving ---
  // For large rivers (high accumulation), flatten terrain alongside the river.
  // Width proportional to sqrt(accumulation).
  carveFloodplains(elevation, rivers, width, height, seaLevel);

  // Build a water mask grid (cells that are water: below sea level or river)
  const waterMask = new Grid2D(width, height, { type: 'uint8', cellSize });

  // Mark cells below sea level
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (elevation.get(gx, gz) < seaLevel) {
        waterMask.set(gx, gz, 1);
      }
    }
  }

  // Convert segment tree to vector paths (single source of truth)
  // Don't pass elevation for sea-level clipping here — regional waterMask
  // should include all river cells. City-level import does its own clipping.
  const riverPaths = segmentsToVectorPaths(rivers, cellSize, {
    smoothIterations: 2,
  });

  // Paint waterMask from vector paths (smoother than raw grid cells)
  paintPathsOntoWaterMask(waterMask, riverPaths, cellSize, width, height);

  return { rivers, confluences, flowDirs, accumulation: adjustedAccumulation, waterMask, riverPaths };
}

/**
 * Carve floodplains alongside large rivers using shared profile.
 * Mild regional carving — just enough to guide flow routing.
 * Detailed channel profiles are computed at city resolution.
 */
function carveFloodplains(elevation, rivers, width, height, seaLevel) {
  function processSegment(seg) {
    for (const cell of seg.cells) {
      const acc = cell.accumulation;
      if (acc < 200) continue;

      const hw = riverHalfWidth(acc);
      const riverElev = elevation.get(cell.gx, cell.gz);
      if (riverElev < seaLevel) continue;

      // Mild channel: 0.3-1.2m (detail comes at city scale)
      const channelDepth = Math.min(1.2, Math.sqrt(acc) / 75 + 0.2);

      // Radius in grid cells to check (convert world-unit halfWidth to cells)
      const cellSize = elevation.cellSize || 50;
      const radiusCells = Math.ceil((hw + cellSize) / cellSize);

      for (let dz = -radiusCells; dz <= radiusCells; dz++) {
        for (let dx = -radiusCells; dx <= radiusCells; dx++) {
          const nx = cell.gx + dx;
          const nz = cell.gz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;

          const dist = Math.sqrt(dx * dx + dz * dz) * cellSize;
          const nd = dist / hw;
          const depthFraction = channelProfile(nd);
          if (depthFraction <= 0) continue;

          const currentElev = elevation.get(nx, nz);
          if (currentElev < seaLevel) continue;

          // Apply mild carving scaled by profile
          const carve = channelDepth * depthFraction;
          if (carve > 0.05) {
            const baseElev = Math.max(riverElev, currentElev - carve);
            elevation.set(nx, nz, Math.min(currentElev, baseElev));
          }
        }
      }
    }
    for (const child of (seg.children || [])) processSegment(child);
  }

  for (const root of rivers) processSegment(root);
}
