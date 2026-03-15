/**
 * A2. Terrain generation driven by geology and tectonics.
 * Hard rock = highlands, soft rock = lowlands.
 * Geological boundaries create escarpments.
 * Per-rock noise character: granite = rugged, chalk = smooth, clay = flat.
 */

import { Grid2D } from '../core/Grid2D.js';
import { PerlinNoise } from '../core/noise.js';
import { smoothstep, clamp } from '../core/math.js';
import { getRockInfo } from './generateGeology.js';

// --- Tuning constants ---

// Resistance smoothing iterations (box blur)
const RESISTANCE_SMOOTH_PASSES = 6;

// Per-rock noise modulation: frequency = BASE + resistance * SCALE
const ROCK_FREQ_BASE = 0.5;
const ROCK_FREQ_SCALE = 1.0;
const ROCK_AMP_BASE = 0.3;
const ROCK_AMP_SCALE = 0.7;

// Continental tilt (meters): BASE + intensity * SCALE
const TILT_BASE = 80;
const TILT_SCALE = 220;

// Base elevation from geology: BASE + smoothResistance * SCALE
const BASE_HEIGHT_MIN = 10;
const BASE_HEIGHT_SCALE = 25;

// Mountain ridge noise parameters
const MOUNTAIN_WARP_FREQ = 2;
const MOUNTAIN_WARP_AMP = 0.15;
const MOUNTAIN_WARP_OCTAVES = 3;
const MOUNTAIN_STRETCH_ALONG = 0.4;  // low freq along ridges (elongated)
const MOUNTAIN_STRETCH_ACROSS = 1.0; // higher freq across ridges (sharper)
const MOUNTAIN_NOISE_OCTAVES = 4;
const MOUNTAIN_NOISE_LACUNARITY = 2.2;
const MOUNTAIN_NOISE_GAIN = 2.0;
const MOUNTAIN_NOISE_OFFSET = 1.0;
const MOUNTAIN_NOISE_H = 0.85;
const MOUNTAIN_NOISE_FREQ = 1.8;

// Asymmetric profile
const ASYM_OFFSET = 0.03;        // normalized sample offset
const ASYM_MAX_STRENGTH = 0.3;   // blended with intensity

// Mountain field centering (fraction of amplitude to subtract)
const MOUNTAIN_CENTER_FRAC = 0.35;

// Detail modulation: BASE + mountainInfluence * detailRidgeStrength * SCALE
const DETAIL_MOD_BASE = 0.3;
const DETAIL_MOD_SCALE = 0.7;

// Large-scale terrain undulation
const LARGE_TERRAIN_FREQ = 3;
const LARGE_TERRAIN_OCTAVES = 4;
const LARGE_TERRAIN_PERSISTENCE = 0.45;
const LARGE_TERRAIN_AMP_BASE = 40;
const LARGE_TERRAIN_AMP_ROCK = 30;  // scaled by smoothResistance
const LARGE_TERRAIN_AMP_INTENSITY = 60; // scaled by intensity

// Detail ridge noise
const DETAIL_WARP_FREQ = 3;
const DETAIL_WARP_AMP = 0.25;
const DETAIL_WARP_OCTAVES = 3;
const DETAIL_RIDGE_OCTAVES = 5;
const DETAIL_RIDGE_LACUNARITY = 2.1;
const DETAIL_RIDGE_GAIN = 2.0;
const DETAIL_RIDGE_OFFSET = 1.0;
const DETAIL_RIDGE_H = 0.9;
const DETAIL_RIDGE_FREQ = 6;
const DETAIL_RIDGE_AMP_BASE = 100;
const DETAIL_RIDGE_AMP_SCALE = 400;  // 100–500m with intensity
const DETAIL_RIDGE_CENTER_FRAC = 0.4;

// Medium-scale detail
const MED_DETAIL_FREQ = 8;
const MED_DETAIL_OCTAVES = 3;
const MED_DETAIL_PERSISTENCE = 0.4;
const MED_DETAIL_AMP = 20;

