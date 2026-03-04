/**
 * Geology layer generation.
 * Produces an invisible rock-type map that drives terrain, drainage,
 * biomes, settlements, and road routing when enabled.
 */
import { PerlinNoise } from '../core/noise.js';
import { clamp } from '../core/math.js';

/** Rock type enum. */
export const ROCK_TYPES = {
  IGNEOUS: 0,
  HARD_SED: 1,
  SOFT_SED: 2,
  CHALK: 3,
  ALLUVIAL: 4,
};

export const ROCK_NAMES = ['igneous', 'hard_sedimentary', 'soft_sedimentary', 'chalk', 'alluvial'];

/** Per-rock-type physical properties. Indexed by ROCK_TYPES values. */
export const ROCK_PROPERTIES = [
  // IGNEOUS
  { erosionResistance: 0.95, permeability: 0.15, cliffTendency: 0.85, soilFertility: 0.15 },
  // HARD_SED
  { erosionResistance: 0.75, permeability: 0.60, cliffTendency: 0.55, soilFertility: 0.35 },
  // SOFT_SED
  { erosionResistance: 0.25, permeability: 0.20, cliffTendency: 0.10, soilFertility: 0.75 },
  // CHALK
  { erosionResistance: 0.50, permeability: 0.85, cliffTendency: 0.70, soilFertility: 0.50 },
  // ALLUVIAL
  { erosionResistance: 0.05, permeability: 0.30, cliffTendency: 0.00, soilFertility: 0.95 },
];

/**
 * Generate geology data for a region.
 *
 * @param {object} params
 * @param {number} params.gridSize
 * @param {number} [params.geologyBandDirection] - Radians, null = random
 * @param {number} [params.geologyComplexity=3] - Rock type transitions (2-6)
 * @param {number} [params.igneousIntrusionCount=1] - 0-3 blobs
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{
 *   rockTypes: Uint8Array,
 *   bandDirection: number,
 *   intrusions: Array<{cx: number, cz: number, radius: number}>,
 *   springLine: Uint8Array,
 * }}
 */
export function generateGeology(params, rng) {
  const {
    gridSize,
    geologyBandDirection = null,
    geologyComplexity = 3,
    igneousIntrusionCount = 1,
  } = params;

  const geoRng = rng.fork('geology');
  const total = gridSize * gridSize;
  const rockTypes = new Uint8Array(total);

  // --- 1. Band direction ---
  const bandDirection = geologyBandDirection != null
    ? geologyBandDirection
    : geoRng.next() * Math.PI * 2;

  const bandCos = Math.cos(bandDirection);
  const bandSin = Math.sin(bandDirection);

  // --- 2. Fill sedimentary bands using noise projected onto band axis ---
  const bandNoise = new PerlinNoise(geoRng.fork('bandNoise'));
  const complexity = clamp(geologyComplexity, 2, 6);

  // Band frequency: more complexity = more transitions across the map
  const bandFreq = complexity / gridSize;

  // Sedimentary rock types cycle: HARD_SED, SOFT_SED, CHALK
  const sedTypes = [ROCK_TYPES.HARD_SED, ROCK_TYPES.SOFT_SED, ROCK_TYPES.CHALK];

  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      // Project onto band axis (centered on grid)
      const cx = gx - gridSize * 0.5;
      const cz = gz - gridSize * 0.5;
      const projection = cx * bandCos + cz * bandSin;
      const cross = -cx * bandSin + cz * bandCos;

      // fBm noise warped by band projection
      const n = bandNoise.fbm(
        projection * bandFreq,
        cross * 0.3 / gridSize * complexity,
        { octaves: 3, lacunarity: 2.0, persistence: 0.5, amplitude: 1, frequency: 1 },
      );

      // Map noise [-1,1] → [0, sedTypes.length) to select rock type
      const t = (n + 1) * 0.5; // [0,1]
      const sedIdx = Math.min(sedTypes.length - 1, Math.floor(t * sedTypes.length));
      rockTypes[gz * gridSize + gx] = sedTypes[sedIdx];
    }
  }

  // --- 3. Stamp igneous intrusions ---
  const intrusions = [];
  const intrusionCount = clamp(igneousIntrusionCount, 0, 3);
  const intrusionNoise = new PerlinNoise(geoRng.fork('intrusion'));

  for (let i = 0; i < intrusionCount; i++) {
    const cx = geoRng.range(gridSize * 0.15, gridSize * 0.85);
    const cz = geoRng.range(gridSize * 0.15, gridSize * 0.85);
    const radius = geoRng.range(gridSize * 0.06, gridSize * 0.15);
    intrusions.push({ cx, cz, radius });

    // Stamp noise-warped circular blob
    const r2 = radius * radius;
    const extent = Math.ceil(radius * 1.3);
    const igx0 = Math.max(0, Math.floor(cx - extent));
    const igx1 = Math.min(gridSize - 1, Math.ceil(cx + extent));
    const igz0 = Math.max(0, Math.floor(cz - extent));
    const igz1 = Math.min(gridSize - 1, Math.ceil(cz + extent));

    for (let gz = igz0; gz <= igz1; gz++) {
      for (let gx = igx0; gx <= igx1; gx++) {
        const dx = gx - cx;
        const dz = gz - cz;
        // Warp the distance with noise for organic shape
        const warp = intrusionNoise.noise2D(gx * 0.05, gz * 0.05) * radius * 0.3;
        const distSq = dx * dx + dz * dz;
        if (distSq < (radius + warp) * (radius + warp)) {
          rockTypes[gz * gridSize + gx] = ROCK_TYPES.IGNEOUS;
        }
      }
    }
  }

  // --- 4. Compute spring line: cells where neighbor erosionResistance differs by >= 0.3 ---
  const springLine = new Uint8Array(total);

  for (let gz = 1; gz < gridSize - 1; gz++) {
    for (let gx = 1; gx < gridSize - 1; gx++) {
      const idx = gz * gridSize + gx;
      const myResistance = ROCK_PROPERTIES[rockTypes[idx]].erosionResistance;

      let isSpring = false;
      for (let dz = -1; dz <= 1 && !isSpring; dz++) {
        for (let dx = -1; dx <= 1 && !isSpring; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nIdx = (gz + dz) * gridSize + (gx + dx);
          const neighborResistance = ROCK_PROPERTIES[rockTypes[nIdx]].erosionResistance;
          if (Math.abs(myResistance - neighborResistance) >= 0.3) {
            isSpring = true;
          }
        }
      }

      if (isSpring) {
        springLine[idx] = 1;
      }
    }
  }

  // NOTE: Alluvial deposits are NOT placed here — deferred to drainage phase

  return { rockTypes, bandDirection, intrusions, springLine };
}
