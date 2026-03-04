/**
 * Settlement placement for the regional layer.
 * Scores candidate locations based on geography and places settlements
 * in a hierarchy: cities, towns, villages.
 */
import { BIOME_IDS } from './biomes.js';

/**
 * Place settlements across the region based on geographic scoring.
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @param {number} seaLevel
 * @param {object} drainage - From generateDrainage (accumulation, confluences, crossings, waterCells)
 * @param {object} biomes - From generateBiomes (biomes Uint8Array, biomeNames, resources Map)
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [params]
 * @param {number} [params.maxCities=3]
 * @param {number} [params.maxTowns=8]
 * @param {number} [params.maxVillages=20]
 * @returns {Array<object>} Settlement[]
 */
export function placeSettlements(heightmap, seaLevel, drainage, biomes, rng, params = {}, geology = null) {
  const {
    maxCities = 3,
    maxTowns = 8,
    maxVillages = 20,
  } = params;

  // Minimum spacing in grid cells
  const minCitySpacing = params.minCitySpacing || 80;
  const minTownSpacing = params.minTownSpacing || 30;
  const minVillageSpacing = params.minVillageSpacing || 15;

  const W = heightmap.width;
  const H = heightmap.height;
  const cellSize = heightmap._cellSize;
  const { accumulation, confluences, crossings, waterCells } = drainage;
  const { biomes: biomeArr, resources: resourceMap } = biomes;

  // --- Precompute lookup structures ---
  const riverThreshold = 500;

  // Build confluence lookup set
  const confluenceMap = new Map();
  for (const c of confluences) {
    confluenceMap.set(c.gz * W + c.gx, c.flowVolume);
  }

  // Build crossing lookup set
  const crossingSet = new Set();
  for (const c of crossings) {
    crossingSet.add(c.gz * W + c.gx);
  }

  // --- Compute 90th percentile elevation to cap settlement placement ---
  const landElevations = [];
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      if (!waterCells.has(gz * W + gx)) {
        landElevations.push(heightmap.get(gx, gz));
      }
    }
  }
  landElevations.sort((a, b) => a - b);
  const maxSettlementElev = landElevations.length > 0
    ? landElevations[Math.floor(landElevations.length * 0.9)]
    : Infinity;

  // --- Score candidates on a coarser sub-grid (every 4th cell) ---
  const step = Math.max(2, Math.min(4, Math.floor(W / 16)));
  const candidates = [];

  for (let gz = step; gz < H - step; gz += step) {
    for (let gx = step; gx < W - step; gx += step) {
      const idx = gz * W + gx;

      // Cannot place in water
      if (waterCells.has(idx)) continue;

      // Cannot place on mountain biome
      if (biomeArr[idx] === BIOME_IDS.MOUNTAIN) continue;

      const elev = heightmap.get(gx, gz);

      // Cannot place too high (above 90th percentile)
      if (elev > maxSettlementElev) continue;

      let score = 0;

      // --- riverScore: proximity to river cells within 10 cells ---
      let nearRiverScore = 0;
      let minRiverDist = Infinity;
      for (let dz = -10; dz <= 10; dz++) {
        for (let dx = -10; dx <= 10; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
          const nIdx = nz * W + nx;
          if (accumulation[nIdx] >= riverThreshold) {
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < minRiverDist) {
              minRiverDist = d;
            }
          }
        }
      }
      if (minRiverDist <= 5) {
        nearRiverScore = 30 * (1.0 - minRiverDist / 6);
      } else if (minRiverDist <= 10) {
        nearRiverScore = 10 * (1.0 - minRiverDist / 11);
      }
      score += nearRiverScore;

      // --- crossingBonus: at or near a narrow crossing point ---
      let atCrossing = 0;
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
            if (crossingSet.has(nz * W + nx)) {
              atCrossing = 1;
              break;
            }
          }
        }
        if (atCrossing) break;
      }
      const crossingBonus = 50 * atCrossing;
      score += crossingBonus;

      // --- confluenceBonus: at or near a confluence ---
      let atConfluence = 0;
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
            if (confluenceMap.has(nz * W + nx)) {
              atConfluence = 1;
              break;
            }
          }
        }
        if (atConfluence) break;
      }
      const confluenceScoreVal = 40 * atConfluence;
      score += confluenceScoreVal;

      // --- harborScore: coastal with sheltered bay shape ---
      let harborScoreVal = 0;
      let isNearCoast = false;
      {
        let minCoastDist = Infinity;
        let coastWaterCount = 0;
        for (let dz = -5; dz <= 5; dz++) {
          for (let dx = -5; dx <= 5; dx++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
            const nIdx = nz * W + nx;
            if (heightmap.get(nx, nz) < seaLevel) {
              const d = Math.sqrt(dx * dx + dz * dz);
              if (d < minCoastDist) minCoastDist = d;
              coastWaterCount++;
            }
          }
        }
        if (minCoastDist <= 5) {
          isNearCoast = true;
          const totalScanned = 11 * 11;
          const waterFrac = coastWaterCount / totalScanned;
          if (waterFrac > 0.15 && waterFrac < 0.6) {
            harborScoreVal = 60;
          }
        }
      }
      score += harborScoreVal;

      // --- flatScore: low slope in surrounding 5x5 area ---
      let flatCount = 0;
      let totalFlat = 0;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
          totalFlat++;
          const b = biomeArr[nz * W + nx];
          if (b === BIOME_IDS.LOWLAND_FERTILE || b === BIOME_IDS.PLAINS ||
              b === BIOME_IDS.COASTAL || b === BIOME_IDS.WETLAND) {
            flatCount++;
          }
        }
      }
      const flatScore = totalFlat > 0 ? 20 * (flatCount / totalFlat) : 0;
      score += flatScore;

      // --- hinterlandScore: count LOWLAND_FERTILE cells in surrounding 20-cell radius ---
      let fertileCount = 0;
      let timberCount = 0;
      let mineralCount = 0;
      let fishingCount = 0;
      let totalHinterland = 0;
      const hinterlandRadius = 20;
      for (let dz = -hinterlandRadius; dz <= hinterlandRadius; dz += 2) {
        for (let dx = -hinterlandRadius; dx <= hinterlandRadius; dx += 2) {
          if (dx * dx + dz * dz > hinterlandRadius * hinterlandRadius) continue;
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
          const nIdx = nz * W + nx;
          if (waterCells.has(nIdx)) continue;
          totalHinterland++;

          const b = biomeArr[nIdx];
          if (b === BIOME_IDS.LOWLAND_FERTILE) fertileCount++;
          if (b === BIOME_IDS.FOREST) timberCount++;
          if (b === BIOME_IDS.MOUNTAIN || b === BIOME_IDS.UPLAND) {
            const res = resourceMap.get(nIdx);
            if (res && res.includes('minerals')) mineralCount++;
          }
          if (b === BIOME_IDS.COASTAL) fishingCount++;
        }
      }
      const hinterlandScore = totalHinterland > 0 ? 15 * (fertileCount / totalHinterland) : 0;
      score += hinterlandScore;

      // --- defenseScore: local elevation maximum ---
      let lowerNeighbors = 0;
      let totalNeighbors = 0;
      for (let dz = -5; dz <= 5; dz++) {
        for (let dx = -5; dx <= 5; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
          totalNeighbors++;
          if (heightmap.get(nx, nz) < elev) lowerNeighbors++;
        }
      }
      const defenseScore = totalNeighbors > 0 ? 25 * (lowerNeighbors / totalNeighbors) : 0;
      score += defenseScore;

      // --- mineralScore: reward mineral-rich hinterland ---
      const mineralScore = totalHinterland > 0 && mineralCount > totalHinterland * 0.15
        ? 20 * (mineralCount / totalHinterland) : 0;
      score += mineralScore;

      // --- inlandBonus: reward positions far from water corridors ---
      // Helps push some settlements (mainly villages) to off-corridor locations
      let inlandBonus = 0;
      {
        let nearWaterCell = false;
        for (let dz = -5; dz <= 5 && !nearWaterCell; dz++) {
          for (let dx = -5; dx <= 5 && !nearWaterCell; dx++) {
            if (dx * dx + dz * dz > 25) continue;
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
              if (waterCells.has(nz * W + nx)) nearWaterCell = true;
            }
          }
        }
        if (!nearWaterCell) inlandBonus = 40;
      }
      score += inlandBonus;

      // --- Geology: spring-line bonus ---
      let springLineBonus = 0;
      if (geology) {
        const { springLine } = geology;
        for (let dz = -5; dz <= 5 && !springLineBonus; dz++) {
          for (let dx = -5; dx <= 5 && !springLineBonus; dx++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx >= 0 && nx < W && nz >= 0 && nz < H) {
              if (springLine[nz * W + nx]) {
                springLineBonus = 25;
              }
            }
          }
        }
      }
      score += springLineBonus;

      // --- Geology: estuary bonus (near coast AND river mouth) ---
      let estuaryBonus = 0;
      if (geology && isNearCoast && minRiverDist <= 5) {
        estuaryBonus = 70;
      }
      score += estuaryBonus;

      // --- Determine dominant scoring factors ---
      const factors = {
        harbor: harborScoreVal,
        crossing: crossingBonus,
        confluence: confluenceScoreVal,
        fertile: hinterlandScore,
        mineral: mineralCount > 0 ? (mineralCount / (totalHinterland || 1)) * 20 : 0,
        fishing: fishingCount > 0 ? (fishingCount / (totalHinterland || 1)) * 15 : 0,
        defensive: defenseScore,
        springLine: springLineBonus,
        estuary: estuaryBonus,
      };

      // --- Compute hinterland proportions ---
      const hintTotal = fertileCount + timberCount + mineralCount + fishingCount;
      const hinterland = {
        agriculture: hintTotal > 0 ? fertileCount / hintTotal : 0,
        timber: hintTotal > 0 ? timberCount / hintTotal : 0,
        minerals: hintTotal > 0 ? mineralCount / hintTotal : 0,
        fishing: hintTotal > 0 ? fishingCount / hintTotal : 0,
      };
      if (hintTotal === 0) {
        hinterland.agriculture = 0.25;
        hinterland.timber = 0.25;
        hinterland.minerals = 0.25;
        hinterland.fishing = 0.25;
      }

      candidates.push({
        gx, gz, score, factors, hinterland,
        elevation: elev,
        isNearCoast,
        minRiverDist,
      });
    }
  }

  // --- Placement algorithm (greedy with spacing) ---
  candidates.sort((a, b) => b.score - a.score);

  const settlements = [];

  function placeRank(rank, maxCount, minSpacing) {
    // Re-score candidates with isolation bonus relative to already-placed settlements
    const ranked = candidates
      .filter(c => !c._taken)
      .map(c => {
        let isolationBonus = 0;
        if (settlements.length > 0) {
          let minPlacedDist = Infinity;
          for (const p of settlements) {
            const d = Math.sqrt((c.gx - p.gx) ** 2 + (c.gz - p.gz) ** 2);
            if (d < minPlacedDist) minPlacedDist = d;
          }
          if (minPlacedDist > 20) isolationBonus = 25;
        }
        return { candidate: c, effectiveScore: c.score + isolationBonus };
      })
      .sort((a, b) => b.effectiveScore - a.effectiveScore);

    let placed = 0;
    for (const { candidate } of ranked) {
      if (placed >= maxCount) break;
      if (candidate._taken) continue;

      // Check spacing against all already-placed settlements of same rank
      let tooClose = false;
      for (const s of settlements) {
        if (s.rank === rank) {
          const d = Math.sqrt(
            (candidate.gx - s.gx) * (candidate.gx - s.gx) +
            (candidate.gz - s.gz) * (candidate.gz - s.gz)
          );
          if (d < minSpacing) {
            tooClose = true;
            break;
          }
        }
      }
      if (tooClose) continue;

      // Also check spacing against higher-rank settlements
      for (const s of settlements) {
        const d = Math.sqrt(
          (candidate.gx - s.gx) * (candidate.gx - s.gx) +
          (candidate.gz - s.gz) * (candidate.gz - s.gz)
        );
        if (d < minSpacing * 0.5) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      // Determine economic role based on dominant factor
      const f = candidate.factors;
      let economicRole = 'market_town';
      let maxFactor = f.fertile;

      if (f.harbor > maxFactor) { economicRole = 'port'; maxFactor = f.harbor; }
      if (f.crossing > maxFactor) { economicRole = 'river_crossing'; maxFactor = f.crossing; }
      if (f.confluence > maxFactor) { economicRole = 'confluence_town'; maxFactor = f.confluence; }
      if (f.mineral > maxFactor) { economicRole = 'mining'; maxFactor = f.mineral; }
      if (f.fishing > maxFactor && economicRole !== 'port') { economicRole = 'fishing'; maxFactor = f.fishing; }
      if (f.defensive > maxFactor) { economicRole = 'pass_town'; }

      // Determine settlement character from geology scoring factors
      let settlementCharacter = 'lowland_town';
      if (geology) {
        // Pick character from highest geology-related factor
        const charFactors = [
          ['estuary_city', f.estuary],
          ['harbor_town', f.harbor],
          ['spring_line_town', f.springLine],
          ['hilltop_fort', f.defensive],
          ['confluence_city', f.confluence],
          ['crossing_town', f.crossing],
        ];
        let maxCharVal = 0;
        for (const [name, val] of charFactors) {
          if (val > maxCharVal) {
            maxCharVal = val;
            settlementCharacter = name;
          }
        }
      }

      const worldPos = heightmap.gridToWorld(candidate.gx, candidate.gz);

      settlements.push({
        x: worldPos.x,
        z: worldPos.z,
        gx: candidate.gx,
        gz: candidate.gz,
        rank,
        economicRole,
        settlementCharacter,
        score: candidate.score,
        elevation: candidate.elevation,
        hinterland: candidate.hinterland,
        roadEntries: [],
      });

      // Mark this and nearby candidates as taken
      candidate._taken = true;
      for (const other of candidates) {
        if (other._taken) continue;
        const d = Math.sqrt(
          (candidate.gx - other.gx) * (candidate.gx - other.gx) +
          (candidate.gz - other.gz) * (candidate.gz - other.gz)
        );
        if (d < minSpacing) {
          other._taken = true;
        }
      }

      placed++;
    }
  }

  placeRank('city', maxCities, minCitySpacing);
  placeRank('town', maxTowns, minTownSpacing);
  placeRank('village', maxVillages, minVillageSpacing);

  // Sort by rank order (city first), then by score descending
  const rankOrder = { city: 0, town: 1, village: 2 };
  settlements.sort((a, b) => {
    const rd = rankOrder[a.rank] - rankOrder[b.rank];
    if (rd !== 0) return rd;
    return b.score - a.score;
  });

  return settlements;
}