// Small-scale roughness
const SMALL_DETAIL_FREQ = 20;
const SMALL_DETAIL_AMP = 8;

// Ridge blend with geology (smoothstep range on resistance)
const RIDGE_BLEND_LOW = 0.25;
const RIDGE_BLEND_HIGH = 0.7;

// Coast field: contour-based coastline shaping
const COAST_BAY_WARP_FREQ = 2;     // domain warp for organic shapes
const COAST_BAY_WARP_AMP = 0.12;
const COAST_BAY_WARP_OCTAVES = 3;
const COAST_BAY_FREQ = 4;          // large bays/headlands
const COAST_BAY_OCTAVES = 4;
const COAST_BAY_PERSISTENCE = 0.5;
const COAST_BAY_AMP = 0.13;        // normalized — ~13% of map width
const COAST_DETAIL_FREQ = 10;      // smaller coastal indentations
const COAST_DETAIL_AMP = 0.03;
const COAST_GEO_STRENGTH = 0.05;   // geology headland/bay influence
const COAST_FALLOFF_WIDTH = 0.06;  // how quickly elevation drops into ocean
const SUB_SEA_DEPTH_BASE = 10;
const SUB_SEA_DEPTH_SCALE = 20;

// Power curve: BASE + intensity * SCALE exponent
const POWER_CURVE_BASE = 1.3;
const POWER_CURVE_SCALE = 0.4;

// Escarpment strength
const ESCARP_RESISTANCE_THRESHOLD = 0.15;
const ESCARP_STRENGTH_MULT = 8;

