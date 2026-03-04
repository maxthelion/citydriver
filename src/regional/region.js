/**
 * Regional generation orchestrator.
 * Runs the full pipeline: terrain -> drainage -> biomes -> settlements -> roads.
 * Also provides extractCityContext to bridge regional and city-scale generation.
 */
import { SeededRandom } from '../core/rng.js';
import { generateGeology, ROCK_TYPES, ROCK_NAMES, ROCK_PROPERTIES } from './geology.js';
import { generateRegionalTerrain } from './regionalTerrain.js';
import { generateDrainage } from './drainage.js';
import { generateBiomes } from './biomes.js';
import { placeSettlements } from './settlements.js';
import { generateRegionalRoads } from './regionalRoads.js';

/** Default parameters for region generation. */
const DEFAULTS = {
  seed: 12345,
  gridSize: 512,
  cellSize: 200,
  mountainousness: 0.5,
  roughness: 0.5,
  coastEdges: ['south'],
  seaLevelPercentile: 0.35,
  maxCities: 3,
  maxTowns: 8,
  maxVillages: 20,
  streamThreshold: 100,
  riverThreshold: 1000,
  majorRiverThreshold: 5000,
  geology: true,
  geologyBandDirection: null,
  geologyComplexity: 3,
  igneousIntrusionCount: 1,
  erosionResistanceContrast: 0.7,
  coastalErosionIntensity: 0.6,
  riverDensityMultiplier: 1.0,
};

/**
 * Generate a complete region.
 * @param {object} [params] - Merged with DEFAULTS
 * @returns {object} RegionData
 */
export function generateRegion(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const rng = new SeededRandom(p.seed);

  // R0: Geology (optional invisible layer)
  const geology = p.geology ? generateGeology({
    gridSize: p.gridSize,
    geologyBandDirection: p.geologyBandDirection,
    geologyComplexity: p.geologyComplexity,
    igneousIntrusionCount: p.igneousIntrusionCount,
  }, rng) : null;

  // R1: Terrain
  const { heightmap, seaLevel } = generateRegionalTerrain({
    gridSize: p.gridSize,
    cellSize: p.cellSize,
    mountainousness: p.mountainousness,
    roughness: p.roughness,
    coastEdges: p.coastEdges,
    seaLevelPercentile: p.seaLevelPercentile,
    erosionResistanceContrast: p.erosionResistanceContrast,
    coastalErosionIntensity: p.coastalErosionIntensity,
  }, rng, geology);

  // R2: Drainage (modifies heightmap via fillSinks)
  const drainage = generateDrainage(heightmap, seaLevel, {
    streamThreshold: p.streamThreshold,
    riverThreshold: p.riverThreshold,
    majorRiverThreshold: p.majorRiverThreshold,
    riverDensityMultiplier: p.riverDensityMultiplier,
  }, geology);

  // After fillSinks, freeze the heightmap
  heightmap.freeze();

  // R3: Biomes
  const biomes = generateBiomes(heightmap, seaLevel, drainage, rng, geology);

  // R4: Settlements
  const settlements = placeSettlements(heightmap, seaLevel, drainage, biomes, rng, {
    maxCities: p.maxCities,
    maxTowns: p.maxTowns,
    maxVillages: p.maxVillages,
    minCitySpacing: p.minCitySpacing,
    minTownSpacing: p.minTownSpacing,
    minVillageSpacing: p.minVillageSpacing,
  }, geology);

  // R5: Roads
  const { roads } = generateRegionalRoads(settlements, heightmap, drainage, geology);

  return {
    heightmap,
    seaLevel,
    drainage,
    biomes,
    settlements,
    roads,
    geology,
    params: p,
  };
}

/**
 * Extract a CityContext for a specific settlement.
 * This is the interface between regional and city-scale generation.
 * @param {object} region - RegionData from generateRegion
 * @param {object} settlement - Settlement object (must be in region.settlements)
 * @param {number} [cityRadius=30] - Grid cells to include around settlement
 * @returns {object} CityContext
 */
