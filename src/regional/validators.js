/**
 * Regional validators.
 * Validators for geology, terrain, hydrology, coastline, land cover, settlements, roads.
 */

import { getRockInfo } from './generateGeology.js';

// ============================================================
// Phase 3 validators: Geology + Terrain
// ============================================================

/**
 * V_elevationFinite (T1): No NaN or Infinity in elevation grid.
 */
export const V_elevationFinite = {
  name: 'V_elevationFinite',
  tier: 1,
  fn(layers) {
    const elev = layers.getGrid('elevation');
    if (!elev) return false;
    for (let i = 0; i < elev.data.length; i++) {
      if (!isFinite(elev.data[i])) return false;
    }
    return true;
  },
};

/**
 * S_rockElevationCorrelation (T2): Hard rock correlates with higher elevation.
 */
export const S_rockElevationCorrelation = {
  name: 'S_rockElevationCorrelation',
  tier: 2,
  fn(layers) {
    const elev = layers.getGrid('elevation');
    const resistance = layers.getGrid('erosionResistance');
    if (!elev || !resistance) return 0;

    // Compare mean elevation of hard rock vs soft rock cells
    let hardSum = 0, hardCount = 0;
    let softSum = 0, softCount = 0;
    const seaLevel = layers.getData('params')?.seaLevel ?? 0;

    for (let gz = 0; gz < elev.height; gz++) {
      for (let gx = 0; gx < elev.width; gx++) {
        const h = elev.get(gx, gz);
        if (h < seaLevel) continue; // skip water
        const r = resistance.get(gx, gz);
        if (r > 0.5) { hardSum += h; hardCount++; }
        else { softSum += h; softCount++; }
      }
    }

    if (hardCount === 0 || softCount === 0) return 0.5;

    const hardMean = hardSum / hardCount;
    const softMean = softSum / softCount;

    // Score: 1.0 if hard rock mean is notably higher, 0 if reversed
    if (hardMean > softMean) return Math.min(1, (hardMean - softMean) / 20 + 0.5);
    return Math.max(0, 0.5 - (softMean - hardMean) / 20);
  },
};

/**
 * S_terrainSmoothness (T2): Terrain is smooth (low proportion of extreme slope cells).
 */
export const S_terrainSmoothness = {
  name: 'S_terrainSmoothness',
  tier: 2,
  fn(layers) {
    const slope = layers.getGrid('slope');
    if (!slope) return 0;

    let extremeCount = 0;
    let total = 0;

    slope.forEach((gx, gz, val) => {
      if (gx === 0 || gz === 0 || gx === slope.width - 1 || gz === slope.height - 1) return;
      total++;
      if (val > 0.5) extremeCount++; // > 50% gradient is extreme
    });

    if (total === 0) return 1;
    const extremeFraction = extremeCount / total;
    // Score: 1.0 if < 5% extreme, 0 if > 30% extreme
    return Math.max(0, Math.min(1, (0.3 - extremeFraction) / 0.25));
  },
};

// ============================================================
// Phase 4 validators: Hydrology + Coastline
// ============================================================

/**
 * V_riversFlowDownhill (T1): Every river cell is lower than its upstream neighbor.
 */
export const V_riversFlowDownhill = {
  name: 'V_riversFlowDownhill',
  tier: 1,
  fn(layers) {
    const rivers = layers.getData('rivers');
    if (!rivers || rivers.length === 0) return true;

    function checkSegment(seg) {
      for (let i = 1; i < seg.cells.length; i++) {
        if (seg.cells[i].elevation > seg.cells[i - 1].elevation + 0.01) {
          return false;
        }
      }
      for (const child of (seg.children || [])) {
        if (!checkSegment(child)) return false;
      }
      return true;
    }

    return rivers.every(checkSegment);
  },
};

/**
 * V_riversConverge (T1): Rivers never branch downstream (only converge).
 */
