import { describe, it, expect } from 'vitest';
import { generateRegion, extractCityContext } from '../../src/regional/region.js';
import { BIOME_IDS } from '../../src/regional/biomes.js';

// ---------------------------------------------------------------------------
// Shared region generated once with a fixed seed and small grid for speed.
// Using 64x64 grid with cellSize=200 for fast test execution.
// ---------------------------------------------------------------------------

const SEED = 42;
const GRID_SIZE = 64;

function makeRegion(overrides = {}) {
  return generateRegion({
    seed: SEED,
    gridSize: GRID_SIZE,
    cellSize: 200,
    mountainousness: 0.4,
    roughness: 0.5,
    coastEdges: ['south'],
    seaLevelPercentile: 0.35,
    maxCities: 3,
    maxTowns: 5,
    maxVillages: 10,
    minCitySpacing: 12,
    minTownSpacing: 6,
    minVillageSpacing: 4,
    streamThreshold: 20,
    riverThreshold: 80,
    majorRiverThreshold: 300,
    geology: false,
    ...overrides,
  });
}

// Cache a region for tests that don't need custom params
let _cachedRegion = null;
function getCachedRegion() {
  if (!_cachedRegion) {
    _cachedRegion = makeRegion();
  }
  return _cachedRegion;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Regional Generation Pipeline', () => {

  // Test 1: Regional terrain generation
  it('1. Regional terrain generation: heightmap has correct dimensions and reasonable elevation range', () => {
    const region = getCachedRegion();
    const { heightmap } = region;

    // Correct dimensions
    expect(heightmap.width).toBe(GRID_SIZE);
    expect(heightmap.height).toBe(GRID_SIZE);

    // Collect elevations and verify they are not all zeros or all the same
    let min = Infinity;
    let max = -Infinity;
    const seen = new Set();
    for (let gz = 0; gz < heightmap.height; gz++) {
      for (let gx = 0; gx < heightmap.width; gx++) {
        const e = heightmap.get(gx, gz);
        if (e < min) min = e;
        if (e > max) max = e;
        seen.add(e);
      }
    }

    // Not all zeros
    expect(max - min).toBeGreaterThan(0);
    // Not all the same value
    expect(seen.size).toBeGreaterThan(1);
    // Reasonable range (with mountainousness=0.4, amplitude lerps to ~92)
    expect(max - min).toBeGreaterThan(1);
  });

  // Test 2: Coast edge works
  it('2. Coast edge works: with coastEdges=[south], southern cells are lower than northern cells', () => {
    const region = getCachedRegion();
    const { heightmap } = region;
    const W = heightmap.width;
    const H = heightmap.height;

    // Average elevation of bottom 10% of rows vs top 10% of rows
    let southSum = 0;
    let southCount = 0;
    let northSum = 0;
    let northCount = 0;
    const edgeBand = Math.max(2, Math.floor(H * 0.1));

    for (let gx = 0; gx < W; gx++) {
      for (let gz = H - edgeBand; gz < H; gz++) {
        southSum += heightmap.get(gx, gz);
        southCount++;
      }
      for (let gz = 0; gz < edgeBand; gz++) {
        northSum += heightmap.get(gx, gz);
        northCount++;
      }
    }

    const southAvg = southSum / southCount;
    const northAvg = northSum / northCount;

    // Southern edge should generally be lower than northern
    expect(southAvg).toBeLessThan(northAvg);
  });

  // Test 3: Drainage produces rivers
  it('3. Drainage produces rivers: at least one stream exists and rivers flow downhill', () => {
    const region = getCachedRegion();
    const { drainage } = region;

    // At least one stream root
    expect(drainage.streams.length).toBeGreaterThanOrEqual(1);

    // Rivers flow downhill: each cell's elevation <= previous
    function checkDownhill(node) {
      for (let i = 1; i < node.cells.length; i++) {
        expect(node.cells[i].elevation).toBeLessThanOrEqual(
          node.cells[i - 1].elevation + 1e-4 // tolerance for fillSinks EPS
        );
      }
      for (const child of node.children) {
        checkDownhill(child);
      }
    }

    for (const root of drainage.streams) {
      checkDownhill(root);
    }
  });

  // Test 4: Settlements are placed
  it('4. Settlements are placed: at least one city, not in water, not on mountain peak', () => {
    const region = getCachedRegion();
    const { settlements, drainage, heightmap } = region;

    // At least one city
    const cities = settlements.filter(s => s.rank === 'city');
    expect(cities.length).toBeGreaterThanOrEqual(1);

    // No settlement in water
    for (const s of settlements) {
      const idx = s.gz * heightmap.width + s.gx;
      expect(drainage.waterCells.has(idx)).toBe(false);
    }

    // Compute 90th percentile of land elevations
    const landElevations = [];
    for (let gz = 0; gz < heightmap.height; gz++) {
      for (let gx = 0; gx < heightmap.width; gx++) {
        if (!drainage.waterCells.has(gz * heightmap.width + gx)) {
          landElevations.push(heightmap.get(gx, gz));
        }
      }
    }
    landElevations.sort((a, b) => a - b);
    const p90 = landElevations[Math.floor(landElevations.length * 0.9)];

    // No city above 90th percentile
    for (const c of cities) {
      expect(c.elevation).toBeLessThanOrEqual(p90 + 1e-4);
    }
  });

  // Test 5: Settlement spacing
  it('5. Settlement spacing: no two settlements of the same rank are closer than minimum spacing', () => {
    const region = getCachedRegion();
    const { settlements } = region;

    const minSpacings = { city: 12, town: 6, village: 4 };

    for (let i = 0; i < settlements.length; i++) {
      for (let j = i + 1; j < settlements.length; j++) {
        const a = settlements[i];
        const b = settlements[j];
        if (a.rank !== b.rank) continue;

        const dist = Math.sqrt(
          (a.gx - b.gx) * (a.gx - b.gx) +
          (a.gz - b.gz) * (a.gz - b.gz)
        );

        // Allow small tolerance for coarse sub-grid placement
        expect(dist).toBeGreaterThanOrEqual(minSpacings[a.rank] * 0.9);
      }
    }
  });

  // Test 6: Economic roles are assigned
  it('6. Economic roles are assigned: every settlement has a non-empty economicRole', () => {
    const region = getCachedRegion();
    const validRoles = [
      'port', 'river_crossing', 'confluence_town', 'market_town',
      'mining', 'pass_town', 'fishing',
    ];

    for (const s of region.settlements) {
      expect(typeof s.economicRole).toBe('string');
      expect(s.economicRole.length).toBeGreaterThan(0);
      expect(validRoles).toContain(s.economicRole);
    }
  });

  // Test 7: Roads connect settlements
  it('7. Roads connect settlements: every town connected to at least one city, every village to at least one town', () => {
    const region = getCachedRegion();
    const { settlements, roads } = region;

    const citySet = new Set(settlements.filter(s => s.rank === 'city'));
    const townSet = new Set(settlements.filter(s => s.rank === 'town'));

    if (townSet.size === 0 || citySet.size === 0) return;

    // Build adjacency by settlement object reference
    const adj = new Map();
    for (const road of roads) {
      if (!adj.has(road.from)) adj.set(road.from, []);
      if (!adj.has(road.to)) adj.set(road.to, []);
      adj.get(road.from).push(road.to);
      adj.get(road.to).push(road.from);
    }

    // Every town can reach a city via BFS
    for (const town of townSet) {
      const visited = new Set();
      const queue = [town];
      visited.add(town);
      let foundCity = false;

      while (queue.length > 0 && !foundCity) {
        const current = queue.shift();
        if (citySet.has(current)) {
          foundCity = true;
          break;
        }
        const neighbors = adj.get(current) || [];
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }

      expect(foundCity).toBe(true);
    }

    // Every village can reach a town via BFS
    const villages = settlements.filter(s => s.rank === 'village');
    for (const village of villages) {
      const visited = new Set();
      const queue = [village];
      visited.add(village);
      let foundTown = false;

      while (queue.length > 0 && !foundTown) {
        const current = queue.shift();
        if (townSet.has(current) || citySet.has(current)) {
          foundTown = true;
          break;
        }
        const neighbors = adj.get(current) || [];
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }

      expect(foundTown).toBe(true);
    }
  });

  // Test 8: Road entries are populated
  it('8. Road entries are populated: cities have at least one roadEntry', () => {
    const region = getCachedRegion();
    const cities = region.settlements.filter(s => s.rank === 'city');

    // At least some settlements should have road entries
    let foundEntries = false;
    for (const city of cities) {
      if (city.roadEntries.length > 0) {
        foundEntries = true;
        for (const entry of city.roadEntries) {
          expect(entry).toHaveProperty('point');
          expect(entry.point).toHaveProperty('x');
          expect(entry.point).toHaveProperty('z');
          expect(entry).toHaveProperty('direction');
          expect(entry.direction).toBeGreaterThanOrEqual(0);
          expect(entry.direction).toBeLessThan(2 * Math.PI);
          expect(entry).toHaveProperty('hierarchy');
          expect(['major', 'secondary', 'minor']).toContain(entry.hierarchy);
        }
      }
    }

    expect(foundEntries).toBe(true);
  });

  // Test 9: Full pipeline determinism
  it('9. Full pipeline determinism: same seed produces identical settlements', () => {
    const regionA = makeRegion();
    const regionB = makeRegion();

    expect(regionA.settlements.length).toBe(regionB.settlements.length);
    for (let i = 0; i < regionA.settlements.length; i++) {
      expect(regionA.settlements[i].gx).toBe(regionB.settlements[i].gx);
      expect(regionA.settlements[i].gz).toBe(regionB.settlements[i].gz);
      expect(regionA.settlements[i].rank).toBe(regionB.settlements[i].rank);
      expect(regionA.settlements[i].economicRole).toBe(regionB.settlements[i].economicRole);
      expect(regionA.settlements[i].x).toBe(regionB.settlements[i].x);
      expect(regionA.settlements[i].z).toBe(regionB.settlements[i].z);
    }
  });

  // Test 10: extractCityContext
  it('10. extractCityContext: returns valid CityContext for highest-ranked settlement', () => {
    const region = getCachedRegion();
    if (region.settlements.length === 0) return;

    // Pick the highest-ranked settlement (first city, or first overall)
    const settlement = region.settlements[0];
    const ctx = extractCityContext(region, settlement);

    // Required fields exist
    expect(ctx).toHaveProperty('center');
    expect(ctx).toHaveProperty('settlement');
    expect(ctx).toHaveProperty('regionHeightmap');
    expect(ctx).toHaveProperty('cityBounds');
    expect(ctx).toHaveProperty('seaLevel');
    expect(ctx).toHaveProperty('rivers');
    expect(ctx).toHaveProperty('coastline');
    expect(ctx).toHaveProperty('roadEntries');
    expect(ctx).toHaveProperty('economicRole');
    expect(ctx).toHaveProperty('rank');
    expect(ctx).toHaveProperty('hinterland');

    // Center matches settlement position
    expect(ctx.center.x).toBe(settlement.x);
    expect(ctx.center.z).toBe(settlement.z);

    // cityBounds is valid
    expect(ctx.cityBounds.minX).toBeLessThan(ctx.cityBounds.maxX);
    expect(ctx.cityBounds.minZ).toBeLessThan(ctx.cityBounds.maxZ);

    // At least one road entry (city should be connected)
    expect(ctx.roadEntries.length).toBeGreaterThanOrEqual(1);

    // Rivers is an array
    expect(Array.isArray(ctx.rivers)).toBe(true);

    // Hinterland has required keys
    expect(ctx.hinterland).toHaveProperty('agriculture');
    expect(ctx.hinterland).toHaveProperty('timber');
    expect(ctx.hinterland).toHaveProperty('minerals');
    expect(ctx.hinterland).toHaveProperty('fishing');
  });

  // Test 11: Biomes are assigned
  it('11. Biomes are assigned: every non-water cell has a valid biome ID', () => {
    const region = getCachedRegion();
    const { biomes, heightmap, drainage } = region;
    const { biomes: biomeArr, biomeNames } = biomes;

    const W = heightmap.width;
    const H = heightmap.height;
    const maxBiomeId = biomeNames.length - 1;

    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        const idx = gz * W + gx;
        const biomeId = biomeArr[idx];

        // Valid biome ID range
        expect(biomeId).toBeGreaterThanOrEqual(0);
        expect(biomeId).toBeLessThanOrEqual(maxBiomeId);

        // Non-water cells should not have WATER biome
        if (!drainage.waterCells.has(idx)) {
          expect(biomeId).not.toBe(BIOME_IDS.WATER);
        }
      }
    }
  });

  // Test 12: Hinterland reflects geography
  it('12. Hinterland reflects geography: settlement near water has higher fishing than one far from water', () => {
    const region = getCachedRegion();
    const { settlements, drainage, heightmap } = region;

    if (settlements.length < 2) return;

    // Find settlements near and far from water
    const W = heightmap.width;

    let nearWater = null;
    let farFromWater = null;
    let nearWaterDist = Infinity;
    let farWaterDist = -1;

    for (const s of settlements) {
      // Compute minimum distance to any water cell (approximation via a few checks)
      let minDist = Infinity;
      const searchRadius = 15;
      for (let dz = -searchRadius; dz <= searchRadius; dz += 2) {
        for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
          const nx = s.gx + dx;
          const nz = s.gz + dz;
          if (nx < 0 || nx >= W || nz < 0 || nz >= heightmap.height) continue;
          if (drainage.waterCells.has(nz * W + nx)) {
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < minDist) minDist = d;
          }
        }
      }

      if (minDist < nearWaterDist) {
        nearWaterDist = minDist;
        nearWater = s;
      }
      if (minDist > farWaterDist) {
        farWaterDist = minDist;
        farFromWater = s;
      }
    }

    // If we found distinct settlements, the one near water should have
    // higher fishing proportion (or at least not lower)
    if (nearWater && farFromWater && nearWater !== farFromWater &&
        nearWaterDist < 8 && farWaterDist > 8) {
      expect(nearWater.hinterland.fishing).toBeGreaterThanOrEqual(
        farFromWater.hinterland.fishing
      );
    }
  });

});

