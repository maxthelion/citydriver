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
};

const SPATIAL_LAYER_NAMES = ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness'];

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
 * Supports behaviour variants: blob, dot, linear, organic, cluster.
 *
 * @param {{gx,gz}} seed - starting cell
 * @param {number} budget - max cells to claim
 * @param {Grid2D} resGrid - reservation grid (read + write)
 * @param {Grid2D} zoneGrid - zone eligibility (read only)
 * @param {number} resType - reservation type to write
 * @param {string} behaviour - 'blob'|'dot'|'linear'|'organic'|'belt'|'cluster'
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

    // Behaviour-specific scoring adjustments
    if (behaviour === 'linear') {
      // Strong preference for road-adjacent cells — commercial should hug roads
      const roadGrid = layers.roadGrid;
      if (roadGrid) {
        let nearRoad = false;
        for (const [dx2, dz2] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = gx + dx2, nz = gz + dz2;
          if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
            nearRoad = true;
            break;
          }
        }
        if (nearRoad) {
          score += 2.0;
        } else {
          score -= 5.0; // strongly penalise spreading away from roads
        }
      }
    } else if (behaviour === 'cluster') {
      // Bonus for cells near same-type reservations
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && resGrid.get(nx, nz) === resType) {
          score += 0.3;
        }
      }
    } else if (behaviour === 'organic') {
      // Add randomness for irregular shapes
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
 * Strategies: roadFrontage, edge, scattered, terrain, fill, arterial, desirable.
 *
 * @param {string} strategy - seed strategy name
 * @param {Array<{gx,gz}>} eligible - eligible cells
 * @param {number} count - max seeds to place
 * @param {[number,number]} footprint - [min, max] cluster size
 * @param {object} affinity - agent affinity weights
 * @param {object} layers - spatial layers (including roadGrid if needed)
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @param {Grid2D} resGrid - current reservation grid (for desirable strategy)
 * @returns {Array<{gx,gz}>} seed locations
 */
export function findSeeds(strategy, eligible, count, footprint, affinity, layers, w, h, resGrid) {
  if (eligible.length === 0 || count === 0) return [];

  // Score all eligible cells
  const scored = eligible.map(c => ({
    gx: c.gx, gz: c.gz,
    score: scoreCellForStrategy(strategy, c.gx, c.gz, affinity, layers, w, h, resGrid),
  }));

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Minimum spacing between seeds
  // 'fill' needs no spacing; 'scattered' uses footprint[1] to ensure spread;
  // other strategies use footprint[0] as a minimum gap.
  const minSpacing = strategy === 'fill' ? 0
    : strategy === 'scattered' ? footprint[1]
    : footprint[0];

  const seeds = [];
  for (const candidate of scored) {
    if (seeds.length >= count) break;

    // Check spacing
    if (minSpacing > 0) {
      let tooClose = false;
      for (const s of seeds) {
        const dx = candidate.gx - s.gx;
        const dz = candidate.gz - s.gz;
        if (dx * dx + dz * dz < minSpacing * minSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
    }

    seeds.push({ gx: candidate.gx, gz: candidate.gz });
  }

  return seeds;
}

/**
 * Score a cell for a specific seed strategy.
 */
function scoreCellForStrategy(strategy, gx, gz, affinity, layers, w, h, resGrid) {
  let base = scoreCell(gx, gz, affinity, layers);

  switch (strategy) {
    case 'roadFrontage': {
      // Must be within 2 cells of a road
      const roadGrid = layers.roadGrid;
      if (!roadGrid) return -Infinity;
      let nearRoad = false;
      for (let dz = -2; dz <= 2 && !nearRoad; dz++) {
        for (let dx = -2; dx <= 2 && !nearRoad; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
            nearRoad = true;
          }
        }
      }
      return nearRoad ? base + 1.0 : -Infinity;
    }

    case 'edge':
      // Prefer outer cells (edgeness layer does this via affinity)
      return base;

    case 'scattered':
      return base;

    case 'terrain':
      return base;

    case 'fill':
      return base + Math.random() * 0.1; // slight randomness for variety

    case 'arterial': {
      const roadGrid = layers.roadGrid;
      if (!roadGrid || roadGrid.get(gx, gz) === 0) return -Infinity;
      // Bonus for cells with many unclaimed neighbours
      let freeNeighbours = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && resGrid.get(nx, nz) === 0) {
          freeNeighbours++;
        }
      }
      return base + freeNeighbours * 0.1;
    }

    case 'desirable': {
      // Must have high land value and no industrial nearby
      const landValue = layers.landValue;
      if (landValue && landValue.get(gx, gz) < 0.5) return -Infinity;
      // Check for industrial within 20 cells (sample cardinal directions)
      for (let d = 1; d <= 20; d++) {
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = gx + dx * d, nz = gz + dz * d;
          if (nx >= 0 && nx < w && nz >= 0 && nz < h && resGrid.get(nx, nz) === RESERVATION.INDUSTRIAL) {
            return -Infinity;
          }
        }
      }
      return base;
    }

    default:
      return base;
  }
}
