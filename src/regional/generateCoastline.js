/**
 * A4. Coastline refinement via differential erosion.
 * Hard rock resists erosion → headlands with cliff faces.
 * Soft rock erodes → bays and shallow shelves.
 * River mouths → smooth estuaries.
 * Feature tagging: identifies bays, headlands, and potential harbors.
 * Basic bathymetry: underwater depth shaped by rock hardness.
 */

import { Grid2D } from '../core/Grid2D.js';
import { smoothstep, clamp } from '../core/math.js';

/**
 * Apply differential coastal erosion to the elevation grid.
 * Modifies elevation in place. Returns coastline features data.
 *
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.seaLevel=0]
 * @param {number} [params.erosionIntensity=8] - How much soft rock is eroded
 * @param {Grid2D} elevation
 * @param {Grid2D} erosionResistance
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{ coastlineFeatures: Array }}
 */
export function generateCoastline(params, elevation, erosionResistance, rng) {
  const {
    width,
    height,
    seaLevel = 0,
    erosionIntensity = 8,
  } = params;

  // Identify coastal cells and apply differential erosion
  // Soft rock near the coast gets lowered (creating bays)
  // Hard rock resists (creating headlands)

  const erosionAmount = new Grid2D(width, height);

  // Multiple passes of coastal erosion (simulating wave action over time)
  for (let pass = 0; pass < 3; pass++) {
    for (let gz = 1; gz < height - 1; gz++) {
      for (let gx = 1; gx < width - 1; gx++) {
        const h = elevation.get(gx, gz);
        if (h < seaLevel - 5) continue; // deep water, no erosion
        if (h > seaLevel + 20) continue; // too far inland

        // Check if this cell is near water
        let nearWater = false;
        let waterCount = 0;
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          if (elevation.get(gx + dx, gz + dz) < seaLevel) {
            nearWater = true;
            waterCount++;
          }
        }

        if (!nearWater) continue;

        const resistance = erosionResistance.get(gx, gz);
        // Erosion inversely proportional to resistance
        const erosion = erosionIntensity * (1 - resistance) * (waterCount / 8);

        // Apply erosion (lower the land)
        if (h >= seaLevel) {
          const newH = h - erosion;
          erosionAmount.set(gx, gz, erosion);
          elevation.set(gx, gz, newH);
        }
      }
    }
  }

  // --- Cliff generation on hard rock ---
  // Where coastline meets hard rock (high erosion resistance), steepen
  // the terrain near the coast to create cliff faces.
  applyCoastalCliffs(elevation, erosionResistance, seaLevel, width, height);

  // --- Basic bathymetry ---
  // For underwater cells near coast, shape depth by rock hardness.
  // Hard rock coast = deep water close to shore (steep submarine cliff).
  // Soft rock coast = shallow shelf extending outward.
  applyBathymetry(elevation, erosionResistance, seaLevel, width, height);

  // Smooth transitions near the coastline for natural-looking bays
  smoothCoast(elevation, seaLevel, width, height);

  // --- Feature tagging ---
  // Walk the coastline and classify stretches into bays, headlands, harbors.
  const coastlineFeatures = tagCoastlineFeatures(elevation, erosionResistance, seaLevel, width, height);

  return { coastlineFeatures };
}

/**
 * Steepen terrain near the coast where hard rock is present.
 * Creates cliff-face effects by raising the land side of hard-rock coastlines.
 */
function applyCoastalCliffs(elevation, erosionResistance, seaLevel, width, height) {
  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      const h = elevation.get(gx, gz);
      if (h < seaLevel || h > seaLevel + 15) continue;

      const resistance = erosionResistance.get(gx, gz);
      if (resistance < 0.5) continue; // only affect hard rock

      // Check if coastal (adjacent to water)
      let isCoastal = false;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (elevation.get(gx + dx, gz + dz) < seaLevel) {
          isCoastal = true;
          break;
        }
      }
      if (!isCoastal) continue;

      // Raise inland cells near hard-rock coast to create steep cliff
      // The amount depends on how resistant the rock is
      const cliffBoost = (resistance - 0.5) * 10; // up to +5m for granite
      elevation.set(gx, gz, h + cliffBoost);
    }
  }
}

/**
 * Shape underwater terrain near the coast based on rock hardness.
 */
