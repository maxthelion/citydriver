# Incremental Zoning — Core Engine (Market Town) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-pass `reserveLandUse` with a multi-tick growth agent system, wired up for the market town archetype and visible in the debug/compare screens.

**Architecture:** Create a growth tick runner that expands a development radius per nucleus and runs per-use-type growth agents (seed + spread) within each ring. Agents consume existing spatial layers and write to the same reservationGrid. Wire into LandFirstDevelopment as variable-length ticks replacing the single reserveLandUse call. Add new reservation type colours to the debug layer.

**Tech Stack:** Vanilla JS, Grid2D, existing FeatureMap/spatial layers infrastructure.

---

## File Structure

| File | Role |
|------|------|
| `src/city/pipeline/growthAgents.js` (create) | Reservation constants, cell scoring, seed strategies, spread behaviours |
| `src/city/pipeline/growthTick.js` (create) | Per-tick orchestration: expand radius, run agents, fill agriculture |
| `src/city/archetypes.js` (modify) | Add `growth` config to marketTown alongside existing config (keep old fields for other archetypes) |
| `src/city/strategies/landFirstDevelopment.js` (modify) | Variable-length growth ticks replacing single reserveLandUse call |
| `src/rendering/debugLayers.js` (modify) | Expanded reservation colours for 8 types |
| `src/core/FeatureMap.js` (modify) | Clone growthState |
| `test/city/pipeline/growthAgents.test.js` (create) | Unit tests for scoring, seeding, spreading |
| `test/city/pipeline/growthTick.test.js` (create) | Integration tests for tick orchestration |

---

## Chunk 1: Foundation — Constants, Scoring, and Spread

### Task 1: Reservation constants and cell scoring

**Files:**
- Create: `src/city/pipeline/growthAgents.js`
- Test: `test/city/pipeline/growthAgents.test.js`

- [ ] **Step 1: Write the failing test for reservation constants and scoring**

```js
// test/city/pipeline/growthAgents.test.js
import { describe, it, expect } from 'vitest';
import { RESERVATION, scoreCell } from '../../src/city/pipeline/growthAgents.js';

describe('RESERVATION constants', () => {
  it('defines all 9 reservation types', () => {
    expect(RESERVATION.NONE).toBe(0);
    expect(RESERVATION.COMMERCIAL).toBe(1);
    expect(RESERVATION.INDUSTRIAL).toBe(2);
    expect(RESERVATION.CIVIC).toBe(3);
    expect(RESERVATION.OPEN_SPACE).toBe(4);
    expect(RESERVATION.AGRICULTURE).toBe(5);
    expect(RESERVATION.RESIDENTIAL_FINE).toBe(6);
    expect(RESERVATION.RESIDENTIAL_ESTATE).toBe(7);
    expect(RESERVATION.RESIDENTIAL_QUALITY).toBe(8);
  });
});

describe('scoreCell', () => {
  it('returns weighted sum of spatial layer values', () => {
    const affinity = { centrality: 0.6, roadFrontage: 0.4 };
    const layers = {
      centrality: { get: () => 0.8 },
      roadFrontage: { get: () => 0.5 },
    };
    const score = scoreCell(10, 10, affinity, layers);
    // 0.6 * 0.8 + 0.4 * 0.5 = 0.48 + 0.20 = 0.68
    expect(score).toBeCloseTo(0.68);
  });

  it('handles negative affinity weights', () => {
    const affinity = { centrality: -0.2 };
    const layers = { centrality: { get: () => 0.5 } };
    expect(scoreCell(0, 0, affinity, layers)).toBeCloseTo(-0.1);
  });

  it('ignores missing layers', () => {
    const affinity = { centrality: 0.5, waterfrontness: 0.5 };
    const layers = { centrality: { get: () => 1.0 } };
    expect(scoreCell(0, 0, affinity, layers)).toBeCloseTo(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/growthAgents.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```js
