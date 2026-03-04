/**
 * A2. Terrain generation driven by geology.
 * Hard rock = highlands, soft rock = lowlands.
 * Geological boundaries create escarpments.
 * Per-rock noise character: granite = rugged, chalk = smooth, clay = flat.
 */

import { Grid2D } from '../core/Grid2D.js';
import { PerlinNoise } from '../core/noise.js';
import { smoothstep, clamp } from '../core/math.js';
import { getRockInfo } from './generateGeology.js';

/**
 * Generate terrain (elevation and slope) driven by geology.
 *
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.cellSize=50]
 * @param {number} [params.seaLevel=0]
 * @param {Grid2D} geology.erosionResistance
 * @param {Grid2D} geology.rockType
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{ elevation: Grid2D, slope: Grid2D }}
 */
export function generateTerrain(params, geology, rng) {
  const {
    width,
    height,
    cellSize = 50,
    seaLevel = 0,
  } = params;

  const terrainRng = rng.fork('terrain');
  const noise = new PerlinNoise(terrainRng.fork('noise'));
  const detailNoise = new PerlinNoise(terrainRng.fork('detail'));
  const ridgeNoise = new PerlinNoise(terrainRng.fork('ridge'));
  const warpNoise = new PerlinNoise(terrainRng.fork('warp'));

  const elevation = new Grid2D(width, height, { cellSize });
  const slope = new Grid2D(width, height, { cellSize });

  const { erosionResistance, rockType } = geology;

  // Smooth a copy of erosion resistance so base height transitions
  // are gradual slopes, not single-cell cliffs at rock boundaries.
  const smoothResistance = new Grid2D(width, height, { cellSize });
  for (let i = 0; i < width * height; i++) {
    smoothResistance.data[i] = erosionResistance.data[i];
  }
  smoothElevation(smoothResistance, 6);

  // --- Per-rock noise character parameters ---
  // Maps erosion resistance to noise frequency/amplitude multipliers:
  //   Hard rock (granite, r~0.9): high frequency, high amplitude → rugged terrain
  //   Medium rock (limestone, r~0.6): moderate freq/amp
  //   Soft rock (chalk, r~0.3): low frequency, low amplitude → smooth rolling
  //   Clay (r~0.2): very low → flat terrain

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const resistance = erosionResistance.get(gx, gz);
      const smoothR = smoothResistance.get(gx, gz);
      const nx = gx / width;
      const nz = gz / height;

      // Per-rock noise modulation (sharp resistance for texture detail)
      const freqMult = 0.5 + resistance * 1.0;
      const ampMult = 0.3 + resistance * 0.7;

      // Continental tilt: linear gradient from 0 at coast to 120 inland.
      // Guarantees interior is always higher than coast at macro scale.
      const coastEdges = params.coastEdges || [];
      let coastDist = 1; // default: everything is "inland"
      for (const edge of coastEdges) {
        let d;
        if (edge === 'west') d = nx;
        else if (edge === 'east') d = 1 - nx;
        else if (edge === 'north') d = nz;
        else if (edge === 'south') d = 1 - nz;
        else continue;
        coastDist = Math.min(coastDist, d);
      }
      const tilt = coastDist * 120;

      // Base elevation: gentle lift on hard rock, but keep small so
      // ridge noise shapes the mountains, not geology boundaries.
      const baseHeight = 10 + smoothR * 25;

      // Large-scale terrain undulation — mostly uniform so it doesn't
      // create geology-shaped mounds. Slight resistance boost for variety.
      const largeTerrain = noise.fbm(nx * 3, nz * 3, {
        octaves: 4,
        persistence: 0.45,
        amplitude: 40 + smoothR * 30,
      });

      // Domain-warped ridged multifractal for sharp mountain ridges.
      // Stronger warp breaks circular patterns into elongated, organic ridgelines.
      const warpX = warpNoise.fbm(nx * 3, nz * 3, { octaves: 3, amplitude: 0.25 });
      const warpZ = warpNoise.fbm(nx * 3 + 7.3, nz * 3 + 3.1, { octaves: 3, amplitude: 0.25 });
      const wnx = nx + warpX;
      const wnz = nz + warpZ;

      const ridgeHeight = ridgeNoise.ridgedMultifractal(wnx, wnz, {
        octaves: 5,
        lacunarity: 2.1,
        gain: 2.0,
        offset: 1.0,
        H: 0.9,
        frequency: 6,
        amplitude: 200,
      });

      // Medium-scale detail — modulated by rock character
      const medDetail = detailNoise.fbm(nx * 8 * freqMult, nz * 8 * freqMult, {
        octaves: 3,
        persistence: 0.4,
        amplitude: 20 * ampMult,
      });

      // Small-scale roughness — rugged on hard rock, nearly absent on clay
      const smallDetail = detailNoise.noise2D(nx * 20 * freqMult, nz * 20 * freqMult) * 8 * ampMult;

      // Blend ridge character gradually using smoothstep over a wide resistance range.
      // Ridge noise is always positive, so subtract approximate mean to avoid
      // an elevation jump at the geological boundary.
      const ridgeBlend = smoothstep(0.25, 0.7, smoothR);
      const ridgeCentered = ridgeHeight - 80;
      const terrainShape = largeTerrain + ridgeBlend * ridgeCentered;
      let h = tilt + baseHeight + terrainShape + medDetail + smallDetail;

      // Coastal falloff: geology-responsive.
      // Hard rock (granite): narrow margin → cliffs and headlands
      // Soft rock (clay): wide margin → gentle beaches and plains
      let edgeFalloff = 0;
      const baseMargin = 0.35 - smoothR * 0.3; // 0.35 (clay) → 0.05 (granite)

      for (const edge of coastEdges) {
        let edgeDist;
        if (edge === 'north') edgeDist = nz;
        else if (edge === 'south') edgeDist = 1 - nz;
        else if (edge === 'west') edgeDist = nx;
        else if (edge === 'east') edgeDist = 1 - nx;
        else continue;

        const noiseVal = noise.noise2D(
          (edge === 'north' || edge === 'south') ? nx * 3 + 10 : nz * 3 + 10,
          edge.charCodeAt(0) * 0.1,
        );
        const adjustedMargin = baseMargin + noiseVal * 0.08;

        const falloff = smoothstep(adjustedMargin, 0.0, edgeDist);
        edgeFalloff = Math.max(edgeFalloff, falloff);
      }

      // Hard rock drops steeply below sea level (deep water at cliffs);
      // soft rock has a shallow submarine shelf.
      const subSeaDepth = 10 + smoothR * 20;
      h = h * (1 - edgeFalloff) + seaLevel * edgeFalloff - edgeFalloff * subSeaDepth;

      elevation.set(gx, gz, h);
    }
  }

  // Power-curve: lift peaks, compress valleys for more dramatic relief
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < width * height; i++) {
    const v = elevation.data[i];
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  const rangeH = maxH - minH || 1;
  for (let i = 0; i < width * height; i++) {
    const normalized = (elevation.data[i] - minH) / rangeH;
    elevation.data[i] = minH + Math.pow(normalized, 1.4) * rangeH;
  }

  // Escarpments: smoothed resistance already creates gradual transitions.
  // Only apply light escarpments at strong boundaries for extra definition.
  applyEscarpments(elevation, rockType, erosionResistance, width, height);

  // Compute slope
  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      const dhdx = (elevation.get(gx + 1, gz) - elevation.get(gx - 1, gz)) / (2 * cellSize);
      const dhdz = (elevation.get(gx, gz + 1) - elevation.get(gx, gz - 1)) / (2 * cellSize);
      const s = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
      slope.set(gx, gz, s);
    }
  }

  return { elevation, slope };
}