function applyBathymetry(elevation, erosionResistance, seaLevel, width, height) {
  // Compute distance-to-coast for underwater cells
  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      const h = elevation.get(gx, gz);
      if (h >= seaLevel) continue;

      // Find nearest coastal resistance
      let nearestCoastResistance = -1;
      let nearestDist = Infinity;
      const searchR = 6;
      for (let dz = -searchR; dz <= searchR; dz++) {
        for (let dx = -searchR; dx <= searchR; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
          if (elevation.get(nx, nz) < seaLevel) continue;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestCoastResistance = erosionResistance.get(nx, nz);
          }
        }
      }

      if (nearestCoastResistance < 0 || nearestDist > searchR) continue;

      // Hard rock: deeper water close to shore (steep drop-off)
      // Soft rock: shallow shelf (gentle slope)
      const depthFactor = 0.3 + nearestCoastResistance * 0.7; // 0.3 (soft) to 1.0 (hard)
      const targetDepth = seaLevel - nearestDist * depthFactor * 3;

      // Only deepen, never raise underwater terrain above what it already is
      if (targetDepth < h) {
        elevation.set(gx, gz, h * 0.6 + targetDepth * 0.4);
      }
    }
  }
}

/**
 * Gentle smoothing of near-coast terrain.
 */
function smoothCoast(elevation, seaLevel, width, height) {
  const coastBand = 5; // cells

  for (let gz = coastBand; gz < height - coastBand; gz++) {
    for (let gx = coastBand; gx < width - coastBand; gx++) {
      const h = elevation.get(gx, gz);
      if (h < seaLevel - 10 || h > seaLevel + 15) continue;

      // Average with neighbors
      let sum = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += elevation.get(gx + dx, gz + dz);
          count++;
        }
      }

      // Blend toward smoothed value
      const smoothed = sum / count;
      elevation.set(gx, gz, h * 0.7 + smoothed * 0.3);
    }
  }
}

/**
 * Walk the coastline and tag features: bays, headlands, potential harbors.
 * Uses local curvature of the coastline and rock type to classify.
 *
 * @returns {Array<{type: string, gx: number, gz: number, resistance: number}>}
 */
function tagCoastlineFeatures(elevation, erosionResistance, seaLevel, width, height) {
  const features = [];
  const coastCells = [];

  // Collect all coastal land cells
  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      if (elevation.get(gx, gz) < seaLevel) continue;

      let isCoastal = false;
      let waterNeighbors = 0;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (elevation.get(gx + dx, gz + dz) < seaLevel) {
          isCoastal = true;
          waterNeighbors++;
        }
      }
      if (isCoastal) {
        coastCells.push({
          gx, gz,
          resistance: erosionResistance.get(gx, gz),
          waterNeighbors,
        });
      }
    }
  }

  // Classify each coastal cell by local geometry
  for (const cell of coastCells) {
    // Headland: convex protrusion on hard rock (many water neighbors, high resistance)
    if (cell.resistance > 0.5 && cell.waterNeighbors >= 4) {
      features.push({
        type: 'headland',
        gx: cell.gx,
        gz: cell.gz,
        resistance: cell.resistance,
      });
    }
    // Bay: concave stretch on soft rock (few water neighbors = inset into land)
    else if (cell.resistance < 0.4 && cell.waterNeighbors <= 2) {
      features.push({
        type: 'bay',
        gx: cell.gx,
        gz: cell.gz,
        resistance: cell.resistance,
      });
    }
  }

  // Identify potential harbors: bay cells that are sheltered
  // (near headlands that would block waves)
  for (const feature of features) {
    if (feature.type !== 'bay') continue;

    // Check for nearby headlands (shelter)
    let nearHeadland = false;
    for (const other of features) {
      if (other.type !== 'headland') continue;
      const dist = Math.sqrt(
        (feature.gx - other.gx) ** 2 + (feature.gz - other.gz) ** 2,
      );
      if (dist < 10) {
        nearHeadland = true;
        break;
      }
    }

    // Check for deep water nearby (navigability)
    let hasDeepWater = false;
    for (let dz = -5; dz <= 5; dz++) {
      for (let dx = -5; dx <= 5; dx++) {
        const nx = feature.gx + dx;
        const nz = feature.gz + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
        if (elevation.get(nx, nz) < seaLevel - 5) {
          hasDeepWater = true;
          break;
        }
      }
      if (hasDeepWater) break;
    }

    if (nearHeadland || hasDeepWater) {
      features.push({
        type: 'harbor',
        gx: feature.gx,
        gz: feature.gz,
        resistance: feature.resistance,
      });
    }
  }

  return features;
}
