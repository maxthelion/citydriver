/**
 * Biome and resource assignment for regional cells.
 * Tags each cell based on terrain characteristics, drainage proximity,
 * and elevation relative to sea level.
 * When geology is provided, soil fertility and building materials are derived from rock type.
 */
import { ROCK_PROPERTIES } from './geology.js';

/** Biome IDs. */
export const BIOME_IDS = {
  WATER: 0,
  COASTAL: 1,
  LOWLAND_FERTILE: 2,
  PLAINS: 3,
  FOREST: 4,
  UPLAND: 5,
  MOUNTAIN: 6,
  WETLAND: 7,
};

/** Index-to-name mapping for biomes. */
export const BIOME_NAMES = [
  'WATER',
  'COASTAL',
  'LOWLAND_FERTILE',
  'PLAINS',
  'FOREST',
  'UPLAND',
  'MOUNTAIN',
  'WETLAND',
];

/**
 * Compute the slope magnitude at a cell (max elevation difference to neighbors).
 */
function getSlope(heightmap, gx, gz) {
  const W = heightmap.width;
  const H = heightmap.height;
  const elev = heightmap.get(gx, gz);
  let maxDiff = 0;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = gx + dx;
      const nz = gz + dz;
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
      const dist = (dx !== 0 && dz !== 0) ? Math.SQRT2 : 1.0;
      const diff = Math.abs(heightmap.get(nx, nz) - elev) / dist;
      if (diff > maxDiff) maxDiff = diff;
    }
  }

  return maxDiff;
}

/**
 * Assign biome and resource tags to each cell.
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @param {number} seaLevel
 * @param {object} drainage - Result from generateDrainage (needs waterCells, accumulation, crossings)
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{
 *   biomes: Uint8Array,
 *   biomeNames: string[],
 *   resources: Map<number, string[]>,
 * }}
 */