/**
 * Apply escarpments at rock type boundaries.
 * Where a hard rock cell meets a softer rock neighbor, lower the soft side
 * to create a cliff/scarp effect. The magnitude depends on cliffTendency.
 */
function applyEscarpments(elevation, rockType, erosionResistance, width, height) {
  // Collect adjustments first, then apply (avoid order-dependency)
  const adjustments = new Float32Array(width * height);

  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      const myType = rockType.get(gx, gz);
      const myResistance = erosionResistance.get(gx, gz);
      const myRock = getRockInfo(myType);
      const cliffTendency = myRock.cliffTendency || 0;

      // Check 4-connected neighbors for rock type changes
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = gx + dx;
        const nz = gz + dz;
        const neighborType = rockType.get(nx, nz);

        if (neighborType === myType) continue;

        const neighborResistance = erosionResistance.get(nx, nz);
        const resistanceDiff = myResistance - neighborResistance;

        // If this cell is softer than its neighbor, lower it (scarp foot)
        if (resistanceDiff < -0.15) {
          const neighborRock = getRockInfo(neighborType);
          const neighborCliff = neighborRock.cliffTendency || 0;
          const scarpStrength = Math.abs(resistanceDiff) * Math.max(cliffTendency, neighborCliff);
          // Subtle additional scarp at strong geological boundaries
          adjustments[gz * width + gx] = Math.min(
            adjustments[gz * width + gx],
            -scarpStrength * 8,
          );
        }
      }
    }
  }

  // Apply adjustments
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const adj = adjustments[gz * width + gx];
      if (adj !== 0) {
        elevation.set(gx, gz, elevation.get(gx, gz) + adj);
      }
    }
  }
}

/**
 * Simple box-blur smoothing pass.
 */
function smoothElevation(grid, iterations) {
  const w = grid.width;
  const h = grid.height;
  const tmp = new Float32Array(w * h);

  for (let iter = 0; iter < iterations; iter++) {
    // Copy to tmp with smoothing
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        let sum = 0;
        let count = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += grid.get(gx + dx, gz + dz);
            count++;
          }
        }
        tmp[gz * w + gx] = sum / count;
      }
    }

    // Copy back
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        grid.set(gx, gz, tmp[gz * w + gx]);
      }
    }
  }
}