/**
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.cellSize=50]
 * @param {number} [params.seaLevel=0]
 * @param {object} [params.tectonics] - Tectonic context from generateTectonics
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
    tectonics,
    corridorInfluence,
  } = params;

  const terrainRng = rng.fork('terrain');
  const noise = new PerlinNoise(terrainRng.fork('noise'));
  const detailNoise = new PerlinNoise(terrainRng.fork('detail'));
  const ridgeNoise = new PerlinNoise(terrainRng.fork('ridge'));
  const warpNoise = new PerlinNoise(terrainRng.fork('warp'));
  const mountainNoise = new PerlinNoise(terrainRng.fork('mountain'));
  const mountainWarp = new PerlinNoise(terrainRng.fork('mountainWarp'));
  const coastNoise = new PerlinNoise(terrainRng.fork('coast'));

  // Tectonic context (defaults for backward compatibility)
  const ridgeAngle = tectonics?.ridgeAngle ?? 0;
  const ridgeAmplitude = tectonics?.ridgeAmplitude ?? 100;
  const detailRidgeStrength = tectonics?.detailRidgeStrength ?? 0.6;
  const asymmetryDir = tectonics?.asymmetryDir ?? { x: 1, z: 0 };
  const intensity = tectonics?.intensity ?? 0.5;
  const coastalShelfWidth = tectonics?.coastalShelfWidth ?? 0.2;

  // Direction vectors for stretching noise along ridge axis
  const ridgeDirX = Math.cos(ridgeAngle);  // along ridges
  const ridgeDirZ = Math.sin(ridgeAngle);
  const ridgePerpX = -ridgeDirZ;           // across ridges
  const ridgePerpZ = ridgeDirX;

  const elevation = new Grid2D(width, height, { cellSize });
  const slope = new Grid2D(width, height, { cellSize });

  const { erosionResistance, rockType } = geology;

  // Smooth a copy of erosion resistance so base height transitions
  // are gradual slopes, not single-cell cliffs at rock boundaries.
  const smoothResistance = new Grid2D(width, height, { cellSize });
  for (let i = 0; i < width * height; i++) {
    smoothResistance.data[i] = erosionResistance.data[i];
  }
  smoothElevation(smoothResistance, RESISTANCE_SMOOTH_PASSES);

  // Coast edges from tectonics or params
  const coastEdges = tectonics?.coastEdges || params.coastEdges || [];

  // Continental tilt height
  const tiltHeight = TILT_BASE + intensity * TILT_SCALE;

  // === Pre-compute coast field ===
  // Contour-based coastline: positive = land, negative = ocean.
  // The zero-crossing defines the coastline shape.
  const coastField = _buildCoastField(
    width, height, coastEdges, coastalShelfWidth, smoothResistance, coastNoise,
  );

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const resistance = erosionResistance.get(gx, gz);
      const smoothR = smoothResistance.get(gx, gz);
      const nx = gx / width;
      const nz = gz / height;

      // Per-rock noise modulation (sharp resistance for texture detail)
      const freqMult = ROCK_FREQ_BASE + resistance * ROCK_FREQ_SCALE;
      const ampMult = ROCK_AMP_BASE + resistance * ROCK_AMP_SCALE;

      // Continental tilt from coast field (positive part only)
      const cf = coastField.get(gx, gz);
      const tilt = Math.max(0, cf) * tiltHeight;

      // Base elevation: gentle lift on hard rock
      const baseHeight = BASE_HEIGHT_MIN + smoothR * BASE_HEIGHT_SCALE;

      // === Large-scale mountain ranges (tectonic-driven) ===
      const projAlong = nx * ridgeDirX + nz * ridgeDirZ;
      const projAcross = nx * ridgePerpX + nz * ridgePerpZ;

      // Domain warp for organic ridge shapes
      const mWarpX = mountainWarp.fbm(nx * MOUNTAIN_WARP_FREQ, nz * MOUNTAIN_WARP_FREQ, {
        octaves: MOUNTAIN_WARP_OCTAVES, amplitude: MOUNTAIN_WARP_AMP,
      });
      const mWarpZ = mountainWarp.fbm(nx * MOUNTAIN_WARP_FREQ + 5.7, nz * MOUNTAIN_WARP_FREQ + 3.3, {
        octaves: MOUNTAIN_WARP_OCTAVES, amplitude: MOUNTAIN_WARP_AMP,
      });

      // Stretched coordinates: elongated along ridges, sharper across
      const stretchedX = (projAlong * MOUNTAIN_STRETCH_ALONG + projAcross * MOUNTAIN_STRETCH_ACROSS) + mWarpX;
      const stretchedZ = (projAlong * MOUNTAIN_STRETCH_ALONG - projAcross * MOUNTAIN_STRETCH_ACROSS) + mWarpZ;

      const mountainField = mountainNoise.ridgedMultifractal(stretchedX, stretchedZ, {
        octaves: MOUNTAIN_NOISE_OCTAVES,
        lacunarity: MOUNTAIN_NOISE_LACUNARITY,
        gain: MOUNTAIN_NOISE_GAIN,
        offset: MOUNTAIN_NOISE_OFFSET,
        H: MOUNTAIN_NOISE_H,
        frequency: MOUNTAIN_NOISE_FREQ,
        amplitude: ridgeAmplitude,
      });

      // Asymmetric profile: steeper on the compression-facing side
      const asymNx = nx + asymmetryDir.x * ASYM_OFFSET;
      const asymNz = nz + asymmetryDir.z * ASYM_OFFSET;
      const asymProjAlong = asymNx * ridgeDirX + asymNz * ridgeDirZ;
      const asymProjAcross = asymNx * ridgePerpX + asymNz * ridgePerpZ;
      const asymStretchedX = (asymProjAlong * MOUNTAIN_STRETCH_ALONG + asymProjAcross * MOUNTAIN_STRETCH_ACROSS) + mWarpX;
      const asymStretchedZ = (asymProjAlong * MOUNTAIN_STRETCH_ALONG - asymProjAcross * MOUNTAIN_STRETCH_ACROSS) + mWarpZ;

      const mountainFieldOffset = mountainNoise.ridgedMultifractal(asymStretchedX, asymStretchedZ, {
        octaves: MOUNTAIN_NOISE_OCTAVES,
        lacunarity: MOUNTAIN_NOISE_LACUNARITY,
        gain: MOUNTAIN_NOISE_GAIN,
        offset: MOUNTAIN_NOISE_OFFSET,
        H: MOUNTAIN_NOISE_H,
        frequency: MOUNTAIN_NOISE_FREQ,
        amplitude: ridgeAmplitude,
      });

      const asymStrength = ASYM_MAX_STRENGTH * intensity;
      const mountainHeight = mountainField * (1 - asymStrength) + mountainFieldOffset * asymStrength;
      const mountainCentered = mountainHeight - ridgeAmplitude * MOUNTAIN_CENTER_FRAC;

      // === Detail terrain, modulated by mountain field ===
      const mountainInfluence = clamp(mountainHeight / ridgeAmplitude, 0, 1);
      const detailMod = DETAIL_MOD_BASE + mountainInfluence * detailRidgeStrength * DETAIL_MOD_SCALE;

      // Large-scale terrain undulation
      const largeTerrainAmp = (LARGE_TERRAIN_AMP_BASE + smoothR * LARGE_TERRAIN_AMP_ROCK + intensity * LARGE_TERRAIN_AMP_INTENSITY) * detailMod;
      const largeTerrain = noise.fbm(nx * LARGE_TERRAIN_FREQ, nz * LARGE_TERRAIN_FREQ, {
        octaves: LARGE_TERRAIN_OCTAVES,
        persistence: LARGE_TERRAIN_PERSISTENCE,
        amplitude: largeTerrainAmp,
      });

      // Domain-warped ridged multifractal for detail ridges
      const warpX = warpNoise.fbm(nx * DETAIL_WARP_FREQ, nz * DETAIL_WARP_FREQ, {
        octaves: DETAIL_WARP_OCTAVES, amplitude: DETAIL_WARP_AMP,
      });
      const warpZ = warpNoise.fbm(nx * DETAIL_WARP_FREQ + 7.3, nz * DETAIL_WARP_FREQ + 3.1, {
        octaves: DETAIL_WARP_OCTAVES, amplitude: DETAIL_WARP_AMP,
      });

      const detailRidgeAmp = (DETAIL_RIDGE_AMP_BASE + intensity * DETAIL_RIDGE_AMP_SCALE) * detailMod;
      const ridgeHeight = ridgeNoise.ridgedMultifractal(nx + warpX, nz + warpZ, {
        octaves: DETAIL_RIDGE_OCTAVES,
        lacunarity: DETAIL_RIDGE_LACUNARITY,
        gain: DETAIL_RIDGE_GAIN,
        offset: DETAIL_RIDGE_OFFSET,
        H: DETAIL_RIDGE_H,
        frequency: DETAIL_RIDGE_FREQ,
        amplitude: detailRidgeAmp,
      });

      // Medium-scale detail — modulated by rock character
      const medDetail = detailNoise.fbm(nx * MED_DETAIL_FREQ * freqMult, nz * MED_DETAIL_FREQ * freqMult, {
        octaves: MED_DETAIL_OCTAVES,
        persistence: MED_DETAIL_PERSISTENCE,
        amplitude: MED_DETAIL_AMP * ampMult,
      });

      // Small-scale roughness — rugged on hard rock, nearly absent on clay
      const smallDetail = detailNoise.noise2D(nx * SMALL_DETAIL_FREQ * freqMult, nz * SMALL_DETAIL_FREQ * freqMult) * SMALL_DETAIL_AMP * ampMult;

      // Blend detail ridges with geology
      const ridgeBlend = smoothstep(RIDGE_BLEND_LOW, RIDGE_BLEND_HIGH, smoothR);
      const ridgeCentered = ridgeHeight - detailRidgeAmp * DETAIL_RIDGE_CENTER_FRAC;
      const terrainShape = largeTerrain + ridgeBlend * ridgeCentered;

      // River corridor suppression: reduce mountain height along planned corridors
      // so major rivers have natural gaps through mountain ranges.
      let mountainContrib = mountainCentered;
      if (corridorInfluence) {
        const ci = corridorInfluence.get(gx, gz);
        if (ci > 0) {
          mountainContrib *= (1 - ci);
          // Also depress base elevation along corridor
          // (ensures flow routing follows the corridor even in flat areas)
        }
      }

      // Combine: tilt + base + mountains + detail
      const corridorDepress = corridorInfluence ? corridorInfluence.get(gx, gz) * 15 : 0;
      let h = tilt + baseHeight + mountainContrib + terrainShape + medDetail + smallDetail - corridorDepress;

      // Coastal falloff from coast field
      // cf < 0 = ocean; ramp elevation down from coastline into ocean
      const falloffWidth = COAST_FALLOFF_WIDTH + smoothR * COAST_FALLOFF_WIDTH;
      const edgeFalloff = coastEdges.length > 0
        ? clamp(smoothstep(falloffWidth, 0, cf), 0, 1)
        : 0;

      const subSeaDepth = SUB_SEA_DEPTH_BASE + smoothR * SUB_SEA_DEPTH_SCALE;
      h = h * (1 - edgeFalloff) + seaLevel * edgeFalloff - edgeFalloff * subSeaDepth;

      elevation.set(gx, gz, h);
    }
  }

  // Power-curve: lift peaks, compress valleys for more dramatic relief
  const powerExp = POWER_CURVE_BASE + intensity * POWER_CURVE_SCALE;
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < width * height; i++) {
    const v = elevation.data[i];
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  const rangeH = maxH - minH || 1;
  for (let i = 0; i < width * height; i++) {
    const normalized = (elevation.data[i] - minH) / rangeH;
    elevation.data[i] = minH + Math.pow(normalized, powerExp) * rangeH;
  }

  // Escarpments at rock type boundaries
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
 * Build a coast field grid: positive = land, negative = ocean.
 * The zero-crossing defines the coastline with organic bays and headlands.
 *
 * For adjacent coast edges (e.g. south + west), the corner is rounded
 * using Euclidean distance instead of min(), creating a natural peninsula.
 * Large-scale noise creates bays and headlands.
 * Geology modulates: hard rock pushes coast outward (headlands),
 * soft rock retreats (bays).
 */