export function extractCityContext(region, settlement, cityRadius = 30) {
  const {
    heightmap, drainage, settlements, roads, seaLevel, params,
  } = region;

  // Validate settlement is in the region
  if (!settlements.includes(settlement)) {
    throw new Error('Settlement not found in region.settlements');
  }

  const W = heightmap.width;
  const H = heightmap.height;
  const cellSize = heightmap._cellSize;

  // --- City bounds in world coordinates ---
  const worldCenter = heightmap.gridToWorld(settlement.gx, settlement.gz);
  const radiusWorld = cityRadius * cellSize;
  const cityBounds = {
    minX: worldCenter.x - radiusWorld,
    minZ: worldCenter.z - radiusWorld,
    maxX: worldCenter.x + radiusWorld,
    maxZ: worldCenter.z + radiusWorld,
  };

  // --- Rivers passing through city bounds ---
  const { accumulation, directions } = drainage;
  const riverThreshold = (params && params.riverThreshold) || 1000;

  // D8 direction offsets
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DZ = [0, 1, 1, 1, 0, -1, -1, -1];

  // Collect river cells within city bounds
  const riverCellsInBounds = [];
  for (let dz = -cityRadius; dz <= cityRadius; dz++) {
    for (let dx = -cityRadius; dx <= cityRadius; dx++) {
      const gx = settlement.gx + dx;
      const gz = settlement.gz + dz;
      if (gx < 0 || gx >= W || gz < 0 || gz >= H) continue;
      const idx = gz * W + gx;
      if (accumulation[idx] >= riverThreshold) {
        riverCellsInBounds.push({ gx, gz, acc: accumulation[idx] });
      }
    }
  }

  // Group river cells into connected segments by tracing downstream
  const rivers = [];
  if (riverCellsInBounds.length > 0) {
    const visited = new Set();
    riverCellsInBounds.sort((a, b) => a.acc - b.acc);

    for (const start of riverCellsInBounds) {
      const startKey = start.gz * W + start.gx;
      if (visited.has(startKey)) continue;

      const cells = [];
      let cx = start.gx;
      let cz = start.gz;

      while (true) {
        const key = cz * W + cx;
        if (visited.has(key)) break;
        visited.add(key);

        if (Math.abs(cx - settlement.gx) > cityRadius ||
            Math.abs(cz - settlement.gz) > cityRadius) break;

        cells.push({ gx: cx, gz: cz });

        const dir = directions[key];
        if (dir < 0) break;
        const nx = cx + DX[dir];
        const nz = cz + DZ[dir];
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) break;
        if (accumulation[nz * W + nx] < riverThreshold) break;
        cx = nx;
        cz = nz;
      }

      if (cells.length >= 2) {
        const entry = cells[0];
        const exit = cells[cells.length - 1];
        const entryWorld = heightmap.gridToWorld(entry.gx, entry.gz);
        const exitWorld = heightmap.gridToWorld(exit.gx, exit.gz);
        const exitAcc = accumulation[exit.gz * W + exit.gx];

        let rank = 'stream';
        if (exitAcc >= (params.majorRiverThreshold || 5000)) rank = 'majorRiver';
        else if (exitAcc >= riverThreshold) rank = 'river';

        rivers.push({
          entryPoint: { x: entryWorld.x, z: entryWorld.z },
          exitPoint: { x: exitWorld.x, z: exitWorld.z },
          cells,
          flowVolume: exitAcc,
          rank,
        });
      }
    }
  }

  // --- Coastline detection ---
  let coastline = null;
  if (params.coastEdges && params.coastEdges.length > 0) {
    // Check if any coast edge is within city bounds
    for (const edge of params.coastEdges) {
      let hasCoastInBounds = false;

      switch (edge) {
        case 'south':
          hasCoastInBounds = (settlement.gz + cityRadius >= H - 1) ||
            checkSeaCellsInBounds(heightmap, seaLevel, settlement, cityRadius, W, H);
          break;
        case 'north':
          hasCoastInBounds = (settlement.gz - cityRadius <= 0) ||
            checkSeaCellsInBounds(heightmap, seaLevel, settlement, cityRadius, W, H);
          break;
        case 'west':
          hasCoastInBounds = (settlement.gx - cityRadius <= 0) ||
            checkSeaCellsInBounds(heightmap, seaLevel, settlement, cityRadius, W, H);
          break;
        case 'east':
          hasCoastInBounds = (settlement.gx + cityRadius >= W - 1) ||
            checkSeaCellsInBounds(heightmap, seaLevel, settlement, cityRadius, W, H);
          break;
      }

      if (hasCoastInBounds) {
        coastline = { edge, seaLevel };
        break;
      }
    }
  }

  // --- Road entries: find where roads cross city boundary ---
  const roadEntries = (settlement.roadEntries || []).map(entry => ({
    point: entry.point,
    direction: entry.direction,
    hierarchy: entry.hierarchy,
    destination: entry.destination,
  }));

  // --- Geology context for city generation ---
  let geologyContext = null;
  if (region.geology) {
    const { rockTypes, springLine } = region.geology;

    // Crop rock types and spring line to city bounds
    const diameter = cityRadius * 2 + 1;
    const croppedRockTypes = new Uint8Array(diameter * diameter);
    const croppedSpringLine = new Uint8Array(diameter * diameter);

    // Count rock types to find dominant
    const rockCounts = new Array(5).fill(0);

    for (let dz = -cityRadius; dz <= cityRadius; dz++) {
      for (let dx = -cityRadius; dx <= cityRadius; dx++) {
        const gx = settlement.gx + dx;
        const gz = settlement.gz + dz;
        const localIdx = (dz + cityRadius) * diameter + (dx + cityRadius);

        if (gx >= 0 && gx < W && gz >= 0 && gz < H) {
          const globalIdx = gz * W + gx;
          croppedRockTypes[localIdx] = rockTypes[globalIdx];
          croppedSpringLine[localIdx] = springLine[globalIdx];
          rockCounts[rockTypes[globalIdx]]++;
        }
      }
    }

    // Find dominant rock type
    let dominantRockIdx = 0;
    let maxCount = 0;
    for (let i = 0; i < rockCounts.length; i++) {
      if (rockCounts[i] > maxCount) {
        maxCount = rockCounts[i];
        dominantRockIdx = i;
      }
    }

    // Building material from dominant rock
    const MATERIAL_MAP = ['granite', 'limestone', 'brick', 'flint_brick', 'brick_timber'];

    geologyContext = {
      rockTypes: croppedRockTypes,
      springLine: croppedSpringLine,
      buildingMaterial: MATERIAL_MAP[dominantRockIdx],
      dominantRock: ROCK_NAMES[dominantRockIdx],
    };
  }

  return {
    center: { x: settlement.x, z: settlement.z },
    settlement,
    regionHeightmap: heightmap,
    cityBounds,
    seaLevel,
    rivers,
    coastline,
    roadEntries,
    economicRole: settlement.economicRole,
    rank: settlement.rank,
    hinterland: { ...settlement.hinterland },
    geology: geologyContext,
  };
}

/**
 * Check if there are any sea-level cells within the city bounds.
 */
function checkSeaCellsInBounds(heightmap, seaLevel, settlement, cityRadius, W, H) {
  for (let dz = -cityRadius; dz <= cityRadius; dz += 3) {
    for (let dx = -cityRadius; dx <= cityRadius; dx += 3) {
      const gx = settlement.gx + dx;
      const gz = settlement.gz + dz;
      if (gx < 0 || gx >= W || gz < 0 || gz >= H) continue;
      if (heightmap.get(gx, gz) < seaLevel) {
        return true;
      }
    }
  }
  return false;
}
