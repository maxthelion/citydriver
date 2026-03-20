# CityScreen Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all generation logic from `CityScreen` into a standalone `buildCityMap` factory so the screen only handles rendering.

**Architecture:** Move Chaikin road smoothing into the pipeline as a named `smooth-roads` step (runs automatically in all code paths). Create `buildCityMap.js` as an async factory that calls `setupCity` + archetype resolution + pipeline. Slim `CityScreen` to accept a pre-built `FeatureMap`. Update `main.js` callers to use the factory.

**Tech Stack:** Vitest, ES modules, THREE.js (UI layer only).

**Spec:** `specs/v5/city-screen-refactor.md`

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/city/buildCityMap.js` | Async factory: `setupCity` + archetype resolution + pipeline run + return `{ map, archetype }` |
| `test/city/buildCityMap.test.js` | Unit tests for the factory |

### Modified files
| File | Change |
|---|---|
| `src/city/pipeline/cityPipeline.js` | Add `smooth-roads` step after `connect` |
| `src/ui/CityScreen.js` | New constructor `(container, map, seed, onBack)`, remove all generation code |
| `src/main.js` | Call `buildCityMap` before constructing `CityScreen` in 3 locations |

---

## Task 1: Add `smooth-roads` pipeline step

**Files:**
- Modify: `src/city/pipeline/cityPipeline.js:68` (after `connect` step)
- Modify: `test/city/strategies/landFirstDevelopment.test.js`

The `smooth-roads` step applies 2 iterations of Chaikin corner-cutting to every road polyline. This currently lives in `CityScreen` constructor (lines 64–71). Moving it into the pipeline means all consumers (DebugScreen, CompareArchetypesScreen, scripts) get smoothed roads automatically.

- [ ] **Step 1: Write a failing test that smooth-roads runs as a pipeline step**

In `test/city/strategies/landFirstDevelopment.test.js`, add a test inside the existing `'LandFirstDevelopment'` describe block (after the `'completes all ticks without error'` test). The shared map from `beforeAll` already ran the full pipeline — check that road polylines have been smoothed (point count increased by Chaikin doubling).

```js
it('smooths road polylines via smooth-roads step', () => {
  // Chaikin doubles point count per iteration (2 iterations).
  // Any road with ≥3 original points will have more points after smoothing.
  // The shared pipeline ran to completion, so smooth-roads should have run.
  const longerRoads = sharedMap.roads.filter(r => r.polyline.length >= 3);
  expect(longerRoads.length).toBeGreaterThan(0);

  // A road that started with N points and got 2 Chaikin passes has
  // 2*(2*(N-1))+1 = 4N-3 points. So a 3-point road becomes 9, 4→13, etc.
  // We can't know the original count, but we can check that at least some
  // roads have counts only possible after smoothing (≥9).
  const smoothedRoads = sharedMap.roads.filter(r => r.polyline.length >= 9);
  expect(smoothedRoads.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/city/strategies/landFirstDevelopment.test.js`
Expected: FAIL — the shared pipeline doesn't include `smooth-roads` yet, so no roads will have ≥9 points from smoothing.

- [ ] **Step 3: Implement `smooth-roads` in cityPipeline.js**

In `src/city/pipeline/cityPipeline.js`, add the import at the top:

```js
import { chaikinSmooth } from '../../core/math.js';
```

Then after the existing `yield step('connect', ...)` line (line 68), add:

```js
yield step('smooth-roads', () => {
  for (const road of map.roads) {
    if (!road.polyline || road.polyline.length < 3) continue;
    let poly = road.polyline;
    for (let i = 0; i < 2; i++) poly = chaikinSmooth(poly);
    road._replacePolyline(poly);
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/city/strategies/landFirstDevelopment.test.js`
Expected: PASS — the pipeline now includes `smooth-roads`, so roads are smoothed.

- [ ] **Step 5: Commit**

```bash
git add src/city/pipeline/cityPipeline.js test/city/strategies/landFirstDevelopment.test.js
git commit -m "feat: add smooth-roads pipeline step after connect"
```

---

## Task 2: Create `buildCityMap` factory

**Files:**
- Create: `src/city/buildCityMap.js`
- Create: `test/city/buildCityMap.test.js`

This is the new canonical entry point for "give me a city map at this state". It wraps `setupCity` + archetype resolution + `LandFirstDevelopment.runToCompletion()`.

- [ ] **Step 1: Write failing tests for `buildCityMap`**

Create `test/city/buildCityMap.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { buildCityMap } from '../../src/city/buildCityMap.js';
import { generateRegionFromSeed } from '../../src/ui/regionHelper.js';

let sharedLayers, sharedSettlement;

beforeAll(() => {
  const { layers, settlement } = generateRegionFromSeed(42);
  sharedLayers = layers;
  sharedSettlement = settlement;
});

describe('buildCityMap', { timeout: 120000 }, () => {
  it('returns a map with roads when run to completion', async () => {
    const { map, archetype } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
    });

    expect(map).toBeDefined();
    expect(map.roads.length).toBeGreaterThan(0);
    expect(archetype).toBeDefined();
    expect(archetype.name).toBeTruthy();
  });

  it('auto-selects an archetype by default', async () => {
    const { archetype } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
    });

    expect(archetype.id).toBeTruthy();
  });

  it('accepts an explicit archetype key', async () => {
    const { archetype } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
      archetype: 'gridTown',
    });

    expect(archetype.id).toBe('gridTown');
  });

  it('accepts an archetype object directly', async () => {
    const custom = { id: 'custom', name: 'Custom', shares: {} };
    const { archetype } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
      archetype: custom,
    });

    expect(archetype.id).toBe('custom');
  });

  it('stops at a named step when step is provided', async () => {
    const { map } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
      step: 'skeleton',
    });

    expect(map.roads.length).toBeGreaterThan(0);
    // Should NOT have development zones (those come later)
    expect(map.developmentZones?.length || 0).toBe(0);
  });

  it('stashes regional data on the map for minimap rendering', async () => {
    const { map } = await buildCityMap({
      seed: 42,
      layers: sharedLayers,
      settlement: sharedSettlement,
    });

    expect(map.regionalLayers).toBe(sharedLayers);
    expect(map.settlement).toBe(sharedSettlement);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/city/buildCityMap.test.js`
Expected: FAIL — `buildCityMap` doesn't exist yet.

- [ ] **Step 3: Implement `buildCityMap`**

Create `src/city/buildCityMap.js`:

```js
/**
 * buildCityMap — async factory for city maps.
 *
 * Wraps setupCity + archetype resolution + pipeline execution into a single
 * call. Returns a fully-generated, ready-to-render FeatureMap.
 *
 * Spec: specs/v5/city-screen-refactor.md
 */

import { setupCity } from './setup.js';
import { LandFirstDevelopment } from './strategies/landFirstDevelopment.js';
import { ARCHETYPES } from './archetypes.js';
import { scoreSettlement } from './archetypeScoring.js';
import { SeededRandom } from '../core/rng.js';

/**
 * Map user-facing step names to the pipeline step ID to stop after.
 * 'connect' includes smooth-roads per spec (connect = same as null).
 *
 * 'zones' is a special case: the spec says "stop after zone extraction
 * (incl. refine)" but zones-refine is conditionally skipped. The loop
 * handles this by also breaking when it sees 'spatial' (meaning the
 * zone phase is over). This may execute one extra step (spatial) when
 * zones-refine is skipped — acceptable for debug inspection.
 */
const STEP_TARGETS = {
  skeleton:       'skeleton',
  zones:          'zones-refine',
  spatial:        'spatial',
  connect:        'smooth-roads',
  'smooth-roads': 'smooth-roads',
};

/**
 * Build a city map from declarative parameters.
 *
 * @param {object} options
 * @param {number}        options.seed       — region seed (for RNG)
 * @param {object}        options.layers     — regional layer bag from generateRegion
 * @param {object}        options.settlement — settlement record (gx, gz, …)
 * @param {string|object} [options.archetype='auto'] — archetype key, 'auto', or archetype object
 * @param {string|null}   [options.step=null]  — pipeline step to stop after (null = complete)
 * @param {number}        [options.growth=0]   — growth tick count (when step === 'growth')
 * @returns {Promise<{ map: FeatureMap, archetype: object }>}
 */
export async function buildCityMap({
  seed, layers, settlement, archetype = 'auto', step = null, growth = 0,
}) {
  const rng = new SeededRandom(seed || 42);
  const map = setupCity(layers, settlement, rng.fork('city'));

  // Stash regional data on the map so CityScreen can render the minimap
  // without needing separate layers/settlement parameters.
  map.regionalLayers = layers;
  map.settlement = settlement;

  // Resolve archetype
  let resolvedArchetype;
  if (archetype === 'auto' || archetype == null) {
    const scores = scoreSettlement(map);
    resolvedArchetype = scores[0].archetype;
    console.log(`City archetype: ${resolvedArchetype.name} (score ${scores[0].score.toFixed(2)})`);
    for (const s of scores) {
      console.log(`  ${s.archetype.name}: ${s.score.toFixed(2)} — ${s.factors.join(', ')}`);
    }
  } else if (typeof archetype === 'string') {
    resolvedArchetype = ARCHETYPES[archetype];
    if (!resolvedArchetype) {
      throw new Error(`Unknown archetype key: "${archetype}"`);
    }
  } else {
    resolvedArchetype = archetype;
  }

  const strategy = new LandFirstDevelopment(map, { archetype: resolvedArchetype });

  if (step) {
    // Resolve the target pipeline step ID
    let target;
    if (step === 'growth') {
      target = `growth-${growth}:roads`;
    } else {
      target = STEP_TARGETS[step] || step;
    }

    let ran = true;
    while (ran) {
      const result = strategy.tick();
      ran = (result instanceof Promise) ? await result : result;
      const current = strategy.runner.currentStep;
      if (current === target) break;
      // zones-refine is conditional — if skipped, 'spatial' means zone phase is over
      if (step === 'zones' && current === 'spatial') break;
    }
  } else {
    await strategy.runToCompletion();
  }

  return { map, archetype: resolvedArchetype };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/city/buildCityMap.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/buildCityMap.js test/city/buildCityMap.test.js
git commit -m "feat: add buildCityMap async factory"
```

---

## Task 3: Update `CityScreen` constructor

**Files:**
- Modify: `src/ui/CityScreen.js:1-75`

Slim the constructor to `(container, map, seed, onBack)`. Remove all generation imports and the pipeline block.

- [ ] **Step 1: Remove generation imports from CityScreen**

In `src/ui/CityScreen.js`, remove these import lines (lines 8–11, 18):

```js
// DELETE these lines:
import { setupCity } from '../city/setup.js';
import { LandFirstDevelopment } from '../city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../city/archetypes.js';
import { scoreSettlement } from '../city/archetypeScoring.js';
import { chaikinSmooth } from '../core/math.js';
```

- [ ] **Step 2: Replace the constructor**

Replace the existing constructor (lines 38–75) with:

```js
export class CityScreen {
  constructor(container, map, seed, onBack) {
    this.container = container;
    this.onBack = onBack;
    this._seed = seed || 42;
    this._hud = [];
    this._map = map;

    // Regional data is stashed on the map by buildCityMap so the minimap can render.
    this._regionalLayers = map.regionalLayers;
    this._settlement = map.settlement;

    this._ready = Promise.resolve().then(() => this._buildScene());
  }
```

This removes:
- `layers`, `settlement`, `rng` parameters (regional data now comes from `map.regionalLayers` / `map.settlement`, stashed by `buildCityMap`)
- The `setupCity()` call
- The `scoreSettlement()` + archetype selection block
- The `LandFirstDevelopment` creation and `runToCompletion()` call
- The Chaikin smoothing loop (now in the pipeline)

`this._regionalLayers` and `this._settlement` are still set (read from `map`) because `_buildRegionMinimap()` (line 283) uses them to render the overview minimap.

The `this._ready` promise is kept so that any code checking `cityScreen._ready` still works (it just resolves immediately after `_buildScene`).

- [ ] **Step 3: Verify the module loads without syntax errors**

Run: `node -e "import('./src/ui/CityScreen.js').catch(e => { console.error(e.message); process.exit(1); })"`
Expected: May fail on THREE.js/DOM imports in Node, but should not have syntax errors. If it fails on `document`/`window`, that's expected — confirms no import resolution errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/CityScreen.js
git commit -m "refactor: slim CityScreen to accept pre-built map"
```

---

## Task 4: Update `main.js` callers

**Files:**
- Modify: `src/main.js`

There are 3 locations where `CityScreen` is constructed:
1. `enterSubScreen` (line 49–50) — the normal flow from RegionScreen
2. `popstate` handler (line 115–117) — browser back/forward
3. URL deep-link (line 156–158) — initial page load

All three need to call `buildCityMap` first, then pass the result to `CityScreen`.

- [ ] **Step 1: Add `buildCityMap` import**

At the top of `src/main.js`, add:

```js
import { buildCityMap } from './city/buildCityMap.js';
```

Remove the `SeededRandom` import (line 10) since `buildCityMap` handles RNG internally:

```js
// DELETE:
import { SeededRandom } from './core/rng.js';
```

Wait — `SeededRandom` may be used elsewhere in `main.js`. Check: it's used at lines 49, 116, 157 — all for CityScreen construction. After this refactor all three are removed. So deleting the import is safe.

- [ ] **Step 2: Update `enterSubScreen` (line 48–50)**

Replace the `if (mode === 'city')` block:

```js
  if (mode === 'city') {
    buildCityMap({ seed, layers, settlement, archetype, step, growth }).then(({ map }) => {
      cityScreen = new CityScreen(container, map, seed, goBack);
    });
  } else if (mode === 'compare') {
```

- [ ] **Step 3: Update popstate handler (lines 115–117)**

Replace:

```js
      if (mode === 'city') {
        const rng = new SeededRandom(seed);
        cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), seed, goBack);
```

With:

```js
      if (mode === 'city') {
        buildCityMap({ seed, layers, settlement }).then(({ map }) => {
          cityScreen = new CityScreen(container, map, seed, goBack);
        });
```

- [ ] **Step 4: Update URL deep-link (lines 156–158)**

Replace:

```js
    if (urlMode === 'city') {
      const rng = new SeededRandom(urlSeed);
      cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), urlSeed, goBack);
```

With:

```js
    if (urlMode === 'city') {
      buildCityMap({ seed: urlSeed, layers, settlement }).then(({ map }) => {
        cityScreen = new CityScreen(container, map, urlSeed, goBack);
      });
```

- [ ] **Step 5: Manual smoke test**

Open the app in a browser:
1. Navigate to a city from the region screen — should render normally
2. Use browser back/forward — city should reload
3. Deep-link via URL `?seed=42&mode=city&gx=5&gz=5` — should render

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "refactor: wire main.js to use buildCityMap before CityScreen"
```

---

## Task 5: Verify pipeline invariants still pass

**Files:** (no changes — verification only)

The pipeline invariant tests run the full pipeline with hooks. Since `smooth-roads` was added after `connect`, the invariant checks now also run after `smooth-roads`. Verify this doesn't introduce new violations.

- [ ] **Step 1: Run the pipeline invariant tests**

Run: `npx vitest run test/integration/pipelineInvariants.test.js`
Expected: PASS — smooth-roads shouldn't introduce bitmap/polyline/block violations.

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: All existing tests pass.

- [ ] **Step 3: Commit (if any fixups needed)**

Only needed if the invariant tests revealed issues that required code changes.
