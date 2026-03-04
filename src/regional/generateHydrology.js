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
  const rivers = extractStreams(adjustedAccumulation, flowDirs, filledElev, thresholds);

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

  // Mark river cells
  function markRiver(seg) {
    for (const c of seg.cells) {
      waterMask.set(c.gx, c.gz, 1);
    }
    for (const child of (seg.children || [])) {
      markRiver(child);
    }
  }
  for (const root of rivers) markRiver(root);

  return { rivers, confluences, flowDirs, accumulation: adjustedAccumulation, waterMask };
}

/**
 * Carve floodplains alongside large rivers.
 * Finds cells within a width proportional to accumulation and flattens
 * them to near the river's elevation.
 */
function carveFloodplains(elevation, rivers, width, height, seaLevel) {
  function processSegment(seg) {
    for (const cell of seg.cells) {
      const acc = cell.accumulation;
      // Only carve floodplains for rivers with significant accumulation
      if (acc < 200) continue;

      // Floodplain half-width: proportional to sqrt(accumulation), capped
      const halfWidth = Math.min(4, Math.floor(Math.sqrt(acc) / 15) + 1);
      const riverElev = elevation.get(cell.gx, cell.gz);

      // Only carve on land above sea level
      if (riverElev < seaLevel) continue;

      // Carve the river channel itself
      if (acc >= 200) {
        const channelDepth = Math.min(3, Math.sqrt(acc) / 30 + 0.5);
        elevation.set(cell.gx, cell.gz, riverElev - channelDepth);
      }

      for (let dz = -halfWidth; dz <= halfWidth; dz++) {
        for (let dx = -halfWidth; dx <= halfWidth; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cell.gx + dx;
          const nz = cell.gz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;

          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist > halfWidth) continue;

          const currentElev = elevation.get(nx, nz);
          // Only lower terrain, never raise it
          if (currentElev <= riverElev) continue;

          // Blend: close to river = nearly flat, further away = partial blend
          const blend = 1.0 - dist / (halfWidth + 1);
          const targetElev = riverElev + (currentElev - riverElev) * (1.0 - blend * 0.7);
          elevation.set(nx, nz, targetElev);
        }
      }
    }
    for (const child of (seg.children || [])) processSegment(child);
  }

  for (const root of rivers) processSegment(root);
}
