/**
 * A6. Settlement placement.
 * Scored site selection based on geographic advantages:
 * river access, crossing viability, harbor quality, flat land, fertile hinterland,
 * spring line proximity, defensive terrain, and coastline feature quality.
 */

import { Grid2D } from '../core/Grid2D.js';
import { distance2D } from '../core/math.js';

/**
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} [params.cellSize=50]
 * @param {number} [params.seaLevel=0]
 * @param {number} [params.maxSettlements=8]
 * @param {number} [params.minSpacing=20] - Min grid cells between settlements
 * @param {Grid2D} elevation
 * @param {Grid2D} slope
 * @param {Grid2D} soilFertility
 * @param {Grid2D} waterMask
 * @param {Array} confluences - [{gx, gz, flowVolume}]
 * @param {Array} rivers - river tree
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [extras] - Optional extra layers
 * @param {Grid2D} [extras.springLine] - Spring line grid
 * @param {Grid2D} [extras.erosionResistance] - Rock hardness grid
 * @param {Array} [extras.coastlineFeatures] - Tagged coastline features
 * @returns {Array<{gx, gz, tier, score, type}>}
 */
export function generateSettlements(params, elevation, slope, soilFertility, waterMask, confluences, rivers, rng, extras) {
  const {
    width,
    height,
    cellSize = 50,
    seaLevel = 0,
    maxSettlements = 8,
    minSpacing = 20,
  } = params;

  const springLine = extras?.springLine || null;
  const erosionResistance = extras?.erosionResistance || null;
  const coastlineFeatures = extras?.coastlineFeatures || [];

  // Score every land cell
  const scores = new Grid2D(width, height, { cellSize });

  // Pre-compute river proximity
  const riverDist = new Grid2D(width, height, { fill: 999 });
  function markRiverDist(seg) {
    for (const c of seg.cells) {
      for (let dz = -8; dz <= 8; dz++) {
        for (let dx = -8; dx <= 8; dx++) {
          const gx = c.gx + dx;
          const gz = c.gz + dz;
          if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < riverDist.get(gx, gz)) riverDist.set(gx, gz, dist);
        }
      }
    }
    for (const child of (seg.children || [])) markRiverDist(child);
  }
  for (const root of rivers) markRiverDist(root);

  // Pre-compute coast proximity
  const coastDist = new Grid2D(width, height, { fill: 999 });
  for (let gz = 1; gz < height - 1; gz++) {
    for (let gx = 1; gx < width - 1; gx++) {
      if (elevation.get(gx, gz) < seaLevel) continue;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (elevation.get(gx + dx, gz + dz) < seaLevel) {
          // Propagate coast distance
          for (let dz2 = -10; dz2 <= 10; dz2++) {
            for (let dx2 = -10; dx2 <= 10; dx2++) {
              const nx = gx + dx2;
              const nz = gz + dz2;
              if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
              const d = Math.sqrt(dx2 * dx2 + dz2 * dz2);
              if (d < coastDist.get(nx, nz)) coastDist.set(nx, nz, d);
            }
          }
          break;
        }
      }
    }
  }

  // Pre-compute spring line proximity (distance to nearest spring line cell)
  const springDist = new Grid2D(width, height, { fill: 999 });
  if (springLine) {
    const springRadius = 8;
    for (let gz = 0; gz < height; gz++) {
      for (let gx = 0; gx < width; gx++) {
        if (springLine.get(gx, gz) < 0.5) continue;
        // Propagate distance around spring cells
        for (let dz = -springRadius; dz <= springRadius; dz++) {
          for (let dx = -springRadius; dx <= springRadius; dx++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < springDist.get(nx, nz)) springDist.set(nx, nz, d);
          }
        }
      }
    }
  }

  // Pre-index harbor/bay features by location for fast lookup
  const harborCells = new Set();
  const bayCells = new Set();
  for (const feat of coastlineFeatures) {
    const key = `${feat.gx},${feat.gz}`;
    if (feat.type === 'harbor') harborCells.add(key);
    if (feat.type === 'bay') bayCells.add(key);
  }

  // Score each cell
  for (let gz = 2; gz < height - 2; gz++) {
    for (let gx = 2; gx < width - 2; gx++) {
      const h = elevation.get(gx, gz);
      if (h < seaLevel) continue; // no settlements in water

      const s = slope.get(gx, gz);
      if (s > 0.3) continue; // too steep

      let score = 0;

      // Flat land bonus
      score += Math.max(0, 0.3 - s) * 2;

      // River access
      const rDist = riverDist.get(gx, gz);
      if (rDist < 3) score += 0.3;
      else if (rDist < 6) score += 0.15;

      // Fertile hinterland
      let fertilitySum = 0;
      let fertilityCount = 0;
      for (let dz = -5; dz <= 5; dz++) {
        for (let dx = -5; dx <= 5; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < height) {
            fertilitySum += soilFertility.get(nx, nz);
            fertilityCount++;
          }
        }
      }
      score += (fertilitySum / fertilityCount) * 0.2;

      // Harbor (coast proximity with shelter)
      const cDist = coastDist.get(gx, gz);
      if (cDist < 4 && cDist > 0) score += 0.25;

      // --- Spring line bonus ---
      // Settlements near spring lines have reliable water supply
      if (springLine) {
        const sDist2 = springDist.get(gx, gz);
        if (sDist2 < 3) score += 0.2;
        else if (sDist2 < 6) score += 0.1;
      }

      // --- Defensive terrain scoring ---
      // Bonus for hilltop sites (local elevation maximum)
      if (erosionResistance) {
        const myElev = h;
        let isLocalMax = true;
        let neighborCount = 0;
        let higherCount = 0;
        const defRadius = 3;
        for (let dz = -defRadius; dz <= defRadius; dz++) {
          for (let dx = -defRadius; dx <= defRadius; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
            neighborCount++;
            if (elevation.get(nx, nz) > myElev) {
              isLocalMax = false;
              higherCount++;
            }
          }
        }

        if (isLocalMax && neighborCount > 0) {
          // Hilltop defensive bonus
          const resistance = erosionResistance.get(gx, gz);
          // Higher bonus for hard rock outcrops (more defensible)
          score += 0.15 + resistance * 0.1;
        }
      }

      // --- Harbor quality from coastline features ---
      // Bonus for proximity to tagged harbors or sheltered bays
      if (coastlineFeatures.length > 0 && cDist < 8) {
        let nearHarbor = false;
        let nearBay = false;
        const searchR = 6;
        for (let dz = -searchR; dz <= searchR; dz++) {
          for (let dx = -searchR; dx <= searchR; dx++) {
            const key = `${gx + dx},${gz + dz}`;
            if (harborCells.has(key)) nearHarbor = true;
            if (bayCells.has(key)) nearBay = true;
            if (nearHarbor) break;
          }
          if (nearHarbor) break;
        }
        if (nearHarbor) score += 0.3;
        else if (nearBay) score += 0.15;
      }

      // Edge avoidance
      const edgeDist = Math.min(gx, gz, width - 1 - gx, height - 1 - gz);
      if (edgeDist < 5) score *= 0.3;

      scores.set(gx, gz, score);
    }
  }

  // Confluence bonus
  for (const conf of confluences) {
    if (conf.gx >= 0 && conf.gx < width && conf.gz >= 0 && conf.gz < height) {
      scores.set(conf.gx, conf.gz, scores.get(conf.gx, conf.gz) + 0.3);
    }
  }

  // Pick top settlements with minimum spacing
  const candidates = [];
  scores.forEach((gx, gz, val) => {
    if (val > 0.2) candidates.push({ gx, gz, score: val });
  });
  candidates.sort((a, b) => b.score - a.score);

  const settlements = [];
  for (const c of candidates) {
    if (settlements.length >= maxSettlements) break;

    // Check spacing
    let tooClose = false;
    for (const s of settlements) {
      if (distance2D(c.gx, c.gz, s.gx, s.gz) < minSpacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // Assign tier based on score rank
    const tier = settlements.length === 0 ? 1 : settlements.length < 3 ? 2 : 3;

    // Determine type based on site characteristics
    const rDist = riverDist.get(c.gx, c.gz);
    const cDist = coastDist.get(c.gx, c.gz);
    let type = 'crossing';
    if (cDist < 3 && rDist < 5) type = 'estuary';
    else if (cDist < 4) type = 'harbor';
    else if (rDist < 2) type = 'crossing';
    else type = 'hilltop';

    // Check if at confluence
    for (const conf of confluences) {
      if (distance2D(c.gx, c.gz, conf.gx, conf.gz) < 4) {
        type = 'confluence';
        break;
      }
    }

    // Check if near spring line
    if (springLine && type === 'hilltop') {
      const sDist2 = springDist.get(c.gx, c.gz);
      if (sDist2 < 3) type = 'spring';
    }

    settlements.push({
      gx: c.gx,
      gz: c.gz,
      x: c.gx * cellSize,
      z: c.gz * cellSize,
      tier,
      score: c.score,
      type,
    });
  }

  return settlements;
}