// src/city/pipeline/growthAgents.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/growthAgents.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/growthAgents.js test/city/pipeline/growthAgents.test.js
git commit -m "feat: add reservation constants and cell scoring for growth agents"
```

### Task 2: Spread behaviours

**Files:**
- Modify: `src/city/pipeline/growthAgents.js`
- Test: `test/city/pipeline/growthAgents.test.js`

All spread behaviours are BFS variants. Implement a single `spreadFromSeed` function with a `behaviour` parameter that controls neighbour ordering/weighting.

- [ ] **Step 1: Write the failing test for spread behaviours**

Add to `test/city/pipeline/growthAgents.test.js`:

```js
import { RESERVATION, scoreCell, spreadFromSeed } from '../../src/city/pipeline/growthAgents.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('spreadFromSeed', () => {
  function makeGrid(w, h) {
    return new Grid2D(w, h, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
  }

  it('blob: grows outward from seed up to budget', () => {
    const resGrid = makeGrid(20, 20);
    const zoneGrid = makeGrid(20, 20);
    // Mark all cells as zone-eligible
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        zoneGrid.set(x, z, 1);

    const claimed = spreadFromSeed(
      { gx: 10, gz: 10 }, 12, resGrid, zoneGrid,
      RESERVATION.INDUSTRIAL, 'blob', {}, {}, 20, 20
    );
    expect(claimed.length).toBe(12);
    // All claimed cells should be marked in resGrid
    for (const c of claimed) {
      expect(resGrid.get(c.gx, c.gz)).toBe(RESERVATION.INDUSTRIAL);
    }
  });

  it('dot: claims only the seed cell', () => {
    const resGrid = makeGrid(10, 10);
    const zoneGrid = makeGrid(10, 10);
    zoneGrid.set(5, 5, 1);

    const claimed = spreadFromSeed(
      { gx: 5, gz: 5 }, 20, resGrid, zoneGrid,
      RESERVATION.CIVIC, 'dot', {}, {}, 10, 10
    );
    expect(claimed.length).toBe(1);
    expect(claimed[0]).toEqual({ gx: 5, gz: 5 });
  });

  it('does not overwrite existing reservations', () => {
    const resGrid = makeGrid(10, 10);
    const zoneGrid = makeGrid(10, 10);
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 10; x++)
        zoneGrid.set(x, z, 1);
    // Pre-fill some cells
    resGrid.set(5, 4, RESERVATION.COMMERCIAL);
    resGrid.set(5, 6, RESERVATION.COMMERCIAL);

    const claimed = spreadFromSeed(
      { gx: 5, gz: 5 }, 5, resGrid, zoneGrid,
      RESERVATION.INDUSTRIAL, 'blob', {}, {}, 10, 10
    );
    // Should not have overwritten the commercial cells
    expect(resGrid.get(5, 4)).toBe(RESERVATION.COMMERCIAL);
    expect(resGrid.get(5, 6)).toBe(RESERVATION.COMMERCIAL);
  });

  it('does not spread outside zone cells', () => {
    const resGrid = makeGrid(10, 10);
    const zoneGrid = makeGrid(10, 10);
    // Only a 3x3 zone
    for (let z = 4; z <= 6; z++)
      for (let x = 4; x <= 6; x++)
        zoneGrid.set(x, z, 1);

    const claimed = spreadFromSeed(
      { gx: 5, gz: 5 }, 20, resGrid, zoneGrid,
      RESERVATION.INDUSTRIAL, 'blob', {}, {}, 10, 10
    );
    expect(claimed.length).toBe(9); // bounded by zone
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/growthAgents.test.js`
Expected: FAIL — `spreadFromSeed` not exported

- [ ] **Step 3: Implement spreadFromSeed**

Add to `src/city/pipeline/growthAgents.js`:

```js
/**
 * BFS spread from a seed cell. Claims cells on resGrid up to budget.
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
      // Bonus for road-adjacent cells
      const roadGrid = layers.roadGrid;
      if (roadGrid && roadGrid.get(gx, gz) > 0) score += 1.0;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/growthAgents.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/growthAgents.js test/city/pipeline/growthAgents.test.js
git commit -m "feat: add spreadFromSeed BFS with behaviour variants"
```

### Task 3: Seed strategies

**Files:**
- Modify: `src/city/pipeline/growthAgents.js`
- Test: `test/city/pipeline/growthAgents.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/city/pipeline/growthAgents.test.js`:

```js
import { RESERVATION, scoreCell, spreadFromSeed, findSeeds } from '../../src/city/pipeline/growthAgents.js';

describe('findSeeds', () => {
  function makeGrid(w, h) {
    return new Grid2D(w, h, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
  }

  it('roadFrontage: returns cells near roads', () => {
    const resGrid = makeGrid(20, 20);
    const zoneGrid = makeGrid(20, 20);
    const roadGrid = new Grid2D(20, 20, { type: 'uint8', cellSize: 5, originX: 0, originZ: 0 });
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        zoneGrid.set(x, z, 1);
    // Road along row 10
    for (let x = 0; x < 20; x++) roadGrid.set(x, 10, 1);

    const eligible = [];
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        if (resGrid.get(x, z) === 0 && zoneGrid.get(x, z) > 0)
          eligible.push({ gx: x, gz: z });

    const seeds = findSeeds('roadFrontage', eligible, 3, [4, 20],
      { roadFrontage: 0.8 }, { roadGrid, roadFrontage: roadGrid }, 20, 20, resGrid);
    expect(seeds.length).toBeLessThanOrEqual(3);
    // All seeds should be near the road (gz 9, 10, or 11)
    for (const s of seeds) {
      expect(Math.abs(s.gz - 10)).toBeLessThanOrEqual(2);
    }
  });

  it('scattered: returns spaced-apart seeds', () => {
    const resGrid = makeGrid(30, 30);
    const zoneGrid = makeGrid(30, 30);
    for (let z = 0; z < 30; z++)
      for (let x = 0; x < 30; x++)
        zoneGrid.set(x, z, 1);

    const eligible = [];
    for (let z = 0; z < 30; z++)
      for (let x = 0; x < 30; x++)
        eligible.push({ gx: x, gz: z });

    const seeds = findSeeds('scattered', eligible, 3, [3, 10],
      { centrality: 0.5 }, { centrality: { get: () => 0.5 } }, 30, 30, resGrid);
    expect(seeds.length).toBe(3);
    // Check minimum spacing: 3 * footprint[1] = 30 cells apart
    // On a 30x30 grid this means seeds must be spread out
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        const dx = seeds[i].gx - seeds[j].gx;
        const dz = seeds[i].gz - seeds[j].gz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        expect(dist).toBeGreaterThan(5); // at least some spacing
      }
    }
  });

  it('fill: returns many seeds without spacing constraint', () => {
    const resGrid = makeGrid(10, 10);
    const zoneGrid = makeGrid(10, 10);
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 10; x++)
        zoneGrid.set(x, z, 1);

    const eligible = [];
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 10; x++)
        eligible.push({ gx: x, gz: z });

    const seeds = findSeeds('fill', eligible, 5, [2, 15],
      {}, {}, 10, 10, resGrid);
    expect(seeds.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/growthAgents.test.js`
Expected: FAIL — `findSeeds` not exported

- [ ] **Step 3: Implement findSeeds**

Add to `src/city/pipeline/growthAgents.js`:

```js
/**
 * Find seed locations for a growth agent.
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
  const minSpacing = strategy === 'fill' ? 0
    : strategy === 'scattered' ? 3 * footprint[1]
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/growthAgents.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/growthAgents.js test/city/pipeline/growthAgents.test.js
git commit -m "feat: add findSeeds with strategy-specific scoring"
```

---

## Chunk 2: Growth Tick Runner

### Task 4: Growth tick orchestration

**Files:**
- Create: `src/city/pipeline/growthTick.js`
- Test: `test/city/pipeline/growthTick.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/city/pipeline/growthTick.test.js
import { describe, it, expect } from 'vitest';
import { initGrowthState, runGrowthTick } from '../../src/city/pipeline/growthTick.js';
import { RESERVATION } from '../../src/city/pipeline/growthAgents.js';
import { Grid2D } from '../../src/core/Grid2D.js';

// Minimal map stub
function makeTestMap(w, h) {
  const cs = 5;
  const map = {
    width: w, height: h, cellSize: cs,
    originX: 0, originZ: 0,
    nuclei: [{ gx: Math.floor(w / 2), gz: Math.floor(h / 2) }],
    developmentZones: [],
    hasLayer: function(n) { return this._layers.has(n); },
    getLayer: function(n) { return this._layers.get(n); },
    setLayer: function(n, g) { this._layers.set(n, g); },
    _layers: new Map(),
  };

  // Create zone covering entire grid
  const cells = [];
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      cells.push({ gx: x, gz: z });
  map.developmentZones = [{ cells, nucleusIdx: 0 }];

  // Create zone grid
  const zoneGrid = new Grid2D(w, h, { type: 'uint8', cellSize: cs, originX: 0, originZ: 0 });
  for (const c of cells) zoneGrid.set(c.gx, c.gz, 1);
  map.setLayer('zoneGrid', zoneGrid);

  // Spatial layers (uniform for testing)
  for (const name of ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness']) {
    const g = new Grid2D(w, h, { type: 'float32', cellSize: cs, originX: 0, originZ: 0 });
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        g.set(x, z, 0.5);
    map.setLayer(name, g);
  }

  // Road grid with cross roads
  const roadGrid = new Grid2D(w, h, { type: 'uint8', cellSize: cs, originX: 0, originZ: 0 });
  for (let x = 0; x < w; x++) roadGrid.set(x, Math.floor(h / 2), 1);
  for (let z = 0; z < h; z++) roadGrid.set(Math.floor(w / 2), z, 1);
  map.setLayer('roadGrid', roadGrid);

  // Land value
  const lv = new Grid2D(w, h, { type: 'float32', cellSize: cs, originX: 0, originZ: 0 });
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      lv.set(x, z, 0.6);
  map.setLayer('landValue', lv);

  return map;
}

describe('initGrowthState', () => {
  it('creates state with radius 0 for each nucleus', () => {
    const map = makeTestMap(40, 40);
    const archetype = {
      growth: {
        radiusStep: 200,
        maxGrowthTicks: 8,
        agentPriority: ['commercial'],
        agents: {
          commercial: { share: 0.1, seedStrategy: 'fill', spreadBehaviour: 'blob',
                        footprint: [2, 10], affinity: {}, seedsPerTick: 1 },
        },
      },
    };
    const state = initGrowthState(map, archetype);
    expect(state.tick).toBe(0);
    expect(state.nucleusRadii.get(0)).toBe(0);
    expect(state.claimedCounts.get('commercial')).toBe(0);
  });
});

describe('runGrowthTick', () => {
  it('claims cells and increments tick', () => {
    const map = makeTestMap(40, 40);
    const archetype = {
      growth: {
        radiusStep: 100, // 20 cells at 5m/cell
        maxGrowthTicks: 8,
        agentPriority: ['commercial'],
        agents: {
          commercial: { share: 0.5, seedStrategy: 'fill', spreadBehaviour: 'blob',
                        footprint: [2, 10], affinity: { centrality: 0.5 }, seedsPerTick: 2 },
        },
      },
    };
    const state = initGrowthState(map, archetype);
    const done = runGrowthTick(map, archetype, state);

    expect(state.tick).toBe(1);
    expect(state.nucleusRadii.get(0)).toBeGreaterThan(0);
    // Some cells should be claimed
    const resGrid = map.getLayer('reservationGrid');
    expect(resGrid).toBeTruthy();
    let claimed = 0;
    for (let z = 0; z < 40; z++)
      for (let x = 0; x < 40; x++)
        if (resGrid.get(x, z) > 0) claimed++;
    expect(claimed).toBeGreaterThan(0);
    expect(done).toBe(false); // not terminated yet
  });

  it('terminates when maxGrowthTicks reached', () => {
    const map = makeTestMap(20, 20);
    const archetype = {
      growth: {
        radiusStep: 500, // large — covers whole map
        maxGrowthTicks: 2,
        agentPriority: ['commercial'],
        agents: {
          commercial: { share: 0.01, seedStrategy: 'fill', spreadBehaviour: 'dot',
                        footprint: [1, 1], affinity: {}, seedsPerTick: 1 },
        },
      },
    };
    const state = initGrowthState(map, archetype);
    runGrowthTick(map, archetype, state);
    runGrowthTick(map, archetype, state);
    const done = runGrowthTick(map, archetype, state);
    expect(done).toBe(true); // hit max
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/pipeline/growthTick.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement growthTick.js**

```js
// src/city/pipeline/growthTick.js
/**
 * Growth tick orchestration.
 * Each tick expands development radii and runs growth agents.
 */

import { Grid2D } from '../../core/Grid2D.js';
import { RESERVATION, AGENT_TYPE_TO_RESERVATION, scoreCell, findSeeds, spreadFromSeed } from './growthAgents.js';

/**
 * Initialize growth state for a map.
 * @param {object} map - FeatureMap
 * @param {object} archetype - archetype with growth config
 * @returns {object} growth state
 */
export function initGrowthState(map, archetype) {
  const nucleusRadii = new Map();
  for (let i = 0; i < map.nuclei.length; i++) {
    nucleusRadii.set(i, 0);
  }

  const claimedCounts = new Map();
  const activeSeeds = new Map();
  for (const agentType of archetype.growth.agentPriority) {
    claimedCounts.set(agentType, 0);
    activeSeeds.set(agentType, []);
  }

  // Initialize reservation grid if not present
  if (!map.hasLayer('reservationGrid')) {
    map.setLayer('reservationGrid', new Grid2D(map.width, map.height, {
      type: 'uint8', cellSize: map.cellSize,
      originX: map.originX, originZ: map.originZ,
    }));
  }

  // Count total zone cells for budget calculation
  let totalZoneCells = 0;
  if (map.developmentZones) {
    for (const zone of map.developmentZones) {
      totalZoneCells += zone.cells.length;
    }
  }

  return {
    tick: 0,
    nucleusRadii,
    activeSeeds,
    claimedCounts,
    totalZoneCells,
  };
}

/**
 * Run one growth tick.
 * @param {object} map - FeatureMap
 * @param {object} archetype - archetype with growth config
 * @param {object} state - growth state (mutated)
 * @returns {boolean} true if growth is complete (terminated)
 */
export function runGrowthTick(map, archetype, state) {
  const growth = archetype.growth;
  const maxTicks = growth.maxGrowthTicks || 8;

  // Check termination
  if (state.tick >= maxTicks) return true;

  state.tick++;
  const radiusStepCells = Math.round(growth.radiusStep / map.cellSize);
  const w = map.width;
  const h = map.height;

  const resGrid = map.getLayer('reservationGrid');
  const zoneGrid = map.getLayer('zoneGrid');

  // Load spatial layers
  const layers = {};
  for (const name of ['centrality', 'waterfrontness', 'edgeness', 'roadFrontage', 'downwindness', 'roadGrid', 'landValue']) {
    if (map.hasLayer(name)) layers[name] = map.getLayer(name);
  }

  // Step 1: Expand radii
  let allOutOfBounds = true;
  for (const [idx, radius] of state.nucleusRadii) {
    const newRadius = radius + radiusStepCells;
    state.nucleusRadii.set(idx, newRadius);
    // Check if any part of the radius is still in bounds
    const n = map.nuclei[idx];
    if (n.gx - newRadius < w && n.gx + newRadius >= 0 &&
        n.gz - newRadius < h && n.gz + newRadius >= 0) {
      allOutOfBounds = false;
    }
  }
  if (allOutOfBounds) return true;

  // Step 2: Agriculture retreat — mark agriculture cells within new radii as eligible
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (resGrid.get(gx, gz) === RESERVATION.AGRICULTURE) {
        // Check if within any nucleus radius
        for (const [idx, radius] of state.nucleusRadii) {
          const n = map.nuclei[idx];
          const dx = gx - n.gx, dz = gz - n.gz;
          if (dx * dx + dz * dz <= radius * radius) {
            resGrid.set(gx, gz, RESERVATION.NONE);
            break;
          }
        }
      }
    }
  }

  // Collect eligible cells: in a zone, within any nucleus radius, unreserved
  const eligible = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (zoneGrid.get(gx, gz) === 0) continue;
      if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
      // Check within any nucleus radius
      for (const [idx, radius] of state.nucleusRadii) {
        const n = map.nuclei[idx];
        const dx = gx - n.gx, dz = gz - n.gz;
        if (dx * dx + dz * dz <= radius * radius) {
          eligible.push({ gx, gz });
          break;
        }
      }
    }
  }

  if (eligible.length === 0) return true; // all claimed

  // Step 3: Run agents in priority order
  for (const agentType of growth.agentPriority) {
    if (agentType === 'agriculture') continue; // handled separately in step 4

    const agentConfig = growth.agents[agentType];
    if (!agentConfig) continue;

    const resType = AGENT_TYPE_TO_RESERVATION[agentType];
    if (resType === undefined) continue;

    // Check cumulative cap
    const cap = Math.round(agentConfig.share * state.totalZoneCells);
    const claimed = state.claimedCounts.get(agentType) || 0;
    if (claimed >= cap) continue;
    const remainingBudget = cap - claimed;

    // Re-filter eligible (cells may have been claimed by earlier agents this tick)
    const agentEligible = eligible.filter(c => resGrid.get(c.gx, c.gz) === RESERVATION.NONE);
    if (agentEligible.length === 0) continue;

    // Find new seeds
    const seeds = findSeeds(
      agentConfig.seedStrategy, agentEligible, agentConfig.seedsPerTick,
      agentConfig.footprint, agentConfig.affinity, layers, w, h, resGrid
    );

    // Grow existing seeds + new seeds
    const allSeeds = [...(state.activeSeeds.get(agentType) || []), ...seeds];
    let totalClaimed = 0;
    const survivingSeeds = [];

    for (const seed of allSeeds) {
      if (totalClaimed >= remainingBudget) break;
      // Check seed is still valid (not claimed by another agent)
      if (resGrid.get(seed.gx, seed.gz) !== RESERVATION.NONE &&
          resGrid.get(seed.gx, seed.gz) !== resType) continue;

      const budget = Math.min(agentConfig.footprint[1], remainingBudget - totalClaimed);
      const newCells = spreadFromSeed(
        seed, budget, resGrid, zoneGrid, resType,
        agentConfig.spreadBehaviour, agentConfig.affinity, layers, w, h
      );
      totalClaimed += newCells.length;

      if (newCells.length > 0) {
        survivingSeeds.push(seed); // keep for next tick
      }
    }

    state.activeSeeds.set(agentType, survivingSeeds);
    state.claimedCounts.set(agentType, claimed + totalClaimed);
  }

  // Step 4: Agriculture fills — unclaimed cells beyond all radii
  const agriConfig = growth.agents.agriculture;
  if (agriConfig) {
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (zoneGrid.get(gx, gz) === 0) continue;
        if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
        // Check if OUTSIDE all radii
        let insideAny = false;
        for (const [idx, radius] of state.nucleusRadii) {
          const n = map.nuclei[idx];
          const dx = gx - n.gx, dz = gz - n.gz;
          if (dx * dx + dz * dz <= radius * radius) {
            insideAny = true;
            break;
          }
        }
        if (!insideAny) {
          resGrid.set(gx, gz, RESERVATION.AGRICULTURE);
        }
      }
    }
  }

  // Persist state on map for clone support
  map.growthState = state;

  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/city/pipeline/growthTick.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/growthTick.js test/city/pipeline/growthTick.test.js
