# Urban Economics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace distance-based plot sizing with a pressure-driven economic model, and allow development on slopes near valuable land.

**Architecture:** Each zone gets a development pressure score (0–1) combining land value and proximity. Pressure drives building typology (terraced/apartment/semi/detached), plot width, ribbon spacing, and apartment aggregation. Separately, zone extraction gains adaptive slope tolerance based on land value, and the land value formula reduces flatness weight near nuclei.

**Tech Stack:** Vanilla ES modules, vitest. No new dependencies.

**Spec:** `specs/v5/urban-economics-and-connectivity.md` (sections 2 and 3 only; section 1 — street connectivity — is deferred)

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/city/developmentPressure.js` | Compute zone pressure, typology selection, plot width from pressure, ribbon spacing from pressure |
| `test/city/developmentPressure.test.js` | Unit tests for pressure calculation and typology |

### Modified Files

| File | Change |
|---|---|
| `src/city/zoneExtraction.js:4-6,253,271,286-289` | Adaptive slope threshold using land value; add `avgLandValue` to zone metadata |
| `src/core/FeatureMap.js:18,819` | Reduce flatness weight near nucleus (proximity-scaled) |
| `src/city/ribbonLayout.js:46-50` | `ribbonSpacing` takes pressure instead of distance |
| `src/city/strategies/landFirstDevelopment.js:59-108` | Compute pressure per zone; pass to ribbon layout |
| `src/city/placeBuildings.js:299-303,412-509` | Pressure-based plot width with variation; apartment aggregation |
| `src/city/constants.js` | New slope constants: `ZONE_SLOPE_BASE`, `ZONE_SLOPE_LV_BONUS` |

---

## Chunk 1: Adaptive Slope Tolerance

### Task 1: Add adaptive slope constants and update zone extraction

**Files:**
- Modify: `src/city/constants.js`
- Modify: `src/city/zoneExtraction.js:4-6,253,271,286-289`
- Modify: `test/city/zoneExtraction.test.js`

- [ ] **Step 1: Write failing test for adaptive slope threshold**

```js
// append to test/city/zoneExtraction.test.js

// Helper: construct a FeatureMap with manually set grids for isolated testing.
// Bypasses setTerrain()/computeLandValue() to control exact cell values.
function makeZoneTestMap(w, h) {
  const map = new FeatureMap(w, h, 5);
  map.slope = new Grid2D(w, h, { cellSize: 5, fill: 0 });
  map.buildability = new Grid2D(w, h, { cellSize: 5, fill: 0 });
  return map;
}