export const V_riversConverge = {
  name: 'V_riversConverge',
  tier: 1,
  fn(layers) {
    const rivers = layers.getData('rivers');
    if (!rivers) return true;
    // The tree structure inherently means rivers converge (children flow into parent).
    // A violation would be a cell appearing in multiple segments.
    const seen = new Set();
    function checkSegment(seg) {
      for (const c of seg.cells) {
        const key = `${c.gx},${c.gz}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
      for (const child of (seg.children || [])) {
        if (!checkSegment(child)) return false;
      }
      return true;
    }
    return rivers.every(checkSegment);
  },
};

/**
 * S_riverWidthIncrease (T2): Rivers widen downstream.
 */
export const S_riverWidthIncrease = {
  name: 'S_riverWidthIncrease',
  tier: 2,
  fn(layers) {
    const rivers = layers.getData('rivers');
    if (!rivers || rivers.length === 0) return 1;

    let correct = 0;
    let total = 0;

    function checkSegment(seg) {
      if (seg.cells.length >= 2) {
        const firstAcc = seg.cells[0].accumulation;
        const lastAcc = seg.cells[seg.cells.length - 1].accumulation;
        total++;
        if (lastAcc >= firstAcc) correct++;
      }
      for (const child of (seg.children || [])) {
        checkSegment(child);
      }
    }

    rivers.forEach(checkSegment);
    return total > 0 ? correct / total : 1;
  },
};

/**
 * S_coastlineGeologyCorrelation (T2): Headlands correlate with hard rock.
 */
export const S_coastlineGeologyCorrelation = {
  name: 'S_coastlineGeologyCorrelation',
  tier: 2,
  fn(layers) {
    const elev = layers.getGrid('elevation');
    const resistance = layers.getGrid('erosionResistance');
    if (!elev || !resistance) return 0.5;

    const seaLevel = layers.getData('params')?.seaLevel ?? 0;
    let hardCoastal = 0, hardCoastalLand = 0;
    let softCoastal = 0, softCoastalLand = 0;

    for (let gz = 1; gz < elev.height - 1; gz++) {
      for (let gx = 1; gx < elev.width - 1; gx++) {
        const h = elev.get(gx, gz);
        // Check if coastal (land cell adjacent to water)
        let isCoastal = false;
        if (h >= seaLevel) {
          for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            if (elev.get(gx + dx, gz + dz) < seaLevel) { isCoastal = true; break; }
          }
        }
        if (!isCoastal) continue;

        const r = resistance.get(gx, gz);
        if (r > 0.5) {
          hardCoastal++;
          hardCoastalLand++;
        } else {
          softCoastal++;
          softCoastalLand++;
        }
      }
    }

    // Headlands are places where coastline protrudes.
    // Simple proxy: hard rock coastline should exist (not be all eroded away)
    const totalCoastal = hardCoastal + softCoastal;
    if (totalCoastal < 10) return 0.5;

    // Score based on hard rock having more coastal presence (headlands)
    const hardFraction = hardCoastal / totalCoastal;
    return Math.min(1, hardFraction * 2); // 50% hard coastal = perfect
  },
};

/**
 * Q_coastlineFractalDimension (T3): Coastline has fractal detail, not axis-aligned.
 */
export const Q_coastlineFractalDimension = {
  name: 'Q_coastlineFractalDimension',
  tier: 3,
  fn(layers) {
    const elev = layers.getGrid('elevation');
    if (!elev) return 0;

    const seaLevel = layers.getData('params')?.seaLevel ?? 0;

    // Count coastal cells and measure direction diversity
    let coastCells = 0;
    let horzEdges = 0;
    let vertEdges = 0;
    let diagEdges = 0;

    for (let gz = 1; gz < elev.height - 1; gz++) {
      for (let gx = 1; gx < elev.width - 1; gx++) {
        if (elev.get(gx, gz) < seaLevel) continue;

        // Check all 8 neighbors
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          if (elev.get(gx + dx, gz + dz) < seaLevel) {
            coastCells++;
            if (dx === 0) vertEdges++;
            else if (dz === 0) horzEdges++;
            else diagEdges++;
            break; // count each cell once
          }
        }
      }
    }

    if (coastCells < 20) return 0.5;

    // Score: coastline should have mix of directions (not just axis-aligned)
    const total = horzEdges + vertEdges + diagEdges;
    if (total === 0) return 0.5;
    const diagFraction = diagEdges / total;
    // Good coastlines have ~30-50% diagonal edges
    return Math.min(1, diagFraction * 3);
  },
};

// ============================================================
// Phase 5 validators: Land Cover + Settlements + Roads
// ============================================================

/**
 * S_elevationZonation (T2): Farmland in lowlands, forest mid, moorland high.
 */
export const S_elevationZonation = {
  name: 'S_elevationZonation',
  tier: 2,
  fn(layers) {
    const elev = layers.getGrid('elevation');
    const landCover = layers.getGrid('landCover');
    if (!elev || !landCover) return 0;

    const seaLevel = layers.getData('params')?.seaLevel ?? 0;
    let correct = 0;
    let total = 0;

    // landCover values: 0=water, 1=farmland, 2=forest, 3=moorland, 4=marsh,
    //   5=settlement, 6=open woodland, 7=bare rock, 8=scrubland
    landCover.forEach((gx, gz, cover) => {
      const h = elev.get(gx, gz);
      if (h < seaLevel || cover === 0) return;

      total++;
      const relativeH = h - seaLevel;

      if (cover === 1 && relativeH < 40) correct++; // farmland in lowlands
      else if (cover === 2 && relativeH >= 5 && relativeH < 65) correct++; // forest low-mid (widened range)
      else if (cover === 3 && relativeH >= 30) correct++; // moorland high
      else if (cover === 4) correct++; // marsh anywhere wet is fine
      else if (cover === 5) correct++; // settlements anywhere reasonable
      else if (cover === 6 && relativeH >= 20 && relativeH < 65) correct++; // open woodland mid-high
      else if (cover === 7 && (relativeH >= 20)) correct++; // bare rock at altitude or steep
      else if (cover === 8) correct++; // scrubland is flexible
      else correct += 0.3; // partial credit
    });

    return total > 0 ? correct / total : 0;
  },
};

/**
 * V_settlementsOnLand (T1): No settlements in water.
 */
export const V_settlementsOnLand = {
  name: 'V_settlementsOnLand',
  tier: 1,
  fn(layers) {
    const settlements = layers.getData('settlements');
    const elev = layers.getGrid('elevation');
    if (!settlements || !elev) return true;

    const seaLevel = layers.getData('params')?.seaLevel ?? 0;

    for (const s of settlements) {
      const h = elev.get(s.gx, s.gz);
      if (h < seaLevel) return false;
    }
    return true;
  },
};

/**
 * S_settlementSiteQuality (T2): Settlements at geographically advantaged sites.
 */
export const S_settlementSiteQuality = {
  name: 'S_settlementSiteQuality',
  tier: 2,
  fn(layers) {
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length === 0) return 1;

    let totalScore = 0;
    for (const s of settlements) {
      totalScore += (s.score || 0);
    }

    // Normalize: settlements should have reasonable scores (> 0.3 average)
    const avgScore = totalScore / settlements.length;
    return Math.min(1, avgScore / 0.5);
  },
};

/**
 * S_roadTerrainFollowing (T2): Roads follow valleys and passes.
 */
export const S_roadTerrainFollowing = {
  name: 'S_roadTerrainFollowing',
  tier: 2,
  fn(layers) {
    const roads = layers.getData('roads');
    const slope = layers.getGrid('slope');
    if (!roads || !slope) return 0.5;

    let totalSlope = 0;
    let count = 0;

    for (const road of roads) {
      if (!road.path) continue;
      for (const p of road.path) {
        const gx = p.gx ?? 0;
        const gz = p.gz ?? 0;
        totalSlope += slope.get(gx, gz);
        count++;
      }
    }

    if (count === 0) return 0.5;
    const avgSlope = totalSlope / count;
    // Roads should have low average slope (< 0.15 is good)
    return Math.max(0, Math.min(1, (0.3 - avgSlope) / 0.3));
  },
};

/**
 * Collect all validators for a given phase.
 */
export function getRegionalValidators(phase) {
  const validators = [];

  if (phase >= 3) {
    validators.push(V_elevationFinite, S_rockElevationCorrelation, S_terrainSmoothness);
  }
  if (phase >= 4) {
    validators.push(V_riversFlowDownhill, V_riversConverge, S_riverWidthIncrease, S_coastlineGeologyCorrelation, Q_coastlineFractalDimension);
  }
  if (phase >= 5) {
    validators.push(S_elevationZonation, V_settlementsOnLand, S_settlementSiteQuality, S_roadTerrainFollowing);
  }

  return validators;
}