git commit -m "feat: add growth tick runner with radius expansion and agent orchestration"
```

---

## Chunk 3: Integration

### Task 5: Add growth config to marketTown archetype

**Files:**
- Modify: `src/city/archetypes.js`

- [ ] **Step 1: Add growth config to marketTown**

Add a `growth` property to the `marketTown` entry in `ARCHETYPES` (after the existing `growthMode` block, around line 28). Keep existing fields intact for backward compatibility with other code paths.

```js
    growth: {
      radiusStep: 200,
      maxGrowthTicks: 8,
      agentPriority: ['civic', 'commercial', 'industrial', 'openSpace',
                      'residentialQuality', 'residentialFine', 'residentialEstate',
                      'agriculture'],
      agents: {
        commercial: {
          share: 0.12, seedStrategy: 'roadFrontage', spreadBehaviour: 'linear',
          footprint: [4, 20], affinity: { centrality: 0.6, roadFrontage: 0.8 }, seedsPerTick: 3,
        },
        industrial: {
          share: 0.08, seedStrategy: 'edge', spreadBehaviour: 'blob',
          footprint: [30, 100], affinity: { downwindness: 0.6, edgeness: 0.5 }, seedsPerTick: 1,
        },
        civic: {
          share: 0.05, seedStrategy: 'scattered', spreadBehaviour: 'dot',
          footprint: [3, 10], affinity: { centrality: 0.7, roadFrontage: 0.3 }, seedsPerTick: 2,
        },
        openSpace: {
          share: 0.08, seedStrategy: 'terrain', spreadBehaviour: 'blob',
          footprint: [10, 50], affinity: { waterfrontness: 0.3, edgeness: 0.4 }, seedsPerTick: 1,
        },
        agriculture: {
          share: 0.15, seedStrategy: 'frontier', spreadBehaviour: 'belt',
          footprint: [50, 200], affinity: { edgeness: 1.0 }, seedsPerTick: 0,
        },
        residentialFine: {
          share: 0.30, seedStrategy: 'fill', spreadBehaviour: 'organic',
          footprint: [2, 15], affinity: { centrality: 0.5, roadFrontage: 0.3 }, seedsPerTick: 5,
        },
        residentialEstate: {
          share: 0.10, seedStrategy: 'edge', spreadBehaviour: 'blob',
          footprint: [20, 80], affinity: { edgeness: 0.7 }, seedsPerTick: 1,
        },
        residentialQuality: {
          share: 0.12, seedStrategy: 'desirable', spreadBehaviour: 'cluster',
          footprint: [8, 40], affinity: { waterfrontness: 0.4, centrality: -0.2, edgeness: 0.3 }, seedsPerTick: 2,
        },
      },
    },
