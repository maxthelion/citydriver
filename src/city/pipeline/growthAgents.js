/**
 * Growth agent system for incremental zoning.
 *
 * Reservation types (uint8 values in reservationGrid):
 */
export const RESERVATION = {
  NONE: 0,
  COMMERCIAL: 1,
  INDUSTRIAL: 2,
  CIVIC: 3,
  OPEN_SPACE: 4,
  AGRICULTURE: 5,
  RESIDENTIAL_FINE: 6,
  RESIDENTIAL_ESTATE: 7,
  RESIDENTIAL_QUALITY: 8,
  PORT: 9,
};

export const AGENT_TYPE_TO_RESERVATION = {
  commercial: RESERVATION.COMMERCIAL,
  industrial: RESERVATION.INDUSTRIAL,
  civic: RESERVATION.CIVIC,
  openSpace: RESERVATION.OPEN_SPACE,
  agriculture: RESERVATION.AGRICULTURE,
  residentialFine: RESERVATION.RESIDENTIAL_FINE,
  residentialEstate: RESERVATION.RESIDENTIAL_ESTATE,
  residentialQuality: RESERVATION.RESIDENTIAL_QUALITY,
  port: RESERVATION.PORT,
};

const SPATIAL_LAYER_NAMES = ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness', 'developmentProximity', 'industrialDistance'];

/**
 * Score a cell for a given agent affinity against spatial layers.
 * @param {number} gx - grid x
 * @param {number} gz - grid z
 * @param {object} affinity - { layerName: weight, ... }
 * @param {object} layers - { layerName: Grid2D, ... }
 * @returns {number} weighted score
 */
export function scoreCell(gx, gz, affinity, layers) {
  let score = 0;
  for (const [name, weight] of Object.entries(affinity)) {
    const grid = layers[name];
    if (grid) {
      score += weight * grid.get(gx, gz);
    }
  }
  return score;
}

/**
 * BFS spread from a seed cell. Claims cells on resGrid up to budget.
 * Supports behaviour variants: scored, dot, organic.
 *
 * @param {{gx,gz}} seed - starting cell
 * @param {number} budget - max cells to claim
 * @param {Grid2D} resGrid - reservation grid (read + write)
 * @param {Grid2D} zoneGrid - zone eligibility (read only)
 * @param {number} resType - reservation type to write
 * @param {string} behaviour - 'scored'|'dot'|'organic'
 * @param {object} affinity - agent affinity weights
 * @param {object} layers - spatial layers
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @returns {Array<{gx,gz}>} claimed cells
 */
export function spreadFromSeed(seed, budget, resGrid, zoneGrid, resType, behaviour, affinity, layers, w, h) {
  if (behaviour === 'dot') {
    if (resGrid.get(seed.gx, seed.gz) === RESERVATION.NONE && zoneGrid.get(seed.gx, seed.gz) > 0) {
      resGrid.set(seed.gx, seed.gz, resType);
      return [{ gx: seed.gx, gz: seed.gz }];
    }
    return [];
  }

  const claimed = [];
  const visited = new Set();
  const key = (x, z) => x | (z << 16);

  // Priority queue as sorted array (simple for moderate budgets)
  const frontier = [];

  const tryAdd = (gx, gz) => {
    const k = key(gx, gz);
    if (visited.has(k)) return;
    if (gx < 0 || gx >= w || gz < 0 || gz >= h) return;
    if (zoneGrid.get(gx, gz) === 0) return;
    if (resGrid.get(gx, gz) !== RESERVATION.NONE) return;
    visited.add(k);

    let score = scoreCell(gx, gz, affinity, layers);

    // Only variation: organic adds noise for irregular shapes
    if (behaviour === 'organic') {
      score += Math.random() * 0.3;
    }

    frontier.push({ gx, gz, score });
  };

  // Seed the frontier
  visited.add(key(seed.gx, seed.gz));
  resGrid.set(seed.gx, seed.gz, resType);
  claimed.push({ gx: seed.gx, gz: seed.gz });

  // Add seed neighbours
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    tryAdd(seed.gx + dx, seed.gz + dz);
  }

  while (claimed.length < budget && frontier.length > 0) {
    // Pick best candidate
    frontier.sort((a, b) => b.score - a.score);
    const best = frontier.shift();

    resGrid.set(best.gx, best.gz, resType);
    claimed.push({ gx: best.gx, gz: best.gz });

    // Add neighbours of claimed cell
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      tryAdd(best.gx + dx, best.gz + dz);
    }
  }

  return claimed;
}

/**
 * Find seed locations for a growth agent.
 * Scores all eligible cells via scoreCell, sorts descending, picks top N with minSpacing.
 *
 * @param {Array<{gx,gz}>} eligible - eligible cells
 * @param {number} count - max seeds to place
 * @param {number} minSpacing - minimum distance between seeds (in cells)
 * @param {object} affinity - agent affinity weights
 * @param {object} layers - spatial layers
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @returns {Array<{gx,gz}>} seed locations
 */
export function findSeeds(eligible, count, minSpacing, affinity, layers, w, h) {
  if (eligible.length === 0 || count === 0) return [];

  const scored = eligible.map(c => ({
    gx: c.gx, gz: c.gz,
    score: scoreCell(c.gx, c.gz, affinity, layers),
  }));
  scored.sort((a, b) => b.score - a.score);

  const seeds = [];
  for (const candidate of scored) {
    if (seeds.length >= count) break;
    if (minSpacing > 0) {
      let tooClose = false;
      for (const s of seeds) {
        const dx = candidate.gx - s.gx, dz = candidate.gz - s.gz;
        if (dx * dx + dz * dz < minSpacing * minSpacing) { tooClose = true; break; }
      }
      if (tooClose) continue;
    }
    seeds.push({ gx: candidate.gx, gz: candidate.gz });
  }
  return seeds;
}
