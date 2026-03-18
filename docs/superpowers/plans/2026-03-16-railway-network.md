# Railway Network Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a regional railway network connecting settlements to off-map cities, with historical phasing, terrain-aware routing, and a 2D schematic visualization screen.

**Architecture:** Off-map cities are placed at region edges. Railway lines are built in 4 phases (main line, secondary trunks, branches, cross-country) using A* with a railway-specific cost function that heavily penalises gradient. A new `RailwayScreen` renders the network as a 2D schematic with curved lines. Railway data is stored on the LayerStack alongside roads/rivers.

**Tech Stack:** Vanilla JS (ES modules), vitest for testing, Canvas 2D for rendering, existing A*/pathfinding infrastructure.

---

## File Structure

| File | Responsibility |
|------|---------------|
| **Create:** `src/regional/generateOffMapCities.js` | Place 3-5 off-map cities at region edges with importance/role |
| **Create:** `test/regional/generateOffMapCities.test.js` | Tests for off-map city placement |
| **Create:** `src/core/railwayCost.js` | Railway-specific A* cost function (gradient penalty, curvature, valley bonus) |
| **Create:** `test/core/railwayCost.test.js` | Tests for cost function behaviour |
| **Create:** `src/regional/generateRailways.js` | Phased railway network construction (connections + pathfinding) |
| **Create:** `test/regional/generateRailways.test.js` | Tests for network generation |
| **Create:** `src/ui/RailwayScreen.js` | 2D schematic screen with back button and canvas |
| **Create:** `src/rendering/railwaySchematic.js` | 2D canvas rendering functions for the schematic |
| **Modify:** `src/regional/pipeline.js` | Add off-map cities + railway generation after road/settlement loop |
| **Modify:** `src/main.js` | Register `railway` mode and `RailwayScreen` |
| **Modify:** `src/ui/RegionScreen.js` | Add "Railways" button to right panel |

---

## Chunk 1: Off-Map Cities

### Task 1: Off-Map City Generation

**Files:**
- Create: `src/regional/generateOffMapCities.js`
- Create: `test/regional/generateOffMapCities.test.js`

Off-map cities are placed at region edges. One is always the capital (highest importance). Others represent nearby cities the region connects to. Each has an edge position, importance tier, and role.

- [ ] **Step 1: Write the failing test — generates correct number of cities**

```javascript
// test/regional/generateOffMapCities.test.js
import { describe, it, expect } from 'vitest';
import { generateOffMapCities } from '../../src/regional/generateOffMapCities.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('generateOffMapCities', () => {
  it('generates 3-5 off-map cities', () => {
    const rng = new SeededRandom(42);
    const cities = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, rng);
    expect(cities.length).toBeGreaterThanOrEqual(3);
    expect(cities.length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/generateOffMapCities.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/regional/generateOffMapCities.js
/**
 * Generate off-map cities at region edges.
 * These represent cities beyond the region that railway lines connect to.
 *
 * @param {object} params - { width, height, cellSize }
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<{ gx: number, gz: number, edge: string, importance: number, role: string, name: string }>}
 */
export function generateOffMapCities(params, rng) {
  const { width, height } = params;
  const count = 3 + Math.floor(rng.next() * 3); // 3-5 cities

  // Available edges: 'north', 'south', 'east', 'west'
  // Spread cities across different edges where possible
  const edges = ['north', 'south', 'east', 'west'];
  const roles = ['capital', 'industrial', 'port', 'market', 'university'];

  const cities = [];

  for (let i = 0; i < count; i++) {
    const edge = edges[i % edges.length];
    const pos = 0.2 + rng.next() * 0.6; // 20-80% along the edge

    let gx, gz;
    if (edge === 'north') { gx = Math.round(pos * width); gz = 0; }
    else if (edge === 'south') { gx = Math.round(pos * width); gz = height - 1; }
    else if (edge === 'west') { gx = 0; gz = Math.round(pos * height); }
    else { gx = width - 1; gz = Math.round(pos * height); }

    const importance = i === 0 ? 1 : (i < 2 ? 2 : 3); // first is most important
    const role = i === 0 ? 'capital' : roles[1 + Math.floor(rng.next() * (roles.length - 1))];

    cities.push({ gx, gz, edge, importance, role, name: `City_${i}` });
  }

  return cities;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regional/generateOffMapCities.test.js`
Expected: PASS

- [ ] **Step 5: Write remaining tests and refine**