```

- [ ] **Step 2: Commit**

```bash
git add src/city/archetypes.js
git commit -m "feat: add growth agent config to marketTown archetype"
```

### Task 6: Wire growth ticks into LandFirstDevelopment

**Files:**
- Modify: `src/city/strategies/landFirstDevelopment.js`

- [ ] **Step 1: Update the strategy to use growth ticks**

Replace the entire file with:

```js
/**
 * Land-First Development strategy.
 * Thin sequencer — each tick calls a pipeline function.
 *
 * Tick 1: Skeleton roads
 * Tick 2: Recompute land value with nucleus-aware formula
 * Tick 3: Extract development zones
 * Tick 4: Compute spatial layers (centrality, waterfrontness, etc.)
 * Tick 5..N: Growth agent ticks (archetype-driven incremental zoning)
 * N+1: Ribbon layout — place parallel streets within zones
 * N+2: Connect zone spines to skeleton network
 */

import { buildSkeletonRoads } from '../pipeline/buildSkeletonRoads.js';
import { computeLandValue } from '../pipeline/computeLandValue.js';
import { extractZones } from '../pipeline/extractZones.js';
import { computeSpatialLayers } from '../pipeline/computeSpatialLayers.js';
import { reserveLandUse } from '../pipeline/reserveLandUse.js';
import { initGrowthState, runGrowthTick } from '../pipeline/growthTick.js';
import { layoutRibbons } from '../pipeline/layoutRibbons.js';
import { connectToNetwork } from '../pipeline/connectToNetwork.js';