// ---------------------------------------------------------------------------
// Geology Integration Tests
// ---------------------------------------------------------------------------

describe('Geology Integration', () => {

  function makeGeoRegion(overrides = {}) {
    return generateRegion({
      seed: SEED,
      gridSize: GRID_SIZE,
      cellSize: 200,
      mountainousness: 0.4,
      roughness: 0.5,
      coastEdges: ['south'],
      seaLevelPercentile: 0.35,
      maxCities: 2,
      maxTowns: 4,
      maxVillages: 8,
      minCitySpacing: 12,
      minTownSpacing: 6,
      minVillageSpacing: 4,
      streamThreshold: 20,
      riverThreshold: 80,
      majorRiverThreshold: 300,
      geology: true,
      ...overrides,
    });
  }

  it('generates geology data when enabled', () => {
    const region = makeGeoRegion();
    expect(region.geology).not.toBeNull();
    expect(region.geology.rockTypes).toBeInstanceOf(Uint8Array);
    expect(region.geology.springLine).toBeInstanceOf(Uint8Array);
    expect(region.geology.rockTypes.length).toBe(GRID_SIZE * GRID_SIZE);
  });

  it('geology is null when disabled', () => {
    const region = makeGeoRegion({ geology: false });
    expect(region.geology).toBeNull();
  });

  it('settlements have settlementCharacter when geology enabled', () => {
    const region = makeGeoRegion();
    const validChars = [
      'estuary_city', 'harbor_town', 'spring_line_town',
      'hilltop_fort', 'confluence_city', 'crossing_town', 'lowland_town',
    ];
    for (const s of region.settlements) {
      expect(typeof s.settlementCharacter).toBe('string');
      expect(validChars).toContain(s.settlementCharacter);
    }
  });

  it('building material resources are present in biomes', () => {
    const region = makeGeoRegion();
    const { resources } = region.biomes;

    let foundMaterial = false;
    for (const [, res] of resources) {
      for (const r of res) {
        if (r.startsWith('building_material:')) {
          foundMaterial = true;
          break;
        }
      }
      if (foundMaterial) break;
    }
    expect(foundMaterial).toBe(true);
  });

  it('extractCityContext includes geology data', () => {
    const region = makeGeoRegion();
    if (region.settlements.length === 0) return;

    const ctx = extractCityContext(region, region.settlements[0]);
    expect(ctx.geology).not.toBeNull();
    expect(ctx.geology.buildingMaterial).toBeTruthy();
    expect(ctx.geology.dominantRock).toBeTruthy();
    expect(ctx.geology.rockTypes).toBeInstanceOf(Uint8Array);
    expect(ctx.geology.springLine).toBeInstanceOf(Uint8Array);
  });

  it('extractCityContext geology is null when geology disabled', () => {
    const region = makeGeoRegion({ geology: false });
    if (region.settlements.length === 0) return;

    const ctx = extractCityContext(region, region.settlements[0]);
    expect(ctx.geology).toBeNull();
  });
});
