/**
 * Regional terrain generation.
 * Produces a coarse heightmap (~100km^2 at 100m/cell resolution)
 * with optional coastal edges and percentile-based sea level.
 * When geology is provided, terrain characteristics vary by rock type.
 */
import { Heightmap } from '../core/heightmap.js';
import { PerlinNoise } from '../core/noise.js';
import { lerp, smoothstep, clamp } from '../core/math.js';
import { ROCK_PROPERTIES } from './geology.js';

// Per-rock-type terrain modulation tables.
// Index matches ROCK_TYPES enum (0=IGNEOUS..4=ALLUVIAL).
const ELEV_SCALE    = [0.70, 0.45, 0.15, 0.30, 0.05]; // base elevation multiplier
const AMP_SCALE     = [1.50, 1.00, 0.50, 0.60, 0.30]; // noise amplitude multiplier
const FREQ_SCALE    = [1.60, 1.00, 0.60, 0.80, 0.50]; // noise frequency multiplier
const OCTAVE_COUNT  = [5,    4,    3,    2,    2   ];  // octave count per rock type

/**
 * Generate regional terrain.
 * @param {object} params
 * @param {number} [params.gridSize=512]
 * @param {number} [params.cellSize=200]
 * @param {number} [params.mountainousness=0.5]
 * @param {number} [params.roughness=0.5]
 * @param {string[]} [params.coastEdges=[]]
 * @param {number} [params.seaLevelPercentile=0.35]
 * @param {number} [params.erosionResistanceContrast=0.7]
 * @param {number} [params.coastalErosionIntensity=0.6]
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object|null} geology - GeologyData or null
 * @returns {{ heightmap: Heightmap, seaLevel: number }}
 */
export function generateRegionalTerrain(params, rng, geology = null) {
  const {
    gridSize = 512,
    cellSize = 200,
    mountainousness = 0.5,
    roughness = 0.5,
    coastEdges = [],
    seaLevelPercentile = 0.35,
    erosionResistanceContrast = 0.7,
    coastalErosionIntensity = 0.6,
  } = params;

  const heightmap = new Heightmap(gridSize, gridSize, cellSize);
  const terrainRng = rng.fork('terrain');
  const noise = new PerlinNoise(terrainRng);

  const contrast = geology ? clamp(erosionResistanceContrast, 0, 1) : 0;

  // --- 1. Fill heightmap with fBm noise ---
  const baseAmplitude = lerp(20, 200, clamp(mountainousness, 0, 1));
  const freqMultiplier = lerp(0.6, 1.8, clamp(roughness, 0, 1));
  const baseFrequency = (1 / gridSize) * freqMultiplier;

  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      let amp = baseAmplitude;
      let freq = baseFrequency;
      let octaves = 4;

      if (geology) {
        const rockType = geology.rockTypes[gz * gridSize + gx];
        // Lerp between default (1.0) and rock-specific scale by contrast
        amp *= lerp(1.0, AMP_SCALE[rockType], contrast);
        freq *= lerp(1.0, FREQ_SCALE[rockType], contrast);
        octaves = Math.round(lerp(4, OCTAVE_COUNT[rockType], contrast));
      }

      let value = noise.fbm(gx, gz, {
        octaves,
        lacunarity: 2.0,
        persistence: 0.5,
        amplitude: amp,
        frequency: freq,
      });

      // Geology base elevation offset: shift the whole cell up/down by rock type
      if (geology) {
        const rockType = geology.rockTypes[gz * gridSize + gx];
        const elevOffset = lerp(0, (ELEV_SCALE[rockType] - 0.3) * baseAmplitude, contrast);
        value += elevOffset;
      }

      heightmap.set(gx, gz, value);
    }
  }

  // --- 1b. Escarpment detection: depress soft side of spring line ---
  if (geology) {
    const { springLine, rockTypes } = geology;

    for (let gz = 1; gz < gridSize - 1; gz++) {
      for (let gx = 1; gx < gridSize - 1; gx++) {
        const idx = gz * gridSize + gx;
        if (!springLine[idx]) continue;

        const myRes = ROCK_PROPERTIES[rockTypes[idx]].erosionResistance;

        // Find max resistance difference to neighbors
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = gx + dx;
            const nz = gz + dz;
            const nIdx = nz * gridSize + nx;
            const nRes = ROCK_PROPERTIES[rockTypes[nIdx]].erosionResistance;

            // If the neighbor is softer, depress it
            if (nRes < myRes) {
              const diff = myRes - nRes;
              const depression = diff * baseAmplitude * 0.3 * contrast;
              const currentElev = heightmap.get(nx, nz);
              heightmap.set(nx, nz, currentElev - depression);
            }
          }
        }
      }
    }
  }

  // --- 2. Apply coastal falloff over the outer 30% of the map on coast edges ---
  if (coastEdges.length > 0) {
    const coastFalloffWidth = gridSize * 0.3;
    const coastDepression = baseAmplitude * 0.8;
    const coastNoiseRng = rng.fork('coastNoise');
    const coastNoise = new PerlinNoise(coastNoiseRng);
    const coastIntensity = geology ? clamp(coastalErosionIntensity, 0, 1) : 0;

    for (let gz = 0; gz < gridSize; gz++) {
      for (let gx = 0; gx < gridSize; gx++) {
        let minFactor = 1.0; // 1 = no coast effect, 0 = full coast

        for (const edge of coastEdges) {
          let distFromEdge;
          let coastCoord;

          switch (edge) {
            case 'south':
              distFromEdge = gridSize - 1 - gz;
              coastCoord = gx;
              break;
            case 'north':
              distFromEdge = gz;
              coastCoord = gx;
              break;
            case 'west':
              distFromEdge = gx;
              coastCoord = gz;
              break;
            case 'east':
              distFromEdge = gridSize - 1 - gx;
              coastCoord = gz;
              break;
            default:
              continue;
          }

          // 1D noise warps the coastline to create bays and headlands
          const warpAmplitude = coastFalloffWidth * 0.3;
          const warpFreq = 3.0 / gridSize;
          const warp = coastNoise.noise2D(coastCoord * warpFreq, 0.5) * warpAmplitude;
          const effectiveDist = distFromEdge + warp;

          let factor = smoothstep(0, coastFalloffWidth, effectiveDist);

          // Geology: hard rock resists coastal erosion (headlands),
          // soft rock erodes further inland (bays)
          if (geology) {
            const idx = gz * gridSize + gx;
            const res = ROCK_PROPERTIES[geology.rockTypes[idx]].erosionResistance;
            // Bias factor: hard rock pushes toward 1 (headland), soft toward 0 (bay)
            const bias = (res - 0.5) * 2 * coastIntensity; // [-1, 1] scaled
            factor = clamp(factor + bias * 0.15, 0, 1);
          }

          if (factor < minFactor) {
            minFactor = factor;
          }
        }

        if (minFactor < 1.0) {
          let elev = heightmap.get(gx, gz);
          elev *= minFactor;
          elev -= coastDepression * (1.0 - minFactor);
          heightmap.set(gx, gz, elev);
        }
      }
    }
  }

  // --- 3. Compute sea level as percentile of all elevation values ---
  const allElevations = [];
  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      allElevations.push(heightmap.get(gx, gz));
    }
  }
  allElevations.sort((a, b) => a - b);

  const percentileIndex = Math.floor(allElevations.length * clamp(seaLevelPercentile, 0, 1));
  const seaLevel = allElevations[Math.min(percentileIndex, allElevations.length - 1)];

  // DO NOT freeze the heightmap -- fillSinks needs to modify it

  return { heightmap, seaLevel };
}