export function generateBiomes(heightmap, seaLevel, drainage, rng, geology = null) {
  const W = heightmap.width;
  const H = heightmap.height;
  const total = W * H;

  const biomes = new Uint8Array(total);
  const resources = new Map();

  const { waterCells, accumulation, crossings } = drainage;

  // --- Precompute proximity to water (BFS from all water cells, up to distance 10) ---
  const waterDist = new Float32Array(total);
  for (let i = 0; i < total; i++) waterDist[i] = Infinity;

  const queue = [];
  for (const wKey of waterCells) {
    waterDist[wKey] = 0;
    queue.push(wKey);
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const cx = idx % W;
    const cz = (idx - cx) / W;
    const d = waterDist[idx];
    if (d >= 10) continue;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        const nIdx = nz * W + nx;
        const nd = d + 1;
        if (nd < waterDist[nIdx]) {
          waterDist[nIdx] = nd;
          queue.push(nIdx);
        }
      }
    }
  }

  // --- Identify sea/ocean cells (below sea level) vs river cells ---
  const isSeaCell = new Uint8Array(total);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      if (heightmap.get(gx, gz) < seaLevel) {
        isSeaCell[gz * W + gx] = 1;
      }
    }
  }

  // BFS to find distance to sea cells specifically (for COASTAL detection)
  const seaDist = new Float32Array(total);
  for (let i = 0; i < total; i++) seaDist[i] = Infinity;
  const seaQueue = [];
  for (let i = 0; i < total; i++) {
    if (isSeaCell[i]) {
      seaDist[i] = 0;
      seaQueue.push(i);
    }
  }

  let sHead = 0;
  while (sHead < seaQueue.length) {
    const idx = seaQueue[sHead++];
    const cx = idx % W;
    const cz = (idx - cx) / W;
    const d = seaDist[idx];
    if (d >= 5) continue;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        const nIdx = nz * W + nx;
        const nd = d + 1;
        if (nd < seaDist[nIdx]) {
          seaDist[nIdx] = nd;
          seaQueue.push(nIdx);
        }
      }
    }
  }

  // --- River cell proximity (for WETLAND and LOWLAND_FERTILE) ---
  const riverThreshold = 500;
  const nearRiver = new Uint8Array(total);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      if (accumulation[idx] >= riverThreshold) {
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
              nearRiver[nz * W + nx] = 1;
            }
          }
        }
      }
    }
  }

  // --- Crossing cells for trade_route resource ---
  const crossingSet = new Set();
  if (crossings) {
    for (const c of crossings) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = c.gx + dx;
          const nz = c.gz + dz;
          if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
            crossingSet.add(nz * W + nx);
          }
        }
      }
    }
  }

  // --- Elevation statistics for adaptive thresholds ---
  let elevMin = Infinity;
  let elevMax = -Infinity;
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      if (isSeaCell[gz * W + gx]) continue;
      const e = heightmap.get(gx, gz);
      if (e < elevMin) elevMin = e;
      if (e > elevMax) elevMax = e;
    }
  }
  if (elevMin === Infinity) { elevMin = 0; elevMax = 1; }
  const elevRange = elevMax - elevMin || 1;

  // --- Mineral deposit RNG ---
  const mineralRng = rng.fork('minerals');

  // --- Assign biomes ---
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      const idx = gz * W + gx;
      const elev = heightmap.get(gx, gz);
      const slope = getSlope(heightmap, gx, gz);
      const elevNorm = (elev - elevMin) / elevRange;
      const elevAboveSea = elev - seaLevel;
      const cellResources = [];

      // WATER: below sea level or river cell in waterCells
      if (waterCells.has(idx)) {
        biomes[idx] = BIOME_IDS.WATER;
        if (cellResources.length > 0) resources.set(idx, cellResources);
        continue;
      }

      // COASTAL: near sea, low elevation, 0-10m above sea level
      if (seaDist[idx] <= 3 && elevAboveSea >= 0 && elevAboveSea <= 10) {
        biomes[idx] = BIOME_IDS.COASTAL;
        cellResources.push('fishing');
        resources.set(idx, cellResources);
        continue;
      }

      // MOUNTAIN: high elevation or steep slope
      if (elevNorm > 0.75 || slope > 15) {
        biomes[idx] = BIOME_IDS.MOUNTAIN;
        // Random chance of minerals
        mineralRng.next(); // advance RNG for determinism
        if (mineralRng.next() > 0.7) {
          cellResources.push('minerals');
        }
        if (cellResources.length > 0) resources.set(idx, cellResources);
        continue;
      }

      // UPLAND: higher elevation, moderate slope
      if (elevNorm > 0.5 || (elevNorm > 0.35 && slope > 5)) {
        biomes[idx] = BIOME_IDS.UPLAND;
        mineralRng.next();
        if (mineralRng.next() > 0.8) {
          cellResources.push('minerals');
        }
        if (cellResources.length > 0) resources.set(idx, cellResources);
        continue;
      }

      // WETLAND: low, flat, very close to river/coast
      if (elevNorm < 0.2 && nearRiver[idx] === 1 && slope < 2) {
        biomes[idx] = BIOME_IDS.WETLAND;
        if (cellResources.length > 0) resources.set(idx, cellResources);
        continue;
      }

      // FOREST: moderate elevation, moderate slope, further from water
      if (elevNorm > 0.2 && slope > 2 && waterDist[idx] > 3) {
        biomes[idx] = BIOME_IDS.FOREST;
        cellResources.push('timber');
        resources.set(idx, cellResources);
        continue;
      }

      // LOWLAND_FERTILE: flat, low, near water -- good agriculture
      // Geology: fertile rock expands the classification thresholds
      let fertileElevMax = 0.4;
      let fertileWaterMax = 10;
      if (geology) {
        const fertility = ROCK_PROPERTIES[geology.rockTypes[idx]].soilFertility;
        if (fertility > 0.6) {
          fertileElevMax = 0.5;
          fertileWaterMax = 15;
        }
      }
      if (elevNorm < fertileElevMax && slope < 5 && waterDist[idx] <= fertileWaterMax) {
        biomes[idx] = BIOME_IDS.LOWLAND_FERTILE;
        if (nearRiver[idx]) {
          cellResources.push('agriculture');
        }
        if (cellResources.length > 0) resources.set(idx, cellResources);
        continue;
      }

      // PLAINS: flat, moderate elevation (default for remaining)
      biomes[idx] = BIOME_IDS.PLAINS;
      if (cellResources.length > 0) resources.set(idx, cellResources);
    }
  }

  // --- Overlay trade_route resource on crossing cells ---
  for (const idx of crossingSet) {
    if (biomes[idx] !== BIOME_IDS.WATER) {
      const existing = resources.get(idx) || [];
      if (!existing.includes('trade_route')) {
        existing.push('trade_route');
        resources.set(idx, existing);
      }
    }
  }

  // --- Geology: overlay building material resource per cell ---
  if (geology) {
    const BUILDING_MATERIALS = [
      'building_material:granite',      // IGNEOUS
      'building_material:limestone',    // HARD_SED
      'building_material:brick',        // SOFT_SED
      'building_material:flint_brick',  // CHALK
      'building_material:brick_timber', // ALLUVIAL
    ];

    for (let i = 0; i < total; i++) {
      if (biomes[i] === BIOME_IDS.WATER) continue;
      const mat = BUILDING_MATERIALS[geology.rockTypes[i]];
      const existing = resources.get(i) || [];
      existing.push(mat);
      resources.set(i, existing);
    }
  }

  return { biomes, biomeNames: BIOME_NAMES, resources };
}