Add tests for:
- Exactly one capital exists
- Cities are placed on edges (gx=0 or width-1 or gz=0 or height-1)
- Cities are spread across multiple edges
- Deterministic for same seed

```javascript
  it('has exactly one capital', () => {
    const rng = new SeededRandom(42);
    const cities = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, rng);
    const capitals = cities.filter(c => c.role === 'capital');
    expect(capitals.length).toBe(1);
    expect(capitals[0].importance).toBe(1);
  });

  it('places cities on region edges', () => {
    const rng = new SeededRandom(42);
    const cities = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, rng);
    for (const c of cities) {
      const onEdge = c.gx === 0 || c.gx === 127 || c.gz === 0 || c.gz === 127;
      expect(onEdge).toBe(true);
    }
  });

  it('is deterministic', () => {
    const a = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, new SeededRandom(99));
    const b = generateOffMapCities({ width: 128, height: 128, cellSize: 50 }, new SeededRandom(99));
    expect(a).toEqual(b);
  });
```

- [ ] **Step 6: Run all tests to verify they pass**

Run: `npx vitest run test/regional/generateOffMapCities.test.js`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/regional/generateOffMapCities.js test/regional/generateOffMapCities.test.js
git commit -m "feat: add off-map city generation for railway network"
```

---

## Chunk 2: Railway Cost Function

### Task 2: Railway-Specific A* Cost Function

**Files:**
- Create: `src/core/railwayCost.js`
- Create: `test/core/railwayCost.test.js`

Railways need much gentler gradients than roads. The cost function wraps the existing `terrainCostFunction` pattern from `src/core/pathfinding.js` but with railway-specific penalties.

- [ ] **Step 1: Write the failing test — flat terrain has low cost**

```javascript
// test/core/railwayCost.test.js
import { describe, it, expect } from 'vitest';
import { railwayCostFunction } from '../../src/core/railwayCost.js';
import { Grid2D } from '../../src/core/Grid2D.js';

