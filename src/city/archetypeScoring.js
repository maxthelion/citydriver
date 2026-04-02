/**
 * Score a settlement against all archetypes.
 * Returns array of { archetype, score, factors } sorted by score desc.
 */

import { ARCHETYPES } from './archetypes.js';
import { reserveLandUse } from './pipeline/reserveLandUse.js';

const WATERFRONT_THRESHOLD = 0.10;
const WATERFRONT_RANGE = 20; // cells

/**
 * Score a settlement's map against all 5 archetypes.
 * @param {object} map - FeatureMap (post-setup, with layers and nuclei)
 * @returns {Array<{archetype: object, score: number, factors: string[]}>}
 */
export function scoreSettlement(map) {
  const terrain = map.getLayer('terrainSuitability');
  const waterDist = map.hasLayer('waterDist') ? map.getLayer('waterDist') : null;
  const { width, height } = map;
  const tier = map.settlement?.tier || 3;
  const wayCount = map.ways
    ? map.ways.filter(r => r.hierarchy === 'arterial' || r.importance > 0.5).length
    : 0;
  const hasRivers = map.rivers && map.rivers.length > 0;

  // Precompute stats
  let buildableCells = 0, waterfrontCells = 0, suitabilitySum = 0, suitabilitySqSum = 0;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const t = terrain.get(gx, gz);
      if (t > 0.1) {
        buildableCells++;
        suitabilitySum += t;
        suitabilitySqSum += t * t;
        if (waterDist && waterDist.get(gx, gz) < WATERFRONT_RANGE) waterfrontCells++;
      }
    }
  }
  const avgSuitability = buildableCells > 0 ? suitabilitySum / buildableCells : 0;
  const variance = buildableCells > 0
    ? suitabilitySqSum / buildableCells - avgSuitability * avgSuitability : 0;
  const waterfrontFraction = buildableCells > 0 ? waterfrontCells / buildableCells : 0;

  const scorers = {
    portCity(arch) {
      const factors = [`${(waterfrontFraction * 100).toFixed(0)}% waterfront cells`];
      if (waterfrontFraction < WATERFRONT_THRESHOLD) {
        return { archetype: arch, score: waterfrontFraction, factors: [...factors, 'No significant waterfront'] };
      }
      return { archetype: arch, score: Math.min(1, waterfrontFraction * 3), factors };
    },
    marketTown(arch) {
      const base = Math.min(1, wayCount / 4);
      const factors = [`${wayCount} road connections`];
      const hasMarket = map.nuclei.some(n => n.type === 'market');
      const score = hasMarket ? Math.min(1, base + 0.2) : base;
      if (hasMarket) factors.push('Has market nucleus');
      return { archetype: arch, score: Math.max(0.3, score), factors };
    },
    gridTown(arch) {
      const factors = [`Average flatness ${avgSuitability.toFixed(2)}`];
      let score = avgSuitability;
      if (variance > 0.04) {
        score *= 0.5;
        factors.push('Terrain too varied for planned grid');
      }
      return { archetype: arch, score, factors };
    },
    industrialTown(arch) {
      const riverScore = hasRivers ? 0.5 : 0;
      const flatScore = avgSuitability > 0.6 ? 0.5 : avgSuitability * 0.5;
      const factors = [];
      if (hasRivers) factors.push('River present');
      else factors.push('No river');
      factors.push(`Flat area score ${flatScore.toFixed(2)}`);
      return { archetype: arch, score: riverScore + flatScore, factors };
    },
    civicCentre(arch) {
      const tierScore = tier <= 2 ? 0.8 : 0.3;
      const connScore = Math.min(0.4, wayCount / 8);
      const factors = [`Settlement tier ${tier}`, `${wayCount} road connections`];
      if (tier > 2) factors.push('Settlement tier too low for regional capital');
      return { archetype: arch, score: tierScore + connScore, factors };
    },
  };

  const results = Object.entries(ARCHETYPES).map(([id, arch]) => {
    return scorers[id](arch);
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Run all 5 archetypes on the same map and return the results.
 * Each result includes the score, factors, and a reservationGrid.
 * The map is not modified — each archetype runs on a fresh grid.
 */
export function compareArchetypes(map) {
  const scores = scoreSettlement(map);

  return scores.map(({ archetype, score, factors }) => {
    // Create a temporary map-like object with shared layers but fresh reservation
    const tempMap = {
      width: map.width,
      height: map.height,
      cellSize: map.cellSize,
      originX: map.originX,
      originZ: map.originZ,
      _layers: new Map(map.layers || map._layers),
      getLayer(name) { return this._layers.get(name); },
      hasLayer(name) { return this._layers.has(name); },
      setLayer(name, grid) { this._layers.set(name, grid); },
      nuclei: map.nuclei,
      developmentZones: map.developmentZones,
    };

    reserveLandUse(tempMap, archetype);

    return {
      archetype,
      score,
      factors,
      reservationGrid: tempMap.getLayer('reservationGrid'),
    };
  });
}