export class LandFirstDevelopment {
  constructor(map, options = {}) {
    this.map = map;
    this._tick = 0;
    this.archetype = options.archetype || null;
    this._growthState = null;
    this._growthDone = false;
    this._phase = 'pipeline'; // 'pipeline' | 'growth' | 'finish'
  }

  tick() {
    this._tick++;

    if (this._phase === 'pipeline') {
      switch (this._tick) {
        case 1: this.map = buildSkeletonRoads(this.map); return true;
        case 2: this.map = computeLandValue(this.map); return true;
        case 3: this.map = extractZones(this.map); return true;
        case 4: this.map = computeSpatialLayers(this.map); return true;
        case 5:
          // Start growth phase if archetype has growth config, else fall back to old system
          if (this.archetype && this.archetype.growth) {
            this._phase = 'growth';
            this._growthState = initGrowthState(this.map, this.archetype);
            this._growthDone = runGrowthTick(this.map, this.archetype, this._growthState);
            return true;
          } else {
            this.map = reserveLandUse(this.map, this.archetype);
            this._phase = 'finish';
            this._finishTick = 0;
            return true;
          }
        default:
          return false;
      }
    }

    if (this._phase === 'growth') {
      if (this._growthDone) {
        this._phase = 'finish';
        this._finishTick = 0;
        return this.tick(); // immediately run first finish tick
      }
      this._growthDone = runGrowthTick(this.map, this.archetype, this._growthState);
      return true;
    }

    if (this._phase === 'finish') {
      this._finishTick = (this._finishTick || 0) + 1;
      switch (this._finishTick) {
        case 1: this.map = layoutRibbons(this.map); return true;
        case 2: this.map = connectToNetwork(this.map); return true;
        default: return false;
      }
    }

    return false;
  }
}
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run test/city/pipeline/growthAgents.test.js test/city/pipeline/growthTick.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/city/strategies/landFirstDevelopment.js
git commit -m "feat: wire growth ticks into LandFirstDevelopment with old-system fallback"
```

### Task 7: Update debug layer colours

**Files:**
- Modify: `src/rendering/debugLayers.js`

- [ ] **Step 1: Expand the renderReservations colour map**

In `renderReservations` (around line 722), replace the `colors` object:

```js
  const colors = {
    1: 'rgba(255, 165, 0, 0.6)',   // commercial — orange
    2: 'rgba(128, 128, 128, 0.6)', // industrial — gray
    3: 'rgba(0, 100, 255, 0.6)',   // civic — blue
    4: 'rgba(0, 200, 0, 0.6)',     // open space — green
    5: 'rgba(180, 140, 60, 0.6)',  // agriculture — brown
    6: 'rgba(200, 180, 140, 0.6)', // residential fine — tan
    7: 'rgba(160, 120, 100, 0.6)', // residential estate — dark tan
    8: 'rgba(220, 200, 160, 0.6)', // residential quality — cream
  };