describe('railwayCostFunction', () => {
  function flatGrid(w, h, elevation, cellSize = 50) {
    const grid = new Grid2D(w, h, { cellSize });
    grid.forEach((gx, gz) => grid.set(gx, gz, elevation));
    return grid;
  }

  it('returns low cost on flat terrain', () => {
    const elev = flatGrid(20, 20, 50);
    const cost = railwayCostFunction(elev, {});
    // Adjacent cell, flat — should be close to base distance (1.0 for cardinal)
    const c = cost(10, 10, 11, 10);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/railwayCost.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the cost function**

```javascript
// src/core/railwayCost.js
/**
 * Railway-specific A* cost function.
 * Railways need very gentle gradients (real max ~2-3%).
 * Much higher slope penalty than roads, plus curvature penalty.
 *
 * @param {import('./Grid2D.js').Grid2D} elevation
 * @param {object} options
 * @returns {Function} (fromGx, fromGz, toGx, toGz) => cost
 */
export function railwayCostFunction(elevation, options = {}) {
  const {
    slopePenalty = 150,       // 10x road penalty — railways hate slopes
    waterGrid = null,
    waterPenalty = 200,       // Bridges/viaducts are expensive but possible
    edgeMargin = 2,
    edgePenalty = 0,          // Railways WANT to reach edges (off-map cities)
    seaLevel = null,
    maxGradient = 0.03,       // 3% max — beyond this cost skyrockets
    valleyGrid = null,        // Optional precomputed valley score grid
    valleyBonus = 0.3,        // Discount for cells in valleys
  } = options;

  return function cost(fromGx, fromGz, toGx, toGz) {
    const dx = toGx - fromGx;
    const dz = toGz - fromGz;
    const baseDist = Math.sqrt(dx * dx + dz * dz);

    const fromH = elevation.get(fromGx, fromGz);
    const toH = elevation.get(toGx, toGz);
    const gradient = Math.abs(toH - fromH) / (baseDist * elevation.cellSize);

    // Base cost: distance + slope penalty
    let c = baseDist;

    // Gradient penalty — exponential above maxGradient
    if (gradient > maxGradient) {
      const excess = gradient - maxGradient;
      c += baseDist * slopePenalty * (1 + excess * 20);
    } else {
      c += baseDist * (gradient / maxGradient) * slopePenalty * 0.1;
    }

    // Block below-sea-level cells
    if (seaLevel !== null && toH < seaLevel) return Infinity;

    // Water crossing penalty (viaduct/bridge cost)
    if (waterGrid && waterGrid.get(toGx, toGz) > 0) {
      c += waterPenalty;
    }

    // Edge penalty (usually 0 for railways)
    if (
      edgePenalty > 0 && (
        toGx < edgeMargin || toGx >= elevation.width - edgeMargin ||
        toGz < edgeMargin || toGz >= elevation.height - edgeMargin
      )
    ) {
      c += edgePenalty;
    }

    // Valley bonus — cheaper to route through valleys
    if (valleyGrid) {
      const vScore = valleyGrid.get(toGx, toGz);
      if (vScore > 0) c *= (1 - valleyBonus * vScore);
    }

    return c;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/railwayCost.test.js`
Expected: PASS

- [ ] **Step 5: Write remaining tests**

```javascript
  it('penalises steep slopes heavily', () => {
    const elev = flatGrid(20, 20, 50);
    // Create a steep slope: 10m rise over 1 cell (50m at cellSize=50 => 20% grade)
    elev.set(11, 10, 60);
    const cost = railwayCostFunction(elev, { slopePenalty: 150 });
    const flat = cost(9, 10, 10, 10);
    const steep = cost(10, 10, 11, 10);
    expect(steep).toBeGreaterThan(flat * 5);
  });

  it('returns Infinity for below-sea-level cells', () => {
    const elev = flatGrid(20, 20, 50);
    elev.set(11, 10, -5);
    const cost = railwayCostFunction(elev, { seaLevel: 0 });
    expect(cost(10, 10, 11, 10)).toBe(Infinity);
  });

  it('adds water crossing penalty', () => {
    const elev = flatGrid(20, 20, 50);
    const water = new Grid2D(20, 20, { type: 'uint8' });
    water.set(11, 10, 1);
    const cost = railwayCostFunction(elev, { waterGrid: water, waterPenalty: 200 });
    const dry = cost(9, 10, 10, 10);
    const wet = cost(10, 10, 11, 10);
    expect(wet).toBeGreaterThan(dry + 100);
  });

  it('gives valley bonus discount', () => {
    const elev = flatGrid(20, 20, 50);
    const valley = new Grid2D(20, 20);
    valley.set(11, 10, 1.0); // strong valley signal
    const costNoValley = railwayCostFunction(elev, {});
    const costWithValley = railwayCostFunction(elev, { valleyGrid: valley, valleyBonus: 0.3 });
    const cBase = costNoValley(10, 10, 11, 10);
    const cValley = costWithValley(10, 10, 11, 10);
    expect(cValley).toBeLessThan(cBase);
  });
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run test/core/railwayCost.test.js`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/railwayCost.js test/core/railwayCost.test.js
git commit -m "feat: add railway-specific A* cost function with gradient/valley penalties"
```

---

## Chunk 3: Railway Network Generation

### Task 3: Railway Network Generation

**Files:**
- Create: `src/regional/generateRailways.js`
- Create: `test/regional/generateRailways.test.js`

This is the core generation step. It takes settlements, off-map cities, and terrain, then builds connections in 4 phases and pathfinds each using `buildRoadNetwork` with the railway cost function.

Reference pattern: `src/regional/generateRoads.js` — same structure (build connections list, call `buildRoadNetwork`, return results).

- [ ] **Step 1: Write the failing test — generates railways from settlements + off-map cities**

```javascript
// test/regional/generateRailways.test.js
import { describe, it, expect } from 'vitest';
import { generateRailways } from '../../src/regional/generateRailways.js';
import { Grid2D } from '../../src/core/Grid2D.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('generateRailways', () => {
  const W = 64, H = 64, CS = 50;

  function makeElevation() {
    const elev = new Grid2D(W, H, { cellSize: CS });
    elev.forEach((gx, gz) => elev.set(gx, gz, 50)); // flat
    return elev;
  }

  function makeWaterMask() {
    return new Grid2D(W, H, { type: 'uint8' });
  }

  const settlements = [
    { gx: 32, gz: 32, tier: 1 }, // main city
    { gx: 16, gz: 16, tier: 2 },
    { gx: 48, gz: 48, tier: 3 },
  ];

  const offMapCities = [
    { gx: 32, gz: 0, edge: 'north', importance: 1, role: 'capital' },
    { gx: 63, gz: 32, edge: 'east', importance: 2, role: 'industrial' },
  ];

  it('generates railway lines', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      settlements, offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    expect(result.railways.length).toBeGreaterThan(0);
    expect(result.railGrid).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regional/generateRailways.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// src/regional/generateRailways.js
/**
 * Generate regional railway network.
 * Routes railways between settlements and off-map cities using
 * terrain-weighted A* with railway-specific cost function.
 *
 * Built in 4 historical phases:
 *   Phase 1: Main line (tier-1 settlement → capital off-map city)
 *   Phase 2: Secondary trunks (tier-1 → other off-map cities, tier-2 → trunk)
 *   Phase 3: Branch lines (tier-3 → nearest existing line junction)
 *   Phase 4: Cross-country (off-map → off-map through region)
 */

import { railwayCostFunction } from '../core/railwayCost.js';
import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';
import { buildRoadNetwork } from '../core/buildRoadNetwork.js';

/**
 * @param {object} params - { width, height, cellSize }
 * @param {Array} settlements - [{ gx, gz, tier }]
 * @param {Array} offMapCities - [{ gx, gz, importance, role }]
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {import('../core/Grid2D.js').Grid2D|null} slope
 * @param {import('../core/Grid2D.js').Grid2D} waterMask
 * @returns {{ railways: Array, railGrid: Grid2D }}
 *
 * Deferred features (see wiki/pages/railway-network.md):
 * - Per-phase gradient constraints (trunk 1.5%, branch 3%)
 * - Curvature penalty in cost function
 * - Tunnel detection and routing
 * - Terminus fan-shape station geometry
 * - City inheritance of railway alignments
 */
export function generateRailways(params, settlements, offMapCities, elevation, slope, waterMask) {
  const { width, height, cellSize = 50 } = params;

  if (!settlements || settlements.length === 0 || !offMapCities || offMapCities.length === 0) {
    return { railways: [], railGrid: new Grid2D(width, height, { type: 'uint8' }) };
  }

  const railGrid = new Grid2D(width, height, { type: 'uint8' });

  const costFn = railwayCostFunction(elevation, {
    slopePenalty: 150,
    waterGrid: waterMask,
    waterPenalty: 200,
    edgeMargin: 0,   // railways reach edges
    edgePenalty: 0,
  });

  // Rail-aware cost: existing rail cells get discount (shared corridor)
  const railAwareCost = (fromGx, fromGz, toGx, toGz) => {
    const base = costFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(base)) return base;
    if (railGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.2; // heavier discount than roads
    }
    return base;
  };

  // Find the main city (tier 1, or lowest tier)
  const mainCity = settlements.reduce((a, b) => a.tier <= b.tier ? a : b);
  const capital = offMapCities.find(c => c.role === 'capital') || offMapCities[0];

  const connections = [];

  // Phase 1: Main line — main city to capital
  connections.push({
    from: { gx: mainCity.gx, gz: mainCity.gz },
    to: { gx: capital.gx, gz: capital.gz },
    hierarchy: 'trunk',
    phase: 1,
  });

  // Phase 2: Secondary trunks — main city to other off-map cities + tier-2 to trunk
  for (const omc of offMapCities) {
    if (omc === capital) continue;
    connections.push({
      from: { gx: mainCity.gx, gz: mainCity.gz },
      to: { gx: omc.gx, gz: omc.gz },
      hierarchy: 'main',
      phase: 2,
    });
  }

  // Tier-2 settlements connect to nearest off-map city or main city
  const tier2 = settlements.filter(s => s.tier === 2);
  for (const s of tier2) {
    const nearest = _nearestPoint(s, [mainCity, ...offMapCities]);
    if (nearest) {
      connections.push({
        from: { gx: s.gx, gz: s.gz },
        to: { gx: nearest.gx, gz: nearest.gz },
        hierarchy: 'main',
        phase: 2,
      });
    }
  }

  // Phase 3: Branch lines — tier-3 connect to nearest tier-1 or tier-2
  const tier3 = settlements.filter(s => s.tier === 3);
  const branchTargets = settlements.filter(s => s.tier <= 2);
  for (const s of tier3) {
    const nearest = _nearestPoint(s, branchTargets);
    if (nearest) {
      connections.push({
        from: { gx: s.gx, gz: s.gz },
        to: { gx: nearest.gx, gz: nearest.gz },
        hierarchy: 'branch',
        phase: 3,
      });
    }
  }

  // Phase 4: Cross-country — off-map cities connected through tier-2 if shorter
  if (offMapCities.length >= 2) {
    for (let i = 0; i < offMapCities.length; i++) {
      for (let j = i + 1; j < offMapCities.length; j++) {
        // Only add if there's a tier-2 settlement roughly between them
        const midGx = (offMapCities[i].gx + offMapCities[j].gx) / 2;
        const midGz = (offMapCities[i].gz + offMapCities[j].gz) / 2;
        const nearMid = tier2.find(s =>
          distance2D(s.gx, s.gz, midGx, midGz) < width * 0.4
        );
        if (nearMid) {
          connections.push({
            from: { gx: offMapCities[i].gx, gz: offMapCities[i].gz },
            to: { gx: offMapCities[j].gx, gz: offMapCities[j].gz },
            hierarchy: 'main',
            phase: 4,
          });
        }
      }
    }
  }

  // Deduplicate connections (same endpoints)
  const seen = new Set();
  const deduped = connections.filter(conn => {
    const key = [
      `${conn.from.gx},${conn.from.gz}`,
      `${conn.to.gx},${conn.to.gz}`,
    ].sort().join('-');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by phase (build main line first so later lines share corridor)
  deduped.sort((a, b) => a.phase - b.phase);

  // Pathfind all connections via buildRoadNetwork
  const results = buildRoadNetwork({
    width,
    height,
    cellSize,
    costFn: railAwareCost,
    connections: deduped,
    roadGrid: railGrid,
    originX: 0,
    originZ: 0,
  });

  // Stamp rail grid with results
  for (const rail of results) {
    if (!rail.cells) continue;
    for (const cell of rail.cells) {
      railGrid.set(cell.gx, cell.gz, 1);
    }
  }

  // Attach phase/hierarchy metadata
  const railways = results.map((r, i) => ({
    ...r,
    phase: deduped[i]?.phase ?? 1,
    hierarchy: deduped[i]?.hierarchy ?? 'branch',
  }));

  return { railways, railGrid };
}

function _nearestPoint(from, targets) {
  let best = null;
  let bestDist = Infinity;
  for (const t of targets) {
    if (t.gx === from.gx && t.gz === from.gz) continue;
    const d = distance2D(from.gx, from.gz, t.gx, t.gz);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regional/generateRailways.test.js`
Expected: PASS

- [ ] **Step 5: Write remaining tests**

```javascript
  it('main line connects tier-1 to capital', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      settlements, offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    const trunk = result.railways.filter(r => r.hierarchy === 'trunk');
    expect(trunk.length).toBe(1);
  });

  it('stamps railGrid cells', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      settlements, offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    let count = 0;
    result.railGrid.forEach((gx, gz, v) => { if (v > 0) count++; });
    expect(count).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const make = () => generateRailways(
      { width: W, height: H, cellSize: CS },
      settlements, offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    const a = make();
    const b = make();
    expect(a.railways.length).toBe(b.railways.length);
  });

  it('returns empty for no settlements', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      [], offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    expect(result.railways.length).toBe(0);
  });
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run test/regional/generateRailways.test.js`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/regional/generateRailways.js test/regional/generateRailways.test.js
git commit -m "feat: add phased railway network generation with terrain-aware routing"
```

---

## Chunk 4: Pipeline Integration

### Task 4: Wire Into Regional Pipeline

**Files:**
- Modify: `src/regional/pipeline.js`

Add off-map city generation and railway generation after the road/settlement feedback loop (after `growSettlements`, before land cover).

- [ ] **Step 1: Add imports to pipeline.js**

Add at top of file:
```javascript
import { generateOffMapCities } from './generateOffMapCities.js';
import { generateRailways } from './generateRailways.js';
```

- [ ] **Step 2: Add off-map cities + railways after `growSettlements` call**

After line `growSettlements(allSettlements, roadsB.roads);` and before `layers.setData('settlements', allSettlements);`, insert:

```javascript
  // A8a. Off-map cities (railway destinations beyond region)
  const offMapCities = generateOffMapCities({ width, height, cellSize }, rng.fork('offMapCities'));
  layers.setData('offMapCities', offMapCities);

  // A8b. Railway network (phased construction)
  const railResult = generateRailways(
    { width, height, cellSize },
    allSettlements,
    offMapCities,
    terrain.elevation,
    terrain.slope,
    hydrology.waterMask,
  );
  layers.setData('railways', railResult.railways);
  layers.setGrid('railGrid', railResult.railGrid);
```

- [ ] **Step 3: Run the full pipeline test to check nothing broke**

Run: `npx vitest run test/regional/pipeline.test.js`
Expected: All existing tests PASS

- [ ] **Step 4: Add a pipeline test for railways**

Add to `test/regional/pipeline.test.js`:

```javascript
  it('generates railway data', () => {
    const rng = new SeededRandom(42);
    const layers = generateRegion({ width: 32, height: 32, cellSize: 50 }, rng);
    expect(layers.hasData('railways')).toBe(true);
    expect(layers.hasData('offMapCities')).toBe(true);
    expect(layers.hasGrid('railGrid')).toBe(true);
  });
```

- [ ] **Step 5: Run pipeline tests**

Run: `npx vitest run test/regional/pipeline.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/regional/pipeline.js test/regional/pipeline.test.js
git commit -m "feat: integrate railway generation into regional pipeline"
```

---

## Chunk 5: 2D Schematic Rendering

### Task 5: Railway Schematic Renderer

**Files:**
- Create: `src/rendering/railwaySchematic.js`

Pure rendering functions that draw the railway schematic onto a 2D canvas. No DOM or screen logic — just drawing functions that take a canvas context and data.

Reference pattern: `src/rendering/mapRenderer.js` (same structure — exported functions that draw onto a canvas context).

- [ ] **Step 1: Write the schematic renderer**

```javascript
// src/rendering/railwaySchematic.js
/**
 * 2D canvas rendering functions for railway schematic.
 * Draws terrain background, railway lines, settlements, and off-map city labels.
 */

import { chaikinSmooth } from '../core/math.js';

const HIERARCHY_STYLES = {
  trunk:  { color: '#cc2222', width: 4 },
  main:   { color: '#cc6622', width: 3 },
  branch: { color: '#888888', width: 2 },
};

/**
 * Render terrain background (muted, so lines stand out).
 * Uses a temporary canvas because putImageData ignores canvas transforms.
 */
export function renderSchematicTerrain(ctx, elevation, seaLevel) {
  const { width, height } = elevation;
  const { min, max } = elevation.bounds();
  const landRange = max - seaLevel || 1;

  // Render to temporary canvas at grid resolution
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tmpCtx = tmp.getContext('2d');
  const imageData = tmpCtx.createImageData(width, height);
  const data = imageData.data;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const idx = (gz * width + gx) * 4;
      const h = elevation.get(gx, gz);

      if (h < seaLevel) {
        data[idx] = 200; data[idx + 1] = 210; data[idx + 2] = 220;
      } else {
        const t = Math.min(1, (h - seaLevel) / landRange);
        const v = 235 + t * 15; // very light: 235-250
        data[idx] = v - 10; data[idx + 1] = v; data[idx + 2] = v - 15;
      }
      data[idx + 3] = 255;
    }
  }
  tmpCtx.putImageData(imageData, 0, 0);

  // Draw scaled onto the main canvas (respects current transform)
  ctx.drawImage(tmp, 0, 0, width, height);
}

/**
 * Render railway lines with Chaikin smoothing.
 */
export function renderSchematicLines(ctx, railways, scale) {
  // Draw in order: branch first (behind), then main, then trunk (on top)
  const ordered = [...railways].sort((a, b) => {
    const order = { branch: 0, main: 1, trunk: 2 };
    return (order[a.hierarchy] ?? 0) - (order[b.hierarchy] ?? 0);
  });

  for (const rail of ordered) {
    // Use grid-coordinate path, not world-coordinate polyline
    const pathData = rail.path;
    if (!pathData || pathData.length < 2) continue;

    const style = HIERARCHY_STYLES[rail.hierarchy] || HIERARCHY_STYLES.branch;

    // Smooth the path (path is in grid coords {gx, gz})
    let points = pathData.map(p => ({
      x: p.gx * scale,
      z: p.gz * scale,
    }));
    points = chaikinSmooth(points);
    points = chaikinSmooth(points);

    // Draw line
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].z);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].z);
    }
    ctx.stroke();
  }
}

/**
 * Render settlement dots at station locations.
 */
export function renderSchematicStations(ctx, settlements, railGrid, scale) {
  // Only draw settlements that are near a rail line
  for (const s of settlements) {
    if (s.tier > 3) continue; // no stations for hamlets/farms
    const onRail = railGrid && railGrid.get(s.gx, s.gz) > 0;

    // Check nearby cells too (station might be adjacent)
    let nearRail = onRail;
    if (!nearRail && railGrid) {
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
        const nx = s.gx + dx, nz = s.gz + dz;
        if (nx >= 0 && nx < railGrid.width && nz >= 0 && nz < railGrid.height) {
          if (railGrid.get(nx, nz) > 0) { nearRail = true; break; }
        }
      }
    }

    if (!nearRail) continue;

    const x = s.gx * scale;
    const z = s.gz * scale;
    const r = s.tier === 1 ? 5 : s.tier === 2 ? 4 : 3;

    // White circle with dark border
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, z, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Render off-map city labels at region edges.
 */
export function renderSchematicOffMapCities(ctx, offMapCities, scale, canvasWidth, canvasHeight) {
  ctx.font = '11px monospace';
  ctx.textBaseline = 'middle';

  for (const c of offMapCities) {
    const x = c.gx * scale;
    const z = c.gz * scale;

    // Arrow marker at edge
    ctx.fillStyle = c.role === 'capital' ? '#cc2222' : '#666666';
    ctx.beginPath();
    ctx.arc(x, z, 4, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.fillStyle = '#444444';
    const label = c.role === 'capital' ? `${c.name} (Capital)` : c.name;

    if (c.edge === 'north') {
      ctx.textAlign = 'center';
      ctx.fillText(label, x, z + 10);
    } else if (c.edge === 'south') {
      ctx.textAlign = 'center';
      ctx.fillText(label, x, z - 10);
    } else if (c.edge === 'west') {
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 8, z);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(label, x - 8, z);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/rendering/railwaySchematic.js
git commit -m "feat: add 2D railway schematic rendering functions"
```

---

### Task 6: Railway Screen

**Files:**
- Create: `src/ui/RailwayScreen.js`

A screen that shows the 2D railway schematic. Follows the pattern from `CompareArchetypesScreen` — constructor takes `(container, layers, seed, onBack)`, builds a full-viewport canvas, renders the schematic.

Note: This screen does NOT require a selected settlement (unlike city screens). It shows the whole region.

- [ ] **Step 1: Write the screen**

```javascript
// src/ui/RailwayScreen.js
/**
 * 2D railway schematic screen.
 * Shows the regional railway network as curved lines on a muted terrain background.
 */

import {
  renderSchematicTerrain,
  renderSchematicLines,
  renderSchematicStations,
  renderSchematicOffMapCities,
} from '../rendering/railwaySchematic.js';

export class RailwayScreen {
  constructor(container, layers, seed, onBack) {
    this.container = container;
    this.layers = layers;
    this.seed = seed;
    this.onBack = onBack;
    this._disposed = false;

    this._buildUI();
    this._render();
  }

  _buildUI() {
    this._root = document.createElement('div');
    this._root.style.cssText = 'position:fixed;inset:0;background:#f0f0f0;display:flex;flex-direction:column;z-index:50';
    this.container.appendChild(this._root);

    // Top bar
    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 12px;background:#333;color:#eee;font-family:monospace;font-size:13px';

    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'padding:6px 12px;background:#555;color:#eee;border:1px solid #777;cursor:pointer;font-family:monospace;border-radius:4px';
    backBtn.addEventListener('click', () => this.onBack());
    topBar.appendChild(backBtn);

    const title = document.createElement('span');
    title.textContent = `Railway Network — Seed ${this.seed}`;
    topBar.appendChild(title);

    this._root.appendChild(topBar);

    // Canvas container (fills remaining space)
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:20px';
    this._root.appendChild(canvasWrap);

    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = 'max-width:100%;max-height:100%;image-rendering:auto;border:1px solid #ccc;box-shadow:0 2px 8px rgba(0,0,0,0.1)';
    canvasWrap.appendChild(this._canvas);
  }

  _render() {
    const elevation = this.layers.getGrid('elevation');
    if (!elevation) return;

    const params = this.layers.getData('params');
    const seaLevel = params?.seaLevel ?? 0;
    const railways = this.layers.getData('railways') || [];
    const settlements = this.layers.getData('settlements') || [];
    const offMapCities = this.layers.getData('offMapCities') || [];
    const railGrid = this.layers.hasGrid('railGrid') ? this.layers.getGrid('railGrid') : null;

    // Canvas size: 1 pixel per grid cell, scaled up for display
    const displayScale = 4;
    const w = elevation.width;
    const h = elevation.height;
    this._canvas.width = w * displayScale;
    this._canvas.height = h * displayScale;

    const ctx = this._canvas.getContext('2d');

    // Scale everything up
    ctx.save();
    ctx.scale(displayScale, displayScale);

    // Background terrain
    renderSchematicTerrain(ctx, elevation, seaLevel);

    // Railway lines (scale=1 since we're in grid coords after ctx.scale)
    renderSchematicLines(ctx, railways, 1);

    // Station dots
    renderSchematicStations(ctx, settlements, railGrid, 1);

    // Off-map city labels
    renderSchematicOffMapCities(ctx, offMapCities, 1, w, h);

    ctx.restore();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/RailwayScreen.js
git commit -m "feat: add RailwayScreen for 2D schematic visualization"
```

---

## Chunk 6: Navigation Wiring

### Task 7: Wire Railway Screen into Navigation

**Files:**
- Modify: `src/main.js`
- Modify: `src/ui/RegionScreen.js`

Add a "Railways" button to the RegionScreen and wire up the `railway` mode in main.js.

- [ ] **Step 1: Add import and state variable to main.js**

At top of `src/main.js`, add:
```javascript
import { RailwayScreen } from './ui/RailwayScreen.js';
```

Add variable alongside existing screen vars:
```javascript
let railwayScreen = null;
```

- [ ] **Step 2: Add dispose for railwayScreen in disposeAll()**

In the `disposeAll()` function, add:
```javascript
if (railwayScreen) { railwayScreen.dispose(); railwayScreen = null; }
```

- [ ] **Step 3: Add railway callback to showRegion()**

In `showRegion()`, add `onRailways` callback alongside the existing callbacks:
```javascript
onRailways(layers, seed) {
  disposeAll();
  history.pushState(null, '', `?seed=${seed}&mode=railway`);
  railwayScreen = new RailwayScreen(container, layers, seed, goBack);
},
```

- [ ] **Step 4: Handle railway mode in popstate handler and deep-link**

In the `popstate` handler, add a case for `mode === 'railway'`:
```javascript
if (mode === 'railway' && seed != null) {
  const { layers } = generateRegionFromSeed(seed);
  railwayScreen = new RailwayScreen(container, layers, seed, goBack);
  return;
}
```

Add the same in the deep-link section at the bottom of the file.

- [ ] **Step 5: Add Railways button to RegionScreen**

In `src/ui/RegionScreen.js`:

Add `onRailways` to the callback destructuring in the constructor:
```javascript
this.onRailways = callbacks.onRailways || null;
```

In `_buildUI()`, after the terraced row button block, add:
```javascript
if (this.onRailways) {
  this._railwaysBtn = this._makeBtn('Railways', () => {
    if (this._layers && this.onRailways) {
      this.onRailways(this._layers, this._seed);
    }
  });
  this._railwaysBtn.style.background = '#345';
  btnRow.appendChild(this._railwaysBtn);
}
```

- [ ] **Step 6: Test manually — generate a region and click the Railways button**

Run: `npx vite` (or your dev server)
Expected: Region screen shows "Railways" button. Clicking it opens 2D schematic. Back button returns to region.

- [ ] **Step 7: Commit**

```bash
git add src/main.js src/ui/RegionScreen.js
git commit -m "feat: wire railway screen into navigation with Railways button"
```

---

## Chunk 7: Polish and Edge Cases

### Task 8: Handle Edge Cases and Run Full Test Suite

**Files:**
- Potentially modify any of the above files

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new)

- [ ] **Step 2: Fix any failures**

Address test failures from integration (e.g. pipeline test regressions, import issues).

- [ ] **Step 3: Test with different seeds manually**

Try 3-4 different seeds in the browser. Check:
- Railways render on the schematic
- Lines connect settlements to edge points
- Trunk lines are visually thicker/redder than branches
- Back button works
- URL deep-linking works (`?seed=42&mode=railway`)

- [ ] **Step 4: Handle edge case — no tier-1 settlement**

In `generateRailways`, if no tier-1 settlement exists, use the lowest-tier settlement as the main city. Already handled by `reduce` but verify with a test:

```javascript
  it('handles settlements with no tier-1', () => {
    const result = generateRailways(
      { width: W, height: H, cellSize: CS },
      [{ gx: 32, gz: 32, tier: 3 }, { gx: 16, gz: 16, tier: 3 }],
      offMapCities,
      makeElevation(), null, makeWaterMask(),
    );
    expect(result.railways.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: polish railway network — edge cases and full test pass"
```