function _buildCoastField(width, height, coastEdges, shelfWidth, smoothResistance, coastNoise) {
  const field = new Grid2D(width, height);

  if (coastEdges.length === 0) {
    // No coast — everything is fully inland
    for (let i = 0; i < width * height; i++) field.data[i] = 1;
    return field;
  }

  // Classify edges by axis for corner detection
  const xEdges = []; // east/west
  const zEdges = []; // north/south
  for (const edge of coastEdges) {
    if (edge === 'west' || edge === 'east') xEdges.push(edge);
    else zEdges.push(edge);
  }
  const hasAdjacentCorner = xEdges.length > 0 && zEdges.length > 0;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const nx = gx / width;
      const nz = gz / height;

      // Compute distance from each coast edge (0 at edge, 1 at opposite edge)
      const dists = [];
      for (const edge of coastEdges) {
        if (edge === 'west') dists.push({ d: nx, axis: 'x' });
        else if (edge === 'east') dists.push({ d: 1 - nx, axis: 'x' });
        else if (edge === 'north') dists.push({ d: nz, axis: 'z' });
        else if (edge === 'south') dists.push({ d: 1 - nz, axis: 'z' });
      }

      // Base distance: rounded corners for adjacent edges
      let baseDist;
      if (dists.length === 1) {
        baseDist = dists[0].d;
      } else if (hasAdjacentCorner) {
        // For adjacent edges: Euclidean distance rounds the corner into a peninsula.
        // For any opposite edges in the mix, use min separately then combine.
        let xDist = 1, zDist = 1;
        for (const { d, axis } of dists) {
          if (axis === 'x') xDist = Math.min(xDist, d);
          else zDist = Math.min(zDist, d);
        }
        // Blend: Euclidean near the corner, min far away
        const euclidean = Math.sqrt(xDist * xDist + zDist * zDist);
        const minDist = Math.min(xDist, zDist);
        // Near corner (both dists small): use Euclidean; far from corner: use min
        const cornerProximity = smoothstep(0.4, 0.0, minDist);
        baseDist = minDist * (1 - cornerProximity) + euclidean * cornerProximity;
      } else {
        // Opposite edges (channel): just min
        baseDist = Math.min(...dists.map(e => e.d));
      }

      // Domain-warped noise for organic bay/headland shapes
      const warpX = coastNoise.fbm(nx * COAST_BAY_WARP_FREQ + 100, nz * COAST_BAY_WARP_FREQ + 100, {
        octaves: COAST_BAY_WARP_OCTAVES, amplitude: COAST_BAY_WARP_AMP,
      });
      const warpZ = coastNoise.fbm(nx * COAST_BAY_WARP_FREQ + 200, nz * COAST_BAY_WARP_FREQ + 200, {
        octaves: COAST_BAY_WARP_OCTAVES, amplitude: COAST_BAY_WARP_AMP,
      });
      const wnx = nx + warpX;
      const wnz = nz + warpZ;

      // Large bays and headlands
      const bayNoise = coastNoise.fbm(wnx * COAST_BAY_FREQ, wnz * COAST_BAY_FREQ, {
        octaves: COAST_BAY_OCTAVES,
        persistence: COAST_BAY_PERSISTENCE,
        amplitude: COAST_BAY_AMP,
      });

      // Smaller coastal detail
      const coastDetail = coastNoise.noise2D(wnx * COAST_DETAIL_FREQ, wnz * COAST_DETAIL_FREQ) * COAST_DETAIL_AMP;

      // Geology modulation: hard rock resists erosion (headlands),
      // soft rock retreats (bays)
      const smoothR = smoothResistance.get(gx, gz);
      const geoMod = (smoothR - 0.5) * COAST_GEO_STRENGTH;

      // Coast field: subtract shelf width so zero-crossing sits at the coast.
      // Noise pushes the coastline in/out to create bays and headlands.
      // Only apply noise near the coast (fade out inland to prevent artifacts).
      const noiseInfluence = smoothstep(0.5, 0.0, baseDist);
      const coastNoiseTerm = (bayNoise + coastDetail + geoMod) * noiseInfluence;

      field.set(gx, gz, baseDist - shelfWidth + coastNoiseTerm);
    }
  }

  return field;
}

/**
 * Apply escarpments at rock type boundaries.
 */
function applyEscarpments(elevation, rockType, erosionResistance, width, height) {
  const adjustments = new Float32Array(width * height);

  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      const myType = rockType.get(gx, gz);
      const myResistance = erosionResistance.get(gx, gz);
      const myRock = getRockInfo(myType);
      const cliffTendency = myRock.cliffTendency || 0;

      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = gx + dx;
        const nz = gz + dz;
        const neighborType = rockType.get(nx, nz);
        if (neighborType === myType) continue;

        const neighborResistance = erosionResistance.get(nx, nz);
        const resistanceDiff = myResistance - neighborResistance;

        if (resistanceDiff < -ESCARP_RESISTANCE_THRESHOLD) {
          const neighborRock = getRockInfo(neighborType);
          const neighborCliff = neighborRock.cliffTendency || 0;
          const scarpStrength = Math.abs(resistanceDiff) * Math.max(cliffTendency, neighborCliff);
          adjustments[gz * width + gx] = Math.min(
            adjustments[gz * width + gx],
            -scarpStrength * ESCARP_STRENGTH_MULT,
          );
        }
      }
    }
  }

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

    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        grid.set(gx, gz, tmp[gz * w + gx]);
      }
    }
  }
}