describe('adaptive slope threshold', () => {
  it('includes high-slope cells when land value is high', () => {
    const map = makeZoneTestMap(20, 20);
    // Slope 0.25 — above old fixed threshold of 0.2
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        map.slope.set(gx, gz, 0.25);
        map.landValue.set(gx, gz, 0.8);
        map.buildability.set(gx, gz, 0.5);
      }
    }
    map.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];

    const zones = extractDevelopmentZones(map);
    // effectiveMax = 0.15 + 0.8 * 0.15 = 0.27 → slope 0.25 included
    expect(zones.length).toBeGreaterThan(0);
  });

  it('excludes high-slope cells when land value is low', () => {
    const map = makeZoneTestMap(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        map.slope.set(gx, gz, 0.25);
        map.landValue.set(gx, gz, 0.31);
        map.buildability.set(gx, gz, 0.5);
      }
    }
    map.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];

    const zones = extractDevelopmentZones(map);
    // effectiveMax = 0.15 + 0.31 * 0.15 = 0.197 → slope 0.25 excluded
    expect(zones.length).toBe(0);
  });

  it('stores avgLandValue on zone metadata', () => {
    const map = makeZoneTestMap(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        map.slope.set(gx, gz, 0.05);
        map.landValue.set(gx, gz, 0.7);
        map.buildability.set(gx, gz, 0.5);
      }
    }
    map.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];

    const zones = extractDevelopmentZones(map);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].avgLandValue).toBeCloseTo(0.7, 1);
  });

  it('steeper zones get lower priority than flat zones of equal land value', () => {
    // Two separate maps to produce zones with different slopes but same LV
    const mapFlat = makeZoneTestMap(20, 20);
    const mapSteep = makeZoneTestMap(20, 20);
    for (let gz = 0; gz < 20; gz++) {
      for (let gx = 0; gx < 20; gx++) {
        mapFlat.slope.set(gx, gz, 0.05);
        mapFlat.landValue.set(gx, gz, 0.7);
        mapFlat.buildability.set(gx, gz, 0.5);

        mapSteep.slope.set(gx, gz, 0.22);
        mapSteep.landValue.set(gx, gz, 0.7);
        mapSteep.buildability.set(gx, gz, 0.5);
      }
    }
    mapFlat.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];
    mapSteep.nuclei = [{ gx: 10, gz: 10, tier: 1, priority: 1 }];

    const flatZones = extractDevelopmentZones(mapFlat);
    const steepZones = extractDevelopmentZones(mapSteep);
    expect(flatZones.length).toBeGreaterThan(0);
    expect(steepZones.length).toBeGreaterThan(0);
    // Steep zone should have lower priority due to grading cost
    expect(steepZones[0].priority).toBeLessThan(flatZones[0].priority);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/zoneExtraction.test.js`
Expected: FAIL — `avgLandValue` is undefined, first test may fail depending on fixed slope threshold

- [ ] **Step 3: Add constants**

In `src/city/constants.js`, add:

```js
// Adaptive slope threshold for zone extraction
export const ZONE_SLOPE_BASE = 0.15;       // minimum slope threshold
export const ZONE_SLOPE_LV_BONUS = 0.15;   // additional tolerance from land value
```

- [ ] **Step 4: Update zone extraction for adaptive slope**

In `src/city/zoneExtraction.js`:

Replace the hardcoded `ZONE_SLOPE_MAX`:
```js
const ZONE_SLOPE_MAX = 0.2;
```

With import and adaptive function:
```js
import { ZONE_SLOPE_BASE, ZONE_SLOPE_LV_BONUS } from './constants.js';

function effectiveSlopeMax(landValue) {
  return ZONE_SLOPE_BASE + landValue * ZONE_SLOPE_LV_BONUS;
}
```

At line 253, replace:
```js
if (map.slope && map.slope.get(gx, gz) >= ZONE_SLOPE_MAX) continue;
```
With:
```js
if (map.slope && map.slope.get(gx, gz) >= effectiveSlopeMax(map.landValue.get(gx, gz))) continue;
```

At line 271, replace:
```js
if (mask.get(gx, gz) === 0 && map.slope && map.slope.get(gx, gz) >= ZONE_SLOPE_MAX) {
```
With:
```js
if (mask.get(gx, gz) === 0 && map.slope && map.slope.get(gx, gz) >= effectiveSlopeMax(map.landValue.get(gx, gz))) {
```

- [ ] **Step 5: Add avgLandValue to zone metadata**

In `src/city/zoneExtraction.js`, at line 286 where zone metadata is computed, `lvSum` is already accumulated. After line 298 (`const avgSlope = ...`), add:

```js
const avgLandValue = lvSum / zone.cells.length;
```

At line 310 where the zone object is assembled, add `avgLandValue` to the spread:

```js
allZones.push({
  ...zone,
  nucleusIdx: ni,
  avgSlope,
  avgLandValue,
  slopeDir,
  totalLandValue: lvSum,
  distFromNucleus,
  priority: lvSum / Math.max(1, distFromNucleus),
  boundary,
});
```

- [ ] **Step 6: Add grading cost to priority**

Before the `allZones.push(...)` call, add a grading cost variable:
```js
const gradingCost = avgSlope > 0.15 ? (avgSlope - 0.15) * 2 : 0;
const priority = (lvSum / Math.max(1, distFromNucleus)) * (1 - gradingCost);
```

Then in the object literal, replace:
```js
priority: lvSum / Math.max(1, distFromNucleus),
```
With:
```js
priority,
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/city/zoneExtraction.test.js`
Expected: PASS (all tests including new adaptive slope tests)

- [ ] **Step 8: Commit**

```bash
git add src/city/constants.js src/city/zoneExtraction.js test/city/zoneExtraction.test.js
git commit -m "Add adaptive slope threshold for zone extraction based on land value"
```

---

### Task 2: Reduce flatness weight near nucleus in land value formula

**Files:**
- Modify: `src/core/FeatureMap.js:18,819`
- Test: `test/core/FeatureMap.test.js`

- [ ] **Step 1: Write failing test**

```js
// append to test/core/FeatureMap.test.js
describe('land value flatness weighting', () => {
  it('sloped cell near nucleus scores higher than sloped cell far away', () => {
    // Two maps with same slope but different nucleus distances
    // Near-nucleus should have reduced flatness weight → higher score
    const map = makeTestMap();
    // The test verifies the relative ordering:
    // a cell at slope=0.2 near the nucleus should have
    // higher land value than before the proximity adjustment
    const nearNucleus = map.nuclei[0];
    const gxNear = nearNucleus.gx;
    const gzNear = nearNucleus.gz + 2; // 2 cells away

    // Set all cells to uniform slope for clean comparison
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        map.slope.set(gx, gz, 0.2);
      }
    }

    map.computeLandValue();

    const nearVal = map.landValue.get(gxNear, gzNear);
    // Far cell — at least 300m from any nucleus
    const gxFar = Math.min(map.width - 5, nearNucleus.gx + 60);
    const gzFar = Math.min(map.height - 5, nearNucleus.gz + 60);
    const farVal = map.landValue.get(gxFar, gzFar);

    // Near-nucleus should still score higher despite slope
    expect(nearVal).toBeGreaterThan(farVal);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/core/FeatureMap.test.js`

This test might already pass since proximity still helps. The real change is making the near-nucleus cell score even higher by reducing flatness penalty.

- [ ] **Step 3: Implement proximity-scaled flatness weight**

In `src/core/FeatureMap.js`, at line 819, replace:
```js
let base = localFlatness * LV_FLATNESS_WEIGHT + proximity * LV_PROXIMITY_WEIGHT;
```
With:
```js
// Reduce flatness weight near nucleus — steep land near center is still prime
const adjustedFlatnessW = LV_FLATNESS_WEIGHT * (1 - proximity * 0.3);
const adjustedProximityW = 1 - adjustedFlatnessW;
let base = localFlatness * adjustedFlatnessW + proximity * adjustedProximityW;
```

At the nucleus (proximity ≈ 1.0): flatness drops from 60% to 42%.
At 200m out (proximity ≈ 0.5): flatness drops from 60% to 51%.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/core/FeatureMap.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/FeatureMap.js test/core/FeatureMap.test.js
git commit -m "Reduce flatness weight near nucleus so sloped central land scores higher"
```

---

## Chunk 2: Development Pressure Model

### Task 3: Create developmentPressure module with pressure calculation and typology

**Files:**
- Create: `src/city/developmentPressure.js`
- Create: `test/city/developmentPressure.test.js`

- [ ] **Step 1: Write failing tests**

```js
// test/city/developmentPressure.test.js
import { describe, it, expect } from 'vitest';
import {
  computePressure,
  typologyForPressure,
  plotWidthForPressure,
  ribbonSpacingForPressure,
} from '../../src/city/developmentPressure.js';

describe('computePressure', () => {
  it('returns high pressure for high land value near nucleus', () => {
    const p = computePressure(0.8, 50);
    expect(p).toBeGreaterThan(0.75);
  });

  it('returns low pressure far from nucleus with low land value', () => {
    const p = computePressure(0.35, 500);
    expect(p).toBeLessThan(0.25);
  });

  it('clamps to [0, 1]', () => {
    expect(computePressure(1.0, 0)).toBeLessThanOrEqual(1);
    expect(computePressure(0, 1000)).toBeGreaterThanOrEqual(0);
  });
});

describe('typologyForPressure', () => {
  it('returns dense-urban for pressure > 0.75', () => {
    const t = typologyForPressure(0.85);
    expect(t.name).toBe('dense-urban');
    expect(t.plotWidth[0]).toBeCloseTo(4.5);
    expect(t.plotWidth[1]).toBeCloseTo(6);
    expect(t.floors[0]).toBeGreaterThanOrEqual(3);
  });

  it('returns mid-density for pressure 0.5-0.75', () => {
    const t = typologyForPressure(0.6);
    expect(t.name).toBe('mid-density');
  });

  it('returns suburban for pressure 0.25-0.5', () => {
    const t = typologyForPressure(0.35);
    expect(t.name).toBe('suburban');
  });

  it('returns rural-edge for pressure < 0.25', () => {
    const t = typologyForPressure(0.1);
    expect(t.name).toBe('rural-edge');
  });
});

describe('plotWidthForPressure', () => {
  it('returns narrower plots for higher pressure', () => {
    const highW = plotWidthForPressure(0.9, 0.5);   // rng param 0-1
    const lowW = plotWidthForPressure(0.2, 0.5);
    expect(highW).toBeLessThan(lowW);
  });

  it('adds variation from rng parameter', () => {
    const w1 = plotWidthForPressure(0.5, 0.0);
    const w2 = plotWidthForPressure(0.5, 1.0);
    expect(w1).not.toBe(w2);
    // Variation should be ±15% of base
    const base = (w1 + w2) / 2;
    expect(Math.abs(w1 - w2)).toBeLessThan(base * 0.35);
  });
});

describe('ribbonSpacingForPressure', () => {
  it('returns tighter spacing for higher pressure', () => {
    expect(ribbonSpacingForPressure(0.9)).toBeLessThan(ribbonSpacingForPressure(0.1));
  });

  it('returns 25 for high pressure', () => {
    expect(ribbonSpacingForPressure(0.85)).toBe(25);
  });

  it('returns 55 for low pressure', () => {
    expect(ribbonSpacingForPressure(0.1)).toBe(55);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/city/developmentPressure.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement developmentPressure module**

```js
// src/city/developmentPressure.js

/**
 * Development pressure model.
 * Maps land value + distance into a 0–1 pressure score that drives
 * building typology, plot width, and street spacing.
 */

/**
 * Compute development pressure for a zone.
 * @param {number} avgLandValue - Mean land value across zone cells (0–1)
 * @param {number} distFromNucleus - Distance from zone centroid to nearest nucleus (meters)
 * @returns {number} Pressure in [0, 1]
 */
export function computePressure(avgLandValue, distFromNucleus) {
  const lvComponent = Math.min(1, Math.max(0, avgLandValue * 1.5)) * 0.6;
  const proxComponent = Math.min(1, Math.max(0, 1 - distFromNucleus / 400)) * 0.4;
  return Math.min(1, Math.max(0, lvComponent + proxComponent));
}

/**
 * Typology bands driven by pressure.
 */
const TYPOLOGIES = [
  { name: 'dense-urban',  minPressure: 0.75, plotWidth: [4.5, 6],  floors: [3, 6], spacing: 25 },
  { name: 'mid-density',  minPressure: 0.5,  plotWidth: [5, 8],    floors: [2, 3], spacing: 35 },
  { name: 'suburban',     minPressure: 0.25, plotWidth: [8, 12],   floors: [2, 2], spacing: 45 },
  { name: 'rural-edge',   minPressure: 0,    plotWidth: [12, 15],  floors: [1, 2], spacing: 55 },
];

/**
 * Get the typology for a given pressure value.
 * @param {number} pressure - 0–1
 * @returns {{ name: string, plotWidth: [number, number], floors: [number, number], spacing: number }}
 */
export function typologyForPressure(pressure) {
  for (const t of TYPOLOGIES) {
    if (pressure >= t.minPressure) return t;
  }
  return TYPOLOGIES[TYPOLOGIES.length - 1];
}

/**
 * Compute plot width with ±15% stochastic variation.
 * @param {number} pressure - 0–1
 * @param {number} rng01 - Random value in [0, 1] for variation
 * @returns {number} Plot width in meters
 */
export function plotWidthForPressure(pressure, rng01) {
  const typo = typologyForPressure(pressure);
  const base = typo.plotWidth[0] + (typo.plotWidth[1] - typo.plotWidth[0]) * 0.5;
  const variation = base * 0.15;
  return base + (rng01 - 0.5) * 2 * variation;
}

/**
 * Ribbon spacing driven by pressure.
 * @param {number} pressure - 0–1
 * @returns {number} Spacing in meters
 */
export function ribbonSpacingForPressure(pressure) {
  const typo = typologyForPressure(pressure);
  return typo.spacing;
}

/**
 * Decide whether a plot should be an apartment block.
 * Only applies in dense-urban zones (pressure > 0.75).
 * Called every 3rd–5th plot; probability scales with pressure.
 *
 * @param {number} pressure - 0–1
 * @param {number} plotIndex - Index along the street
 * @param {number} rng01 - Random value in [0, 1]
 * @returns {boolean}
 */
export function shouldBeApartment(pressure, plotIndex, rng01) {
  if (pressure <= 0.75) return false;
  // Stochastic interval: every 3rd–5th plot (varies by rng)
  const interval = 3 + Math.floor(rng01 * 3); // 3, 4, or 5
  if (plotIndex % interval !== 0 || plotIndex === 0) return false;
  // Probability scales with pressure: (pressure - 0.75) * 4, capped at 0.5
  const prob = Math.min(0.5, (pressure - 0.75) * 4);
  return rng01 < prob;
}

/**
 * Apartment block dimensions.
 * @returns {{ plotWidth: number, plotDepth: number, floors: [number, number] }}
 */
export function apartmentDimensions() {
  return { plotWidth: [15, 20], plotDepth: [12, 15], floors: [4, 6] };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/city/developmentPressure.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/city/developmentPressure.js test/city/developmentPressure.test.js
git commit -m "Add development pressure module with typology, plot width, and spacing"
```

---

## Chunk 3: Wire Pressure Into Pipeline

### Task 4: Wire pressure into ribbon spacing and strategy (atomic)

All three files must be updated together — changing `ribbonSpacing`'s signature without wiring `zone.pressure` would produce wrong spacing values.

**Files:**
- Modify: `src/city/ribbonLayout.js:1-2,46-50,123`
- Modify: `src/city/strategies/landFirstDevelopment.js:1-10,62`
- Modify: `test/city/ribbonLayout.test.js`

- [ ] **Step 1: Update all three files atomically**

**In `src/city/ribbonLayout.js`:**

Add import at the top of the file (near line 1, alongside existing imports):
```js
import { ribbonSpacingForPressure } from './developmentPressure.js';
```

Replace the `ribbonSpacing` function (lines 46-50):
```js
function ribbonSpacing(distFromNucleus) {
  if (distFromNucleus < 100) return 30;
  if (distFromNucleus < 300) return 40;
  return 50;
}
```
With:
```js
function ribbonSpacing(pressure) {
  return ribbonSpacingForPressure(pressure);
}
```

At line 123 (inside `layoutRibbonStreets`), change the call from:
```js
const spacing = ribbonSpacing(zone.distFromNucleus);
```
To:
```js
const spacing = ribbonSpacing(zone.pressure ?? 0.5);
```

**In `src/city/strategies/landFirstDevelopment.js`:**

Add import at the top:
```js
import { computePressure } from '../developmentPressure.js';
```

In `_layoutRibbons()`, at line 62 inside the zone loop, add pressure computation as the first line:
```js
for (const zone of this._zones) {
  // Compute development pressure for this zone
  zone.pressure = computePressure(zone.avgLandValue || 0, zone.distFromNucleus);
```

**In `test/city/ribbonLayout.test.js`:**

Find any test that creates zone fixtures with `distFromNucleus` for spacing tests and add `.pressure` to match:
```js
zone.pressure = 0.8; // high pressure → tight spacing
```

For zones that were testing far-from-nucleus spacing, use low pressure:
```js
zone.pressure = 0.15; // low pressure → wide spacing
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/city/ribbonLayout.test.js test/city/strategies/landFirstDevelopment.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/city/ribbonLayout.js src/city/strategies/landFirstDevelopment.js test/city/ribbonLayout.test.js
git commit -m "Wire development pressure into ribbon spacing"
```

---

### Task 5: Replace plotWidthForDensity with pressure-based plot width and apartment aggregation

**Files:**
- Modify: `src/city/placeBuildings.js:299-303,412-509`
- Modify: `test/city/plotPlacement.test.js`

This is the largest change — the plot placement loop needs to:
1. Use pressure-based width instead of distance-based
2. Add ±15% variation per plot
3. Aggregate some plots into apartment blocks in high-pressure zones

- [ ] **Step 1: Write failing test for pressure-based plot sizing**

```js
// append to test/city/plotPlacement.test.js
import { plotWidthForPressure } from '../../src/city/developmentPressure.js';

describe('pressure-based plot placement', () => {
  it('high-pressure zones produce narrower plots than low-pressure zones', () => {
    const highW = plotWidthForPressure(0.9, 0.5);
    const lowW = plotWidthForPressure(0.2, 0.5);
    expect(highW).toBeLessThan(7);
    expect(lowW).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 2: Replace plotWidthForDensity**

In `src/city/placeBuildings.js`, add import:

```js
import { plotWidthForPressure, shouldBeApartment, apartmentDimensions } from './developmentPressure.js';
```

Delete `plotWidthForDensity` (lines 299-303).

In `computePlotPlacements`, at line 435, replace the fixed plot width:

```js
const plotWidth = plotWidthForDensity(zone.distFromNucleus);
```

With per-plot width inside the house loop. Move the width calculation into the inner loop at line 454. Each plot gets its own width:

```js
// Before the zone loop, compute zone pressure (use stored value or compute)
const pressure = zone.pressure ?? 0.5;
```

Then inside the per-house loop (line 454), replace the fixed `plotWidth` usage:

```js
for (let h = 0; h < houseCount; h++) {
  // Per-plot width with variation
  const hashVal = ((h * 2654435761 + zone.nucleusIdx * 2246822519) >>> 0) / 0xffffffff;
  const plotWidth = plotWidthForPressure(pressure, hashVal);
```

Note: since `plotWidth` is now per-plot, `houseCount` can no longer be pre-calculated from a single width. Instead, walk the street consuming distance:

Replace the outer street loop (lines 440-508) with a distance-walking approach:

```js
for (const street of zone._streets) {
  if (street.length < 2) continue;

  // Compute total street length
  let streetLen = 0;
  for (let i = 1; i < street.length; i++) {
    const dx = street[i].x - street[i - 1].x;
    const dz = street[i].z - street[i - 1].z;
    streetLen += Math.sqrt(dx * dx + dz * dz);
  }
  if (streetLen < 10) continue;

  // Walk along street placing variable-width plots
  let consumed = 0;
  let segIdx = 0, segStart = 0;
  let plotIdx = 0;

  while (consumed < streetLen - 2) {
    // Determine this plot's width
    const hashVal = ((plotIdx * 2654435761 + (zone.nucleusIdx || 0) * 2246822519) >>> 0) / 0xffffffff;
    let pw = plotWidthForPressure(pressure, hashVal);

    // Check for apartment aggregation (separate hash for dimensions to avoid correlation)
    let isApartment = false;
    let pd = plotDepth;
    const aptHash = ((plotIdx * 1911520717 + (zone.nucleusIdx || 0) * 374761393) >>> 0) / 0xffffffff;
    if (shouldBeApartment(pressure, plotIdx, aptHash)) {
      const apt = apartmentDimensions();
      pw = apt.plotWidth[0] + aptHash * (apt.plotWidth[1] - apt.plotWidth[0]);
      pd = Math.min(apt.plotDepth[0] + aptHash * (apt.plotDepth[1] - apt.plotDepth[0]),
                     (spacing / 2) - roadHalfW - 1);
      isApartment = true;
    }

    const targetDist = consumed + pw / 2;
    if (targetDist > streetLen) break;

    // Advance along street segments to target distance
    while (segIdx < street.length - 2) {
      const dx = street[segIdx + 1].x - street[segIdx].x;
      const dz = street[segIdx + 1].z - street[segIdx].z;
      const sLen = Math.sqrt(dx * dx + dz * dz);
      if (segStart + sLen >= targetDist) break;
      segStart += sLen;
      segIdx++;
    }
    if (segIdx >= street.length - 1) break;

    const ax = street[segIdx].x, az = street[segIdx].z;
    const bx = street[segIdx + 1].x, bz = street[segIdx + 1].z;
    const sdx = bx - ax, sdz = bz - az;
    const segLen = Math.sqrt(sdx * sdx + sdz * sdz);
    if (segLen < 0.01) { consumed += pw; plotIdx++; continue; }

    const t = (targetDist - segStart) / segLen;
    const px = ax + sdx * t;
    const pz = az + sdz * t;

    const adx = sdx / segLen;
    const adz = sdz / segLen;

    for (const side of [-1, 1]) {
      const perpX = (-sdz / segLen) * side;
      const perpZ = (sdx / segLen) * side;
      const angle = Math.atan2(perpX, perpZ);

      const roadHalfWidth = 3;
      const sidewalk = 1.5;
      const frontSetback = roadHalfWidth + sidewalk;
      const frontX = px + perpX * frontSetback;
      const frontZ = pz + perpZ * frontSetback;

      const corners = _plotCorners(
        frontX, frontZ, adx, adz, perpX, perpZ, pw, pd
      );
      if (_rectCollides(corners, occupancy, cs, ox, oz)) continue;

      const lx = frontX - ox, lz = frontZ - oz;
      const gx = lx / cs, gz = lz / cs;
      if (gx < 1 || gz < 1 || gx >= map.width - 1 || gz >= map.height - 1) continue;

      _stampRect(corners, occupancy, cs, ox, oz);
      plots.push({ frontX, frontZ, angle, corners, plotWidth: pw, plotDepth: pd, isApartment });
    }

    consumed += pw;
    plotIdx++;
  }
}
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run test/city/plotPlacement.test.js test/city/developmentPressure.test.js`
Expected: PASS — existing bitmap collision tests should still pass since we haven't changed the collision logic, only how widths are chosen.

- [ ] **Step 4: Commit**

```bash
git add src/city/placeBuildings.js test/city/plotPlacement.test.js
git commit -m "Replace distance-based plot width with pressure-driven typology and apartment aggregation"
```

---

### Task 6: Add development pressure debug layer

**Files:**
- Modify: `src/rendering/debugLayers.js`

- [ ] **Step 1: Add pressure heatmap debug layer**

In `src/rendering/debugLayers.js`, add a new layer entry that colors zones by their pressure score (red = high, blue = low):

```js
{
  name: 'Development Pressure',
  render: (ctx, map) => {
    if (!map.developmentZones) return;
    for (const zone of map.developmentZones) {
      const pressure = zone.pressure ?? 0;
      const r = Math.round(pressure * 255);
      const b = Math.round((1 - pressure) * 255);
      ctx.fillStyle = `rgb(${r},0,${b})`;
      for (const c of zone.cells) {
        ctx.fillRect(c.gx, c.gz, 1, 1);
      }
    }
  },
},
```

- [ ] **Step 2: Commit**

```bash
git add src/rendering/debugLayers.js
git commit -m "Add development pressure debug layer"
```

---

### Task 7: Run full test suite and visual check

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Visual regression check**

Run: `npx vite dev` and verify in browser:
- Dense areas near nucleus have narrow plots (4.5–6m), some apartment blocks
- Suburban areas have wider plots (8–12m)
- Rural edges have widest plots (12–15m)
- Sloped areas near the nucleus now develop (previously excluded)
- Street spacing is tighter in dense zones, wider in suburbs
- Development Pressure debug layer shows red near nucleus, blue at edges
- No console errors, no plot overlap issues