```

- [ ] **Step 2: Commit**

```bash
git add src/rendering/debugLayers.js
git commit -m "feat: add reservation colours for agriculture and residential sub-types"
```

### Task 8: Clone growth state in FeatureMap

**Files:**
- Modify: `src/core/FeatureMap.js`

- [ ] **Step 1: Add growthState cloning**

In the `clone()` method, after the `reservationZones` block (around line 917), add:

```js
    // Growth state
    if (this.growthState) {
      copy.growthState = {
        tick: this.growthState.tick,
        totalZoneCells: this.growthState.totalZoneCells,
        nucleusRadii: new Map(this.growthState.nucleusRadii),
        claimedCounts: new Map(this.growthState.claimedCounts),
        activeSeeds: new Map(
          [...this.growthState.activeSeeds].map(([k, seeds]) =>
            [k, seeds.map(s => ({ ...s }))]
          )
        ),
      };
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/core/FeatureMap.js
git commit -m "feat: clone growthState in FeatureMap.clone()"
```

### Task 9: Manual verification

- [ ] **Step 1: Run all fast tests**

Run: `npx vitest run --exclude 'test/rendering/prepareCityScene.test.js' --exclude 'test/city/strategies/landFirstDevelopment.test.js'`
Expected: All pass

- [ ] **Step 2: Visual verification**

Run: `npx vite` and open the compare-archetypes screen. Select only "Organic Market Town". Advance through ticks. On the Reservations lens, you should see:
- Tick 5: Small civic dots near centre, commercial seeds along roads, agriculture belt at fringe
- Tick 6-7: Commercial strips growing along roads, industrial blob at edge, residential filling in
- Tick 8+: More residential, estates at edges, quality clusters at desirable locations
- Multiple distinct reservation colours visible (not just the old 4 colours)

Archetypes without a `growth` config (portCity, gridTown, etc.) should still use the old `reserveLandUse` system.

- [ ] **Step 3: Commit any fixups**

```bash
git add -u
git commit -m "fix: adjustments from manual verification"
```
